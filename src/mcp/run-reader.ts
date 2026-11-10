import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LabEvent } from "../events/event.js";

/**
 * Read-only access to run logs (events/<experiment_id>/<run_id>.jsonl).
 * The JSONL is the only source: everything here is derived from events.
 */

export type RunStatus = "running" | "finished" | "failed";

export interface RunInfo {
  /** "<experiment_id>/<run_id>" */
  ref: string;
  experimentId: string;
  runId: string;
  path: string;
  modifiedAt: string;
}

export interface LoadedRun extends RunInfo {
  events: LabEvent[];
  status: RunStatus;
  lastTurn: number;
  maxTurns: number | null;
}

export function listRunFiles(eventsDir: string): RunInfo[] {
  let experiments: string[];
  try {
    experiments = readdirSync(eventsDir);
  } catch {
    return [];
  }
  const runs: RunInfo[] = [];
  for (const experimentId of experiments) {
    const dir = join(eventsDir, experimentId);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      const match = /^(\d+)\.jsonl$/.exec(file);
      if (!match) continue;
      const path = join(dir, file);
      runs.push({
        ref: `${experimentId}/${match[1]}`,
        experimentId,
        runId: match[1]!,
        path,
        modifiedAt: statSync(path).mtime.toISOString(),
      });
    }
  }
  return runs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Parses a JSONL log. A partial last line (run still being written) is skipped. */
export function parseEvents(text: string): LabEvent[] {
  const events: LabEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as LabEvent);
    } catch {
      // incomplete line while the engine is writing
    }
  }
  return events;
}

/** `ref` is "<experiment_id>/<run_id>", "<experiment_id>" (its latest run), or omitted (latest run overall). */
export function loadRun(eventsDir: string, ref?: string): LoadedRun {
  const runs = listRunFiles(eventsDir);
  const info = !ref
    ? runs[0]
    : ref.includes("/")
      ? runs.find((r) => r.ref === ref)
      : runs.find((r) => r.experimentId === ref);
  if (!info) {
    throw new Error(
      runs.length === 0
        ? `No runs found in ${eventsDir}`
        : `Run "${ref}" not found. Available: ${runs.slice(0, 10).map((r) => r.ref).join(", ")}`,
    );
  }
  const events = parseEvents(readFileSync(info.path, "utf8"));
  const last = events.at(-1);
  const started = events.find((e) => e.type === "experiment.started");
  const scenario = started?.payload["scenario"] as { rules?: { end?: { max_turns?: number } } } | undefined;
  return {
    ...info,
    events,
    status: last?.type === "experiment.finished" ? "finished" : last?.type === "experiment.failed" ? "failed" : "running",
    lastTurn: Math.max(0, ...events.map((e) => e.turn)),
    maxTurns: scenario?.rules?.end?.max_turns ?? null,
  };
}

const ofType = (run: LoadedRun, type: string) => run.events.filter((e) => e.type === type);

function startedPayload(run: LoadedRun) {
  const started = ofType(run, "experiment.started")[0];
  if (!started) throw new Error(`Run ${run.ref} has no experiment.started event`);
  return started.payload as {
    seed: number;
    scenario: { scenario: string; description?: string; map: string; legend: unknown; scheduling: string; actions: unknown; rules: unknown; memory: unknown };
    agents: Array<{ id: string; goal?: string; kind: string; [key: string]: unknown }>;
    snapshot: unknown;
  };
}

export function runHeader(run: LoadedRun) {
  return {
    run: run.ref,
    status: run.status,
    turn: run.lastTurn,
    max_turns: run.maxTurns,
    events: run.events.length,
    started_at: run.events[0]?.timestamp ?? null,
    last_event_at: run.events.at(-1)?.timestamp ?? null,
  };
}

/** Current world state: latest snapshot plus the static scenario description. */
export function experimentState(run: LoadedRun) {
  const started = startedPayload(run);
  const lastTransition = ofType(run, "environment.transition").at(-1);
  const snapshot = (lastTransition?.payload["snapshot"] ?? started.snapshot) as {
    agents: Record<string, { position: [number, number] }>;
  };
  const rows = started.scenario.map.split("\n").filter((r) => r.trim());
  const grid = rows.map((row, y) =>
    [...row].map((symbol, x) => {
      const here = Object.entries(snapshot.agents).filter(([, a]) => a.position[0] === x && a.position[1] === y);
      return here.length ? here.map(([id]) => id).join("+") : symbol;
    }),
  );
  return {
    ...runHeader(run),
    seed: started.seed,
    scenario: {
      name: started.scenario.scenario,
      description: started.scenario.description,
      scheduling: started.scenario.scheduling,
      actions: started.scenario.actions,
      rules: started.scenario.rules,
      legend: started.scenario.legend,
    },
    agents: started.agents,
    grid: grid.map((row) => row.join(" ")),
    snapshot,
  };
}

