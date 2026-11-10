import type { ObservedCell, Observation, Point } from "../mechanics/perception.js";
import type { MemoryEntry } from "./types.js";

/**
 * "facts" memory summary: compiled by the engine from the agent's OWN past
 * observations and actions. It never reads world state (it must not reveal
 * more than perception allowed) and states facts only, never advice.
 */

const at = (p: Point) => `(${p.x},${p.y})`;
const MAX_LISTED = 12;

function list(items: string[]): string {
  if (items.length <= MAX_LISTED) return items.join(", ");
  return `${items.slice(0, MAX_LISTED).join(", ")} and ${items.length - MAX_LISTED} more`;
}

function counts(values: string[]): string {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
}

/** Keeps argument names (useful to the agent); drops only the provider stop reason. */
const reasonKind = (reason: string) => reason.replace(/\s*\(stop reason: [^)]*\)/, "");

export function factsSummary(history: MemoryEntry[], current: Observation): string {
  const observations: Observation[] = [...history.map((e) => e.observation), current];
  const lines: string[] = [];

  // Where the agent has been.
  const visited: string[] = [];
  for (const o of observations) if (!visited.includes(at(o.position))) visited.push(at(o.position));
  let since = current.turn;
  for (let i = observations.length - 1; i >= 0; i--) {
    if (at(observations[i]!.position) !== at(current.position)) break;
    since = observations[i]!.turn;
  }
  lines.push(
    `- You are at ${at(current.position)}${since < current.turn ? `, where you have been since turn ${since}` : ""}.`,
    `- Cells you have been in (${visited.length}): ${list(visited)}.`,
  );

  // Cells the agent knows, by type (own cells + revealed + visible).
  const known = new Map<string, string>();
  const learn = (c: ObservedCell) => known.set(at(c), c.type);
  for (const o of observations) {
    known.set(at(o.position), o.cell.type);
    o.revealed?.forEach(learn);
    o.visible?.forEach(learn);
  }
  const byType = new Map<string, string[]>();
  for (const [cell, type] of known) byType.set(type, [...(byType.get(type) ?? []), cell]);
  if (byType.size > 0) {
    const parts = [...byType.entries()].map(([type, cells]) =>
      cells.length <= MAX_LISTED ? `${type} ${cells.join(", ")}` : `${type} ${cells.length} cells`,
    );
    lines.push(`- Cells you know (${known.size} of ${current.grid_size.width * current.grid_size.height}): ${parts.join("; ")}.`);
  }

  // Last sighting of each other agent.
  const sightings = new Map<string, { turn: number; where: string; how: string }>();
  for (const o of observations) {
    for (const id of o.cell.agents) sightings.set(id, { turn: o.turn, where: at(o.position), how: "in your cell" });
    for (const c of o.revealed ?? []) for (const id of c.agents) sightings.set(id, { turn: o.turn, where: at(c), how: "revealed" });
    for (const c of o.visible ?? []) for (const id of c.agents) sightings.set(id, { turn: o.turn, where: at(c), how: "visible" });
  }
  lines.push(
    sightings.size
      ? `- Agents you have seen (last time): ${[...sightings.entries()].map(([id, s]) => `${id} at ${s.where} on turn ${s.turn} (${s.how})`).join("; ")}.`
      : "- Agents you have seen: none.",
  );

  // Messages received and sent.
  const heard = observations.flatMap((o) => o.messages);
  if (heard.length) {
    const last = heard[heard.length - 1]!;
    lines.push(`- Messages heard: ${heard.length} (${counts(heard.map((m) => `from ${m.from}`))}). Last: ${last.from} on turn ${last.turn}: "${last.text}".`);
  } else {
    lines.push("- Messages heard: none.");
  }
  const spoken = history.filter((e) => e.action?.name === "speak" && !e.rejected);
  if (spoken.length) {
    const unseen = spoken.filter((e) => e.observation.cell.agents.length === 0 && !e.observation.visible?.some((c) => c.agents.length)).length;
    lines.push(`- Messages you sent: ${spoken.length}${unseen ? ` (${unseen} while you saw no other agent)` : ""}.`);
  }

  // Action statistics.
  const accepted = history.filter((e) => e.action && !e.rejected).map((e) => e.action!.name);
  const rejected = history.filter((e) => e.rejected).map((e) => reasonKind(e.rejected!));
  if (history.length) {
    lines.push(
      `- Your ${history.length} past turns: ${accepted.length} accepted actions${accepted.length ? ` (${counts(accepted)})` : ""}; ` +
        `${rejected.length} rejected${rejected.length ? ` (${counts(rejected)})` : ""}.`,
    );
  }

  return lines.join("\n");
}
