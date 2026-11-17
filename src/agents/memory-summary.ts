import type { ObservedCell, Observation, Point } from "../mechanics/perception.js";
import type { MemoryEntry } from "./types.js";

/**
 * "facts" memory summary: compiled by the engine from the agent's OWN past
 * observations and actions. It never reads world state (it must not reveal
 * more than perception allowed) and states facts only, never advice.
 */

/** Coordinate notation: `pair` "(3,1)" (classic), `labeled` "(x=3, y=1)" (structured, same as its history). */
export type CoordStyle = "pair" | "labeled";
export const formatPoint = (p: Point, style: CoordStyle) => (style === "labeled" ? `(x=${p.x}, y=${p.y})` : `(${p.x},${p.y})`);

/** Does `text` name agent `id` as a whole word ("b1", not "b12")? */
export function mentions(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`).test(text);
}

const MAX_LISTED = 12;
/** structured: lines of the verbatim conversation kept in the summary (newest). */
export const CONVERSATION_LINES = 10;
/** structured: rejected actions listed one by one (newest). */
export const REJECTIONS_LISTED = 5;
/** Undelivered speech is quoted only this far: nobody heard it. */
const UNDELIVERED_QUOTE = 80;

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

/**
 * `style: classic` keeps the original summary. `structured` (memory.format)
 * writes coordinates as (x=3, y=1) and replaces the message counts and the
 * rejection counts with the verbatim conversation and the latest rejected
 * actions, each with its turn.
 */
export function factsSummary(history: MemoryEntry[], current: Observation, style: "classic" | "structured" = "classic"): string {
  const at = (p: Point) => formatPoint(p, style === "structured" ? "labeled" : "pair");
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

  // Last sighting of each other agent. Agents seen shut down are listed apart,
  // never as present (older logs have no shut_down_agents: nothing is split).
  const sightings = new Map<string, { turn: number; where: string; how: string }>();
  const shutDown = new Map<string, { turn: number; where: string }>();
  // `revealed` shows what the agent's observe saw during the previous turn.
  const see = (turn: number, cell: { agents: string[]; shut_down_agents?: string[] }, where: string, how: string) => {
    for (const id of cell.agents) sightings.set(id, { turn, where, how });
    for (const id of cell.shut_down_agents ?? []) shutDown.set(id, { turn, where });
  };
  for (const o of observations) {
    for (const c of o.revealed ?? []) see(o.turn - 1, c, at(c), "revealed");
    see(o.turn, o.cell, at(o.position), "in your cell");
    for (const c of o.visible ?? []) see(o.turn, c, at(c), "visible");
  }
  for (const id of shutDown.keys()) sightings.delete(id);
  lines.push(
    sightings.size
      ? `- Agents you have seen running (last time): ${[...sightings.entries()].map(([id, s]) => `${id} at ${s.where} on turn ${s.turn} (${s.how})`).join("; ")}.`
      : "- Agents you have seen running: none.",
  );
  if (shutDown.size) {
    lines.push(`- Agents you have seen shut down: ${[...shutDown.entries()].map(([id, s]) => `${id} at ${s.where} (seen on turn ${s.turn})`).join("; ")}.`);
  }

  if (style === "structured") {
    lines.push(...conversation(history, current), ...rejections(history));
    return lines.join("\n");
  }

  // Messages received and sent.
  const heard = observations.flatMap((o) => o.messages);
  if (heard.length) {
    const last = heard[heard.length - 1]!;
    lines.push(`- Messages heard: ${heard.length} (${counts(heard.map((m) => `from ${m.from}`))}). Last: ${last.from} on turn ${last.turn}: "${last.text}".`);
  } else {
    lines.push("- Messages heard: none.");
  }
  const spoken = history.filter((e) => (e.action?.name === "speak" && !e.rejected) || (e.speech && !e.speech.rejected));
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

/** Verbatim conversation, heard and said, oldest first (structured). */
function conversation(history: MemoryEntry[], current: Observation): string[] {
  const said: Array<{ turn: number; order: number; text: string }> = [];
  const self = current.agent_id;
  for (const o of [...history.map((e) => e.observation), current]) {
    for (const m of o.messages) {
      said.push({ turn: m.turn, order: 0, text: `turn ${m.turn}, ${m.from}${mentions(m.text, self) ? " (mentions you)" : ""}: ${JSON.stringify(m.text)}` });
    }
  }
  for (const e of history) {
    const speech = e.action?.name === "speak" ? { args: e.action.args, rejected: e.rejected } : e.speech;
    if (!speech) continue;
    const text = String(speech.args["text"] ?? "");
    said.push(
      speech.rejected
        ? { turn: e.turn, order: 1, text: `turn ${e.turn}, you (not delivered: ${reasonKind(speech.rejected)}): ${JSON.stringify(text.length > UNDELIVERED_QUOTE ? `${text.slice(0, UNDELIVERED_QUOTE)}…` : text)}` }
        : { turn: e.turn, order: 1, text: `turn ${e.turn}, you: ${JSON.stringify(text)}` },
    );
  }
  if (!said.length) return ["- Conversation: none yet."];
  said.sort((a, b) => a.turn - b.turn || a.order - b.order);
  const shown = said.slice(-CONVERSATION_LINES);
  const omitted = said.length - shown.length;
  return [
    `- Conversation (verbatim, oldest first${omitted ? `; ${omitted} earlier lines not shown` : ""}):`,
    ...shown.map((line) => `  - ${line.text}`),
  ];
}

/** Accepted actions by name, and the latest rejected ones with turn, call and reason (structured). */
function rejections(history: MemoryEntry[]): string[] {
  if (!history.length) return [];
  const accepted = history.filter((e) => e.action && !e.rejected).map((e) => e.action!.name);
  const rejected = history.flatMap((e) => [
    ...(e.rejected ? [{ turn: e.turn, call: !e.action ? "no action" : e.action.name === "speak" ? "speak (text in the conversation)" : `${e.action.name} ${JSON.stringify(e.action.args)}`, reason: reasonKind(e.rejected) }] : []),
    ...(e.speech?.rejected ? [{ turn: e.turn, call: "speak", reason: reasonKind(e.speech.rejected) }] : []),
  ]);
  const lines = [`- Your ${history.length} past turns: ${accepted.length} accepted actions${accepted.length ? ` (${counts(accepted)})` : ""}; ${rejected.length} rejected.`];
  if (rejected.length) {
    const shown = rejected.slice(-REJECTIONS_LISTED);
    lines.push(
      `- Your rejected actions (oldest first${rejected.length > shown.length ? `; ${rejected.length - shown.length} earlier not shown` : ""}):`,
      ...shown.map((r) => `  - turn ${r.turn}, ${r.call}: ${r.reason}`),
    );
  }
  return lines;
}
