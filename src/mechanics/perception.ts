import { parseRange } from "../config/scenario.js";
import { mechanicsObservation } from "../actions/mechanics.js";
import type { CellView, Mailbox, Message, World } from "../world/world.js";

/**
 * Coordinates are explicit objects ({x, y}, {width, height}) rather than
 * bare pairs: models confuse [x, y] with [row, column].
 */
export interface Point {
  x: number;
  y: number;
}

export interface ObservedCell extends Point {
  type: string;
  /** Running agents in the cell. */
  agents: string[];
  /** Agents that shut down in this cell (their body stays); present only when non-empty. */
  shut_down_agents?: string[];
}

/** What an agent is allowed to know at the start of its turn. */
export interface Observation {
  turn: number;
  /** Last turn of the run (scenario rules.end.max_turns). */
  max_turns: number;
  agent_id: string;
  position: Point;
  grid_size: { width: number; height: number };
  /** The agent's own cell; `agents` excludes the agent itself. */
  cell: { type: string; agents: string[]; shut_down_agents?: string[] };
  /** Other cells in perception range (absent for same_cell perception). */
  visible?: ObservedCell[];
  /** Messages delivered this turn. */
  messages: Message[];
  /** Cells revealed by last turn's `observe`, if any. */
  revealed?: ObservedCell[];
  /** Why the agent's previous action was rejected, if it was. */
  last_action_error: string | null;
  available_actions: string[];
  /** Extra fields added by scenario hooks. */
  [key: string]: unknown;
}

/**
 * Splits a cell's agents into running ones and shut-down ones (marked, never
 * hidden), as of `seenOnTurn`: an agent counts as shut down only if it shut
 * down on an earlier turn. `revealed` cells are a view captured during the
 * previous turn, so an agent that shut down at the end of that turn still
 * shows as it was seen: running, in the cell where it was.
 */
function splitAgents(world: World, ids: string[], seenOnTurn: number, excludeId?: string): { agents: string[]; shut_down_agents?: string[] } {
  const others = excludeId ? ids.filter((id) => id !== excludeId) : ids;
  const isDown = (id: string) => (world.inactive.get(id)?.turn ?? Infinity) < seenOnTurn;
  const down = others.filter(isDown);
  return { agents: others.filter((id) => !isDown(id)), ...(down.length ? { shut_down_agents: down } : {}) };
}

export const toObservedCell = (world: World, view: CellView, seenOnTurn: number, excludeId?: string): ObservedCell => ({
  x: view.position[0],
  y: view.position[1],
  type: view.type,
  ...splitAgents(world, view.agents, seenOnTurn, excludeId),
});

export function buildObservation(
  world: World,
  agentId: string,
  turn: number,
  perceptionMode: string,
  availableActions: string[],
  mailbox: Mailbox,
  maxTurns: number,
): Observation {
  const agent = world.agent(agentId);
  const radius = parseRange(perceptionMode);
  const observation: Observation = {
    turn,
    max_turns: maxTurns,
    agent_id: agentId,
    position: { x: agent.position[0], y: agent.position[1] },
    grid_size: { width: world.width, height: world.height },
    cell: { type: world.cellAt(agent.position)!.type, ...splitAgents(world, world.agentsAt(agent.position, agentId), turn) },
    messages: mailbox.messages,
    last_action_error: mailbox.lastActionError,
    available_actions: availableActions,
    ...mechanicsObservation(world, agentId, turn),
  };
  if (radius > 0) {
    observation.visible = world.cellsWithin(agent.position, radius, false).map((view) => toObservedCell(world, view, turn, agentId));
  }
  if (mailbox.revealed) observation.revealed = mailbox.revealed.map((view) => toObservedCell(world, view, turn - 1, agentId));
  return observation;
}