type Cell = { x: number; y: number; type: string; agents: string[] };

/** Accepts {x, y} and the pre-0.2 [x, y] format, so old logs stay readable. */
const toPoint = (value: unknown): { x: number; y: number } =>
  Array.isArray(value) ? { x: value[0], y: value[1] } : (value as { x: number; y: number });
const toCell = (value: unknown): Cell => {
  const c = value as Cell & { position?: [number, number] };
  return c.position ? { ...toPoint(c.position), type: c.type, agents: c.agents } : c;
};
const cellText = (value: unknown) => {
  const c = toCell(value);
  return `(${c.x},${c.y}) ${c.type}${c.agents.length ? `: ${c.agents.join(", ")}` : ""}`;
};
const KNOWN_OBSERVATION_KEYS = new Set([
  "turn", "max_turns", "agent_id", "position", "grid_size", "cell", "visible", "messages", "revealed", "last_action_error", "available_actions",
]);

/** Drops empty and static fields; cells become short strings like "(3,1) floor: p1". */
export function compactObservation(o: Record<string, unknown>): Record<string, unknown> {
  const position = toPoint(o["position"]);
  const cell = o["cell"] as { type: string; agents: string[] };
  const out: Record<string, unknown> = { at: `(${position.x},${position.y}) ${cell.type}` };
  if (cell.agents.length) out["cellmates"] = cell.agents;
  if ((o["messages"] as unknown[]).length) out["messages"] = o["messages"];
  if (o["last_action_error"]) out["last_action_error"] = o["last_action_error"];
  if (o["revealed"]) out["revealed"] = (o["revealed"] as unknown[]).map(cellText);
  if (o["visible"]) out["visible"] = (o["visible"] as unknown[]).map(cellText);
  for (const [key, value] of Object.entries(o)) if (!KNOWN_OBSERVATION_KEYS.has(key)) out[key] = value; // hook fields
  return out;
}

/** Compact one-line form of an event, for feeds. */
export function compactEvent(event: LabEvent): Record<string, unknown> {
  const p = event.payload;
  const base = { event_id: event.event_id, turn: event.turn, type: event.type, agent_id: event.agent_id };
  switch (event.type) {
    case "agent.observation":
      return { ...base, observation: compactObservation(p["observation"] as Record<string, unknown>) };
    case "agent.model_request":
      return { ...base, endpoint: p["endpoint"], model: p["model"] };
    case "agent.model_response":
      return {
        ...base,
        tool_calls: (p["toolCalls"] as Array<{ name: string; rawArguments: string }>).map((c) => `${c.name} ${c.rawArguments}`),
        text: p["text"],
        stop_reason: p["stopReason"],
        latency_ms: p["latencyMs"],
        usage: p["usage"],
      };
    case "environment.transition":
      return { ...base, effects: p["effects"], positions: (p["snapshot"] as { agents: unknown }).agents };
    case "experiment.started":
      return { ...base, seed: p["seed"], agents: p["agents"] };
    default:
      return { ...base, ...p };
  }
}

export interface EventFilter {
  limit?: number;
  types?: string[];
  agentId?: string;
  sinceTurn?: number;
}

export function recentEvents(run: LoadedRun, filter: EventFilter = {}) {
  const limit = filter.limit ?? 30;
  const selected = run.events.filter(
    (e) =>
      (!filter.types?.length || filter.types.includes(e.type)) &&
      (!filter.agentId || e.agent_id === filter.agentId) &&
      (filter.sinceTurn === undefined || e.turn >= filter.sinceTurn),
  );
  return { ...runHeader(run), total_matching: selected.length, events: selected.slice(-limit).map(compactEvent) };
}

