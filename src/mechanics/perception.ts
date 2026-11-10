import { parseRange } from "../config/scenario.js";
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
  agents: string[];
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
  cell: { type: string; agents: string[] };
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

export const toObservedCell = (view: CellView, excludeId?: string): ObservedCell => ({
  x: view.position[0],
  y: view.position[1],
  type: view.type,
  agents: excludeId ? view.agents.filter((id) => id !== excludeId) : view.agents,
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
    cell: { type: world.cellAt(agent.position)!.type, agents: world.agentsAt(agent.position, agentId) },
    messages: mailbox.messages,
    last_action_error: mailbox.lastActionError,
    available_actions: availableActions,
  };
  if (radius > 0) {
    observation.visible = world.cellsWithin(agent.position, radius, false).map((view) => toObservedCell(view, agentId));
  }
  if (mailbox.revealed) observation.revealed = mailbox.revealed.map((view) => toObservedCell(view, agentId));
  return observation;
}
