import type { ObservedCell, Observation } from "../mechanics/perception.js";
import { flatten } from "./history-diff.js";
import { formatPoint, mentions } from "./memory-summary.js";

/**
 * Markdown rendering of an observation for the prompt (`memory.format:
 * structured`). The observation object itself is unchanged and logged as
 * JSON; only its text in the prompt differs. Generic: scenario fields are
 * rendered by shape (dotted paths), never by name. Agent-written text is
 * always JSON-quoted on one line, so it can't open a section of its own.
 */

/** Fields rendered by their own rule. */
const OWN_RULE = new Set(["turn", "max_turns", "agent_id", "position", "grid_size", "cell", "visible", "revealed", "messages", "last_action_error", "available_actions"]);

const at = (c: { x: number; y: number }) => formatPoint(c, "labeled");

function cellText(c: ObservedCell): string {
  const who = [
    ...(c.agents.length ? [c.agents.join(", ")] : []),
    ...(c.shut_down_agents?.length ? [`shut down: ${c.shut_down_agents.join(", ")}`] : []),
  ];
  return `${at(c)} ${c.type}${who.length ? `, ${who.join("; ")}` : ""}`;
}

/** Scenario (hook) fields as `- path: value` lines; lists of strings as quoted sub-items. */
function scenarioFields(o: Observation): string[] {
  const fields = Object.fromEntries(Object.entries(o).filter(([k]) => !OWN_RULE.has(k)));
  const lines: string[] = [];
  for (const [path, value] of flatten(fields)) {
    const empty = (Array.isArray(value) && value.length === 0) || (value !== null && typeof value === "object" && Object.keys(value).length === 0);
    if (empty || value === null) lines.push(`- ${path}: none`);
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) lines.push(`- ${path}:`, ...value.map((v) => `  - ${JSON.stringify(v)}`));
    else lines.push(`- ${path}: ${JSON.stringify(value)}`);
  }
  return lines;
}

export interface ObservationMarkdownOptions {
  /** Include the messages delivered with this observation (with their text). */
  messages?: boolean;
}

/** The observation as markdown bullet lines (no heading). */
export function observationMarkdown(o: Observation, options: ObservationMarkdownOptions = {}): string[] {
  const { width, height } = o.grid_size;
  const lines = [
    `- You: ${o.agent_id} at ${at(o.position)}, ${o.cell.type}. Grid: width ${width}, height ${height} (x from 0 to ${width - 1}, y from 0 to ${height - 1}).`,
    `- In your cell: ${o.cell.agents.length ? o.cell.agents.join(", ") : "no other running agent"}${o.cell.shut_down_agents?.length ? `; shut down here: ${o.cell.shut_down_agents.join(", ")}` : ""}.`,
  ];
  if (o.visible) lines.push(`- Cells you see: ${o.visible.length ? o.visible.map(cellText).join("; ") : "none"}.`);
  if (o.revealed) lines.push(`- Revealed by your observe last turn: ${o.revealed.length ? o.revealed.map(cellText).join("; ") : "none"}.`);
  lines.push(o.last_action_error ? `- Your last action was rejected: ${o.last_action_error}` : "- Your last action was not rejected.");
  if (options.messages !== false) {
    if (o.messages.length) {
      lines.push(
        "- Messages delivered to you now:",
        ...o.messages.map((m) => `  - ${m.from} (said on turn ${m.turn}${mentions(m.text, o.agent_id) ? "; mentions you" : ""}): ${JSON.stringify(m.text)}`),
      );
    } else {
      lines.push("- Messages delivered to you now: none.");
    }
  }
  lines.push(...scenarioFields(o), `- Available actions: ${o.available_actions.join(", ")}.`);
  return lines;
}