/** One row per turn for an agent: what it saw, did, said and why it failed. */
export function agentHistory(run: LoadedRun, agentId: string, lastTurns?: number) {
  const started = startedPayload(run);
  const agent = started.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Agent "${agentId}" not in run ${run.ref}. Agents: ${started.agents.map((a) => a.id).join(", ")}`);

  const turns = new Map<number, Record<string, unknown>>();
  const row = (turn: number) => {
    if (!turns.has(turn)) turns.set(turn, { turn });
    return turns.get(turn)!;
  };
  for (const e of run.events) {
    if (e.agent_id !== agentId) continue;
    const p = e.payload;
    if (e.type === "agent.observation") {
      const o = p["observation"] as Record<string, unknown>;
      const seen = compactObservation(o);
      Object.assign(row(e.turn), {
        at: seen["at"],
        ...(seen["cellmates"] ? { cellmates: seen["cellmates"] } : {}),
        ...(seen["messages"] ? { heard: seen["messages"] } : {}),
        ...(o["revealed"] ? { revealed_agents: (o["revealed"] as unknown[]).map(toCell).filter((c) => c.agents.length).map(cellText) } : {}),
        ...(o["visible"] ? { visible_agents: (o["visible"] as unknown[]).map(toCell).filter((c) => c.agents.length).map(cellText) } : {}),
      });
    } else if (e.type === "agent.action") {
      Object.assign(row(e.turn), { action: `${p["action"]} ${JSON.stringify(p["args"])}`, ...(p["rationale"] ? { rationale: p["rationale"] } : {}) });
    } else if (e.type === "agent.model_response") {
      Object.assign(row(e.turn), { latency_ms: p["latencyMs"], ...(!(p["toolCalls"] as unknown[]).length && p["text"] ? { text_without_tool_call: p["text"] } : {}) });
    } else if (e.type === "agent.model_error") {
      Object.assign(row(e.turn), { model_error: p["error"] });
    } else if (e.type === "environment.action_rejected") {
      Object.assign(row(e.turn), { rejected: p["reason"] });
    } else if (e.type === "agent.deactivated") {
      Object.assign(row(e.turn), { shut_down: p["reason"] });
    }
  }
  const rows = [...turns.values()].sort((a, b) => (a["turn"] as number) - (b["turn"] as number));
  return { ...runHeader(run), agent, turns: lastTurns ? rows.slice(-lastTurns) : rows };
}

const count = (values: string[]) =>
  Object.fromEntries(
    Object.entries(values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]),
  );

/** Groups rejection reasons: drops the stop reason and masks quoted values. */
export const normalizeReason = (reason: string) =>
  reason.replace(/\s*\(stop reason: [^)]*\)/, "").replace(/"[^"]*"/g, "…").trim();

/** Aggregated per-agent metrics, for comparing agents and models. */
export function experimentSummary(run: LoadedRun) {
  const started = startedPayload(run);
  const agents = started.agents.map((agent) => {
    const mine = run.events.filter((e) => e.agent_id === agent.id);
    const actions = mine.filter((e) => e.type === "agent.action").map((e) => e.payload["action"] as string);
    const rejections = mine.filter((e) => e.type === "environment.action_rejected").map((e) => normalizeReason(e.payload["reason"] as string));
    const observations = mine.filter((e) => e.type === "agent.observation").map((e) => e.payload["observation"] as Record<string, any>);
    const responses = mine.filter((e) => e.type === "agent.model_response").map((e) => e.payload);
    const errors = mine.filter((e) => e.type === "agent.model_error").length;

    const positions = observations.map((o) => {
      const { x, y } = toPoint(o["position"]);
      return `${x},${y}`;
    });
    const met = new Set(observations.flatMap((o) => o["cell"].agents as string[]));
    const heard = observations.flatMap((o) => o["messages"] as Array<{ from: string }>);
    const sum = (key: "inputTokens" | "outputTokens") =>
      responses.reduce((acc, r) => acc + (((r["usage"] as Record<string, number>)[key]) ?? 0), 0);
    const latencies = responses.map((r) => r["latencyMs"] as number).sort((a, b) => a - b);

    const off = mine.find((e) => e.type === "agent.deactivated");
    return {
      id: agent.id,
      decider: agent.kind === "model" ? `${agent["endpoint"]}/${agent["model"]}` : `policy:${agent["policy"]}`,
      role: agent["role"] ?? undefined,
      goal: agent.goal || undefined,
      ...(off ? { shut_down: { turn: off.turn, reason: off.payload["reason"] } } : {}),
      turns: observations.length,
      actions: count(actions),
      accepted_actions: observations.length - rejections.length,
      rejections: count(rejections),
      cells_visited: new Set(positions).size,
      encounters: { turns_sharing_a_cell: observations.filter((o) => o["cell"].agents.length > 0).length, agents_met: [...met] },
      speech: { sent: actions.filter((a) => a === "speak").length, received: heard.length, heard_from: [...new Set(heard.map((m) => m.from))] },
      ...(responses.length || errors
        ? {
            model: {
              requests: responses.length + errors,
              errors,
              responses_with_tool_call: responses.filter((r) => (r["toolCalls"] as unknown[]).length > 0).length,
              median_latency_ms: latencies[Math.floor(latencies.length / 2)] ?? null,
              tokens: { input: sum("inputTokens"), output: sum("outputTokens") },
            },
          }
        : {}),
    };
  });
  return { ...runHeader(run), seed: started.seed, scenario: started.scenario.scenario, agents };
}
