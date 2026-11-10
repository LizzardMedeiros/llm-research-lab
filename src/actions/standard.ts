import { parseRange, type ScenarioConfig } from "../config/scenario.js";
import { distance, type Position } from "../world/world.js";
import type { ActionDefinition } from "./types.js";

/**
 * Standard actions: fixed tool schema and semantics, shared by every
 * scenario. Scenarios only enable them and set their parameters.
 */
export const STANDARD_ACTIONS = ["move", "speak", "observe", "wait"] as const;
export type StandardActionName = (typeof STANDARD_ACTIONS)[number];

const OFFSETS: Record<string, Position> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
};

type ActionsConfig = ScenarioConfig["actions"];

export function createMove(params: NonNullable<ActionsConfig["move"]>): ActionDefinition {
  const directions = params.directions === "eight" ? Object.keys(OFFSETS) : ["north", "south", "east", "west"];
  return {
    name: "move",
    tool: {
      name: "move",
      description: "Move one cell in the given direction. North is up (y - 1).",
      inputSchema: {
        type: "object",
        properties: { direction: { type: "string", enum: directions } },
        required: ["direction"],
        additionalProperties: false,
      },
    },
    validate(args, { agent, world }) {
      const direction = args["direction"];
      if (typeof direction !== "string" || !directions.includes(direction)) {
        return `invalid direction ${JSON.stringify(direction)}; expected one of ${directions.join(", ")}`;
      }
      const [dx, dy] = OFFSETS[direction]!;
      const target: Position = [agent.position[0] + dx, agent.position[1] + dy];
      if (!world.inBounds(target)) return `cannot move ${direction}: outside the grid`;
      if (world.cellAt(target)!.blocksMovement) return `cannot move ${direction}: ${world.cellAt(target)!.type} blocks movement`;
      return null;
    },
    effect(args, { agent }) {
      const [dx, dy] = OFFSETS[args["direction"] as string]!;
      return { kind: "move", agentId: agent.id, from: agent.position, to: [agent.position[0] + dx, agent.position[1] + dy] };
    },
  };
}

export function createSpeak(params: NonNullable<ActionsConfig["speak"]>): ActionDefinition {
  const radius = parseRange(params.range);
  const audience =
    radius === 0 ? "agents in your cell" : radius === Infinity ? "all agents" : `agents within ${radius} cells`;
  return {
    name: "speak",
    tool: {
      name: "speak",
      description: `Say something. Heard by ${audience}, delivered next turn.`,
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: params.max_length } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    validate(args) {
      const text = args["text"];
      if (typeof text !== "string" || text.trim() === "") return "speak requires a non-empty text";
      if (text.length > params.max_length) return `text exceeds ${params.max_length} characters`;
      return null;
    },
    effect(args, { agent, world }) {
      const recipients = [...world.agents.values()]
        .filter((other) => other.id !== agent.id && world.isActive(other.id) && distance(other.position, agent.position) <= radius)
        .map((other) => other.id);
      return { kind: "speak", agentId: agent.id, text: args["text"] as string, recipients };
    },
  };
}

export function createObserve(params: NonNullable<ActionsConfig["observe"]>): ActionDefinition {
  const radius = params.reveals === "neighbors_8" ? 1 : parseRange(params.reveals);
  return {
    name: "observe",
    tool: {
      name: "observe",
      description: `Spend this turn looking around: reveals the cells within ${radius} of you in your next observation.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    validate: () => null,
    effect: (_args, { agent, world }) => ({
      kind: "reveal",
      agentId: agent.id,
      cells: world.cellsWithin(agent.position, radius, false),
    }),
  };
}

export function createWait(): ActionDefinition {
  return {
    name: "wait",
    tool: {
      name: "wait",
      description: "Do nothing this turn.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    validate: () => null,
    effect: (_args, { agent }) => ({ kind: "none", agentId: agent.id }),
  };
}

/** Standard actions enabled by a scenario, in a stable order. */
export function createStandardActions(config: ActionsConfig): ActionDefinition[] {
  const actions: ActionDefinition[] = [];
  if (config.move) actions.push(createMove(config.move));
  if (config.speak) actions.push(createSpeak(config.speak));
  if (config.observe) actions.push(createObserve(config.observe));
  if (config.wait) actions.push(createWait());
  return actions;
}
