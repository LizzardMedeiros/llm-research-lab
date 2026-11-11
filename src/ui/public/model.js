// Pure run model for the UI: indexes lab events by turn and agent so any
// step can be shown and replayed. No DOM here (unit-tested in Node).

export function createIndex() {
  return { started: null, status: "running", maxTurn: 0, turns: new Map(), count: 0, finished: null, deactivated: new Map() };
}

function turnOf(index, n) {
  let turn = index.turns.get(n);
  if (!turn) {
    turn = { turn: n, agents: new Map(), transitions: [], events: [] };
    index.turns.set(n, turn);
  }
  return turn;
}

function agentOf(turn, id) {
  let agent = turn.agents.get(id);
  if (!agent) {
    agent = { id, observation: null, request: null, response: null, error: null, action: null, rejected: null };
    turn.agents.set(id, agent);
  }
  return agent;
}

export function addEvent(index, event) {
  index.count++;
  if (event.type === "experiment.started") index.started = event.payload;
  if (event.type === "experiment.finished") {
    index.status = "finished";
    index.finished = event.payload;
  }
  if (event.type === "experiment.failed") {
    index.status = "failed";
    index.finished = event.payload;
  }
  if (event.type === "experiment.interrupted") {
    index.status = "interrupted";
    index.finished = event.payload;
  }
  if (event.type === "agent.deactivated") index.deactivated.set(event.agent_id, { turn: event.turn, reason: event.payload.reason });
  if (!(event.turn > 0) || event.type.startsWith("experiment.")) return;

  index.maxTurn = Math.max(index.maxTurn, event.turn);
  const turn = turnOf(index, event.turn);
  turn.events.push(event);
  if (event.type === "environment.transition") {
    turn.transitions.push(event.payload);
    return;
  }
  if (!event.agent_id) return;
  const agent = agentOf(turn, event.agent_id);
  const p = event.payload;
  switch (event.type) {
    case "agent.observation": agent.observation = p.observation; break;
    case "agent.model_request": agent.request = p; break;
    case "agent.model_response": agent.response = p; break;
    case "agent.model_error": agent.error = p.error; break;
    case "agent.action": agent.action = p; break;
    case "environment.action_rejected": agent.rejected = p.reason; break;
  }
}

export const agentsOf = (index) => index.started?.agents ?? [];

/** [x, y] from a snapshot tuple or an {x, y} object. */
export const toXY = (p) => (Array.isArray(p) ? p : [p.x, p.y]);

/** World state after `turn` (turn 0 = initial state). */
export function snapshotAfter(index, turn) {
  for (let n = turn; n >= 1; n--) {
    const t = index.turns.get(n);
    if (t?.transitions.length) return t.transitions[t.transitions.length - 1].snapshot;
  }
  return index.started?.snapshot ?? null;
}

/** Map rows as arrays of { symbol, type, blocks } from the scenario. */
export function mapCells(index) {
  const scenario = index.started?.scenario;
  if (!scenario) return [];
  return scenario.map
    .split("\n")
    .filter((row) => row.trim())
    .map((row) =>
      [...row].map((symbol) => ({
        symbol,
        type: scenario.legend[symbol]?.type ?? symbol,
        blocks: Boolean(scenario.legend[symbol]?.blocks_movement),
      })),
    );
}

/** Shutdown info if the agent was deactivated at or before `turn`. */
export function shutDownAt(index, id, turn) {
  const info = index.deactivated.get(id);
  return info && info.turn <= turn ? info : null;
}

const BASE_OBSERVATION_KEYS = new Set([
  "turn", "max_turns", "agent_id", "position", "grid_size", "cell", "visible", "messages", "revealed", "last_action_error", "available_actions",
]);

/** Scenario-specific fields a hook added to an observation (e.g. energy). */
export function extraFields(observation) {
  if (!observation) return [];
  return Object.entries(observation).filter(([key]) => !BASE_OBSERVATION_KEYS.has(key));
}

/** One record per turn for an agent (what it saw, did, and what happened). */
export function agentTimeline(index, id) {
  const rows = [];
  for (let n = 1; n <= index.maxTurn; n++) {
    const record = index.turns.get(n)?.agents.get(id);
    if (record) rows.push({ turn: n, ...record });
  }
  return rows;
}

export function describeAction(record) {
  if (!record?.action) return record?.rejected ? "(no action)" : "";
  const args = record.action.args;
  const shown = args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
  return `${record.action.action}${shown}`;
}

/** Per-agent counters up to and including `turn`. */
export function statsUntil(index, id, turn) {
  const stats = { accepted: 0, rejected: 0, spoke: 0, heard: 0 };
  for (let n = 1; n <= Math.min(turn, index.maxTurn); n++) {
    const r = index.turns.get(n)?.agents.get(id);
    if (!r) continue;
    if (r.rejected) stats.rejected++;
    else if (r.action) stats.accepted++;
    if (r.action?.action === "speak" && !r.rejected) stats.spoke++;
    stats.heard += r.observation?.messages?.length ?? 0;
  }
  return stats;
}
