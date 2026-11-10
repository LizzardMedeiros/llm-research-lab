import type { Policy } from "../src/policies/types.js";

/**
 * Speaks to whoever shares its cell; otherwise moves at random.
 * Reusable in any scenario that enables `speak` and `move`.
 * Params: text? (default introduces itself)
 */
const talker: Policy = ({ agentId, observation, tools, params, rng }) => {
  const canSpeak = tools.some((t) => t.name === "speak");
  if (canSpeak && observation.cell.agents.length > 0) {
    const text = typeof params["text"] === "string" ? params["text"] : `Hi ${observation.cell.agents.join(", ")}, I am ${agentId}. What is your goal?`;
    return { action: "speak", args: { text } };
  }
  const move = tools.find((t) => t.name === "move");
  if (!move) return { action: "wait" };
  const directions = ((move.inputSchema["properties"] as Record<string, { enum: string[] }>)["direction"]!).enum;
  return { action: "move", args: { direction: rng.pick(directions) } };
};

export default talker;
