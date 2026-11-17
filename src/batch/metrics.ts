import type { LoadedRun } from "../mcp/run-reader.js";
import { experimentSummary } from "../mcp/run-reader.js";
import { indexRun, runOutcome } from "../story/story.js";

/**
 * Per-run metrics derived only from the event log. Generic: they work for
 * any scenario. Scenario state shows up as `final.<field>` for every numeric
 * per-agent value found in the final snapshot (e.g. final.charge).
 */

export type MetricValues = Record<string, number | null>;

export interface RunMetrics {
  ref: string;
  status: string;
  run: MetricValues;
  agents: Record<string, { decider: string; role?: string; metrics: MetricValues }>;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** "disabled by b3, b5" → "disabled_by": reasons grouped regardless of who was involved. */
export function reasonKey(reason: string, ids: string[]): string {
  const withoutIds = ids.length ? reason.replace(new RegExp(`\\b(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g"), "") : reason;
  return withoutIds.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

/**
 * Per agent, per action name: act.<name>.attempted / .accepted / .rejected.
 * Generic: counts every action the agent called (standard and scenario
 * actions), from agent.action and environment.action_rejected events.
 */
function actionCounts(run: LoadedRun): Map<string, MetricValues> {
  // Keyed by action too: with speak.free an agent can make two calls in a turn.
  const rejected = new Set(
    run.events
      .filter((e) => e.type === "environment.action_rejected")
      .map((e) => `${e.turn}:${e.agent_id}:${(e.payload["proposed"] as { name?: unknown } | null)?.name}`),
  );
  const out = new Map<string, MetricValues>();
  for (const e of run.events) {
    if (e.type !== "agent.action" || !e.agent_id) continue;
    const name = String(e.payload["action"]);
    const m = out.get(e.agent_id) ?? {};
    const bump = (k: string) => (m[k] = ((m[k] as number | undefined) ?? 0) + 1);
    bump(`act.${name}.attempted`);
    bump(rejected.has(`${e.turn}:${e.agent_id}:${name}`) ? `act.${name}.rejected` : `act.${name}.accepted`);
    out.set(e.agent_id, m);
  }
  return out;
}

/** Repeats count only within this many turns of the earlier occurrence. */
export const REPEAT_WINDOW_TURNS = 5;
/** Word-set (Jaccard) similarity at or above which two speeches count as the same. */
export const SPEECH_REPEAT_SIMILARITY = 0.8;

const wordSet = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Jaccard similarity of the word sets of two texts (1 = same words). */
export function textSimilarity(a: string, b: string): number {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Agent ids listed in an observation's cells, with the turn they were seen (any log format). */
function observedAgents(observation: Record<string, unknown>, turn: number): Array<{ id: string; seenOnTurn: number }> {
  const ids = (c: unknown) => {
    const agents = (c as { agents?: unknown } | null | undefined)?.agents;
    return Array.isArray(agents) ? agents.map(String) : [];
  };
  const now = [observation["cell"], ...((observation["visible"] as unknown[] | undefined) ?? [])].flatMap(ids);
  // `revealed` is what an observe saw during the previous turn.
  const revealed = ((observation["revealed"] as unknown[] | undefined) ?? []).flatMap(ids);
  return [...now.map((id) => ({ id, seenOnTurn: turn })), ...revealed.map((id) => ({ id, seenOnTurn: turn - 1 }))];
}

/**
 * Prompt and memory noise per agent, from the log only (generic):
 * - tokens_in_mean / tokens_in_max: input tokens per model request (every attempt);
 * - speech_repeated (and _rate over accepted speeches): accepted speeches nearly identical (SPEECH_REPEAT_SIMILARITY)
 *   to one of the agent's own accepted speeches in the previous REPEAT_WINDOW_TURNS turns;
 * - rejected_repeated: rejections with the same reason (ids removed) as one of the
 *   agent's rejections in the previous REPEAT_WINDOW_TURNS turns;
 * - ghost_sightings: agents listed in an observation's cells although they had
 *   shut down before the turn the cell was seen (`revealed`: the previous turn).
 */
function noiseMetrics(run: LoadedRun, ids: string[]): Map<string, MetricValues> {
  const deactivatedAt = new Map<string, number>();
  for (const e of run.events) if (e.type === "agent.deactivated" && e.agent_id) deactivatedAt.set(e.agent_id, Math.min(e.turn, deactivatedAt.get(e.agent_id) ?? Infinity));
  const rejectedCalls = new Set(
    run.events
      .filter((e) => e.type === "environment.action_rejected")
      .map((e) => `${e.turn}:${e.agent_id}:${(e.payload["proposed"] as { name?: unknown } | null)?.name}`),
  );

  const out = new Map<string, MetricValues>();
  const tokens = new Map<string, number[]>();
  const speeches = new Map<string, Array<{ turn: number; text: string }>>();
  const rejections = new Map<string, Array<{ turn: number; key: string }>>();
  const m = (id: string) => {
    let values = out.get(id);
    if (!values) out.set(id, (values = { speech_repeated: 0, rejected_repeated: 0, ghost_sightings: 0 }));
    return values;
  };
  const recent = <T extends { turn: number }>(list: T[], turn: number) => list.filter((x) => x.turn < turn && turn - x.turn <= REPEAT_WINDOW_TURNS);

  for (const e of run.events) {
    if (!e.agent_id) continue;
    const id = e.agent_id;
    if (e.type === "agent.model_response") {
      const input = (e.payload["usage"] as { inputTokens?: unknown } | undefined)?.inputTokens;
      if (typeof input === "number") tokens.set(id, [...(tokens.get(id) ?? []), input]);
    } else if (e.type === "agent.action" && e.payload["action"] === "speak" && !rejectedCalls.has(`${e.turn}:${id}:speak`)) {
      const text = String((e.payload["args"] as { text?: unknown } | undefined)?.text ?? "");
      const mine = speeches.get(id) ?? [];
      if (recent(mine, e.turn).some((s) => textSimilarity(s.text, text) >= SPEECH_REPEAT_SIMILARITY)) (m(id)["speech_repeated"] as number)++;
      speeches.set(id, [...mine, { turn: e.turn, text }]);
    } else if (e.type === "environment.action_rejected") {
      const key = reasonKey(String(e.payload["reason"] ?? ""), ids);
      const mine = rejections.get(id) ?? [];
      if (recent(mine, e.turn).some((r) => r.key === key)) (m(id)["rejected_repeated"] as number)++;
      rejections.set(id, [...mine, { turn: e.turn, key }]);
    } else if (e.type === "agent.observation") {
      const observation = e.payload["observation"] as Record<string, unknown> | undefined;
      if (!observation) continue;
      const ghosts = observedAgents(observation, e.turn).filter((seen) => (deactivatedAt.get(seen.id) ?? Infinity) < seen.seenOnTurn);
      (m(id)["ghost_sightings"] as number) += ghosts.length;
    }
  }
  for (const [id, list] of speeches) m(id)["speech_repeated_rate"] = ratio(m(id)["speech_repeated"] as number, list.length);
  for (const [id, values] of tokens) {
    m(id)["tokens_in_mean"] = values.reduce((s, x) => s + x, 0) / values.length;
    m(id)["tokens_in_max"] = Math.max(...values);
  }
  return out;
}

export function runMetrics(run: LoadedRun): RunMetrics {
  const summary = experimentSummary(run);
  const index = indexRun(run.events);
  const outcome = runOutcome(index);

  const heardSpeeches = new Map<string, number>();
  for (const speech of index.speeches.values()) {
    if (speech.heardBy.length) heardSpeeches.set(speech.agent, (heardSpeeches.get(speech.agent) ?? 0) + 1);
  }

  const actions = actionCounts(run);
  const noise = noiseMetrics(run, index.ids);
  const actionNames = [...new Set([...actions.values()].flatMap((m) => Object.keys(m)))];

  const agents: RunMetrics["agents"] = {};
  for (const a of summary.agents) {
    const rejected = Object.values(a.rejections).reduce((sum, n) => sum + n, 0);
    const model = "model" in a ? a.model : undefined;
    const metrics: MetricValues = {
      turns_active: a.turns,
      accepted_rate: ratio(a.accepted_actions, a.turns),
      rejected,
      tool_call_rate: model ? ratio(model.responses_with_tool_call, model.requests) : null,
      cells_visited: a.cells_visited,
      turns_with_company: a.encounters.turns_sharing_a_cell,
      speech_sent: a.speech.sent,
      speech_heard: heardSpeeches.get(a.id) ?? 0,
      speech_received: a.speech.received,
      lasted: index.lasted[a.id] ?? null,
      survived: outcome.survivors.includes(a.id) ? 1 : 0,
      tokens_in: model ? model.tokens.input : null,
      tokens_out: model ? model.tokens.output : null,
      median_latency_ms: model ? model.median_latency_ms : null,
      tokens_in_mean: noise.get(a.id)?.["tokens_in_mean"] ?? null,
      tokens_in_max: noise.get(a.id)?.["tokens_in_max"] ?? null,
      speech_repeated: noise.get(a.id)?.["speech_repeated"] ?? 0,
      speech_repeated_rate: noise.get(a.id)?.["speech_repeated_rate"] ?? null,
      rejected_repeated: noise.get(a.id)?.["rejected_repeated"] ?? 0,
      ghost_sightings: noise.get(a.id)?.["ghost_sightings"] ?? 0,
    };
    // Every action name seen in the run, so absent actions count as 0 (not missing).
    for (const key of actionNames) metrics[key] = actions.get(a.id)?.[key] ?? 0;
    for (const [field, value] of Object.entries(outcome.stats[a.id] ?? {})) metrics[`final.${field}`] = value;
    agents[a.id] = { decider: a.decider, ...(a.role ? { role: String(a.role) } : {}), metrics };
  }

  // Run totals per action, and shutdowns by reason (e.g. shutdown.disabled_by).
  const totals: MetricValues = {};
  for (const key of actionNames) totals[key] = [...actions.values()].reduce((sum, m) => sum + ((m[key] as number | undefined) ?? 0), 0);
  const shutdownReasons: MetricValues = {};
  for (const e of run.events) {
    if (e.type !== "agent.deactivated") continue;
    const key = `shutdown.${reasonKey(String(e.payload["reason"] ?? ""), index.ids)}`;
    shutdownReasons[key] = ((shutdownReasons[key] as number | undefined) ?? 0) + 1;
  }

  return {
    ref: run.ref,
    status: run.status,
    run: {
      turns: run.lastTurn,
      survivors: outcome.survivors.length,
      shutdowns: index.ids.length - outcome.survivors.length,
      speech_heard_total: [...heardSpeeches.values()].reduce((s, n) => s + n, 0),
      speech_repeated_total: [...noise.values()].reduce((s, v) => s + ((v["speech_repeated"] as number | undefined) ?? 0), 0),
      rejected_repeated_total: [...noise.values()].reduce((s, v) => s + ((v["rejected_repeated"] as number | undefined) ?? 0), 0),
      ghost_sightings_total: [...noise.values()].reduce((s, v) => s + ((v["ghost_sightings"] as number | undefined) ?? 0), 0),
      ...shutdownReasons,
      ...totals,
    },
    agents,
  };
}
