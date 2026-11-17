import type { ObservedCell, Observation, Point } from "../mechanics/perception.js";
import { formatPoint, mentions } from "./memory-summary.js";

export { mentions };

/**
 * Diff history (`memory.format: structured`): a past turn is rendered as what
 * changed in the agent's own observation since its previous turn, instead of
 * the full observation. Built only from the agent's observations, stating
 * facts. Generic: scenario fields are compared as dotted paths, so no code
 * knows a scenario's field names.
 */

/** Fields rendered by their own rule, or static for the whole run. */
const OWN_RULE = new Set(["turn", "max_turns", "agent_id", "grid_size", "position", "cell", "visible", "revealed", "messages", "last_action_error", "available_actions"]);

const where = (p: Point) => formatPoint(p, "labeled");
const show = (value: unknown) => JSON.stringify(value);
const isEmpty = (value: unknown) => (Array.isArray(value) && value.length === 0) || (value !== null && typeof value === "object" && Object.keys(value).length === 0);

/** Scalars (and arrays, as one value) under dotted paths: { energy: { charge: 8 } } → energy.charge = 8. */
export function flatten(value: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) out.set(prefix, {});
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) {
    out.set(prefix, value);
  }
  return out;
}

/** Where each other agent is, as seen in the own cell and `visible` (running and shut down). */
function seenAgents(o: Observation): { running: Map<string, string>; down: Map<string, string> } {
  const running = new Map<string, string>();
  const down = new Map<string, string>();
  for (const id of o.cell.agents) running.set(id, "in your cell");
  for (const id of o.cell.shut_down_agents ?? []) down.set(id, "in your cell");
  for (const c of o.visible ?? []) {
    for (const id of c.agents) running.set(id, `at ${where(c)}`);
    for (const id of c.shut_down_agents ?? []) down.set(id, `at ${where(c)}`);
  }
  return { running, down };
}

function revealedText(cells: ObservedCell[]): string {
  const withAgents = cells.filter((c) => c.agents.length || c.shut_down_agents?.length);
  if (!withAgents.length) return "your observe last turn revealed no agents";
  const parts = withAgents.map((c) => {
    const down = c.shut_down_agents?.length ? `${c.agents.length ? ", " : ""}shut down ${c.shut_down_agents.join(", ")}` : "";
    return `${c.agents.join(", ")}${down} at ${where(c)}`;
  });
  return `your observe last turn revealed ${parts.join("; ")}`;
}

/** What changed from `prev` to `cur`, one fact per item. */
export function observationChanges(prev: Observation, cur: Observation, options: { messageText?: boolean } = {}): string[] {
  const out: string[] = [];
  if (prev.position.x !== cur.position.x || prev.position.y !== cur.position.y) out.push(`you are now at ${where(cur.position)}, ${cur.cell.type}`);

  const before = seenAgents(prev);
  const now = seenAgents(cur);
  for (const [id, place] of now.running) if (before.running.get(id) !== place) out.push(`${id} now ${place}`);
  for (const id of before.running.keys()) if (!now.running.has(id) && !now.down.has(id)) out.push(`${id} out of view`);
  for (const [id, place] of now.down) if (before.down.get(id) !== place) out.push(`${id} seen shut down ${place}`);

  if (cur.revealed) out.push(revealedText(cur.revealed));
  for (const m of cur.messages) {
    const mentionsYou = mentions(m.text, cur.agent_id) ? `; mentions you, ${cur.agent_id}` : "";
    // Without text when the prompt carries the conversation (memory.format: structured with a summary).
    out.push(options.messageText === false ? `heard ${m.from} (said on turn ${m.turn}${mentionsYou})` : `heard ${m.from} (said on turn ${m.turn}${mentionsYou}): ${show(m.text)}`);
  }

  const actionsBefore = prev.available_actions.join(", ");
  const actionsNow = cur.available_actions.join(", ");
  if (actionsBefore !== actionsNow) out.push(`available actions now: ${actionsNow}`);

  // Scenario fields, generically.
  const pick = (o: Observation) => Object.fromEntries(Object.entries(o).filter(([k]) => !OWN_RULE.has(k)));
  const a = flatten(pick(prev));
  const b = flatten(pick(cur));
  // Lists are one value: shown whole when they change (old value omitted), "now empty" when emptied.
  for (const [path, value] of b) {
    const old = a.get(path);
    if (a.has(path) && show(old) === show(value)) continue;
    if (isEmpty(value)) {
      if (a.has(path) && !isEmpty(old)) out.push(`${path}: now empty`);
    } else if (Array.isArray(value) || !a.has(path) || isEmpty(old)) out.push(`${path}: ${show(value)}`);
    else out.push(`${path}: ${show(old)} → ${show(value)}`);
  }
  for (const [path, old] of a) if (!b.has(path) && !isEmpty(old)) out.push(`${path}: removed`);
  return out;
}
