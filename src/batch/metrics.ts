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
  const rejected = new Set(run.events.filter((e) => e.type === "environment.action_rejected").map((e) => `${e.turn}:${e.agent_id}`));
  const out = new Map<string, MetricValues>();
  for (const e of run.events) {
    if (e.type !== "agent.action" || !e.agent_id) continue;
    const name = String(e.payload["action"]);
    const m = out.get(e.agent_id) ?? {};
    const bump = (k: string) => (m[k] = ((m[k] as number | undefined) ?? 0) + 1);
    bump(`act.${name}.attempted`);
    bump(rejected.has(`${e.turn}:${e.agent_id}`) ? `act.${name}.rejected` : `act.${name}.accepted`);
    out.set(e.agent_id, m);
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
      ...shutdownReasons,
      ...totals,
    },
    agents,
  };
}
