import { parseRange } from "../config/scenario.js";
import type { CellView, Mailbox, Message, Position, World } from "../world/world.js";

/** What an agent is allowed to know at the start of its turn. */
export interface Observation {
  turn: number;
  agent_id: string;
  position: Position;
  grid_size: [number, number];
  /** The agent's own cell; `agents` excludes the agent itself. */
  cell: { type: string; agents: string[] };
  /** Other cells in perception range (absent for same_cell perception). */
  visible?: CellView[];
  /** Messages delivered this turn. */
  messages: Message[];
  /** Cells revealed by last turn's `observe`, if any. */
  revealed?: CellView[];
  /** Why the agent's previous action was rejected, if it was. */
  last_action_error: string | null;
  available_actions: string[];
  /** Extra fields added by scenario hooks. */
  [key: string]: unknown;
}

export function buildObservation(
  world: World,
  agentId: string,
  turn: number,
  perceptionMode: string,
  availableActions: string[],
  mailbox: Mailbox,
): Observation {
  const agent = world.agent(agentId);
  const radius = parseRange(perceptionMode);
  const observation: Observation = {
    turn,
    agent_id: agentId,
    position: [...agent.position],
    grid_size: [world.width, world.height],
    cell: { type: world.cellAt(agent.position)!.type, agents: world.agentsAt(agent.position, agentId) },
    messages: mailbox.messages,
    last_action_error: mailbox.lastActionError,
    available_actions: availableActions,
  };
  if (radius > 0) {
    observation.visible = world
      .cellsWithin(agent.position, radius, false)
      .map((view) => ({ ...view, agents: view.agents.filter((id) => id !== agentId) }));
  }
  if (mailbox.revealed) observation.revealed = mailbox.revealed;
  return observation;
}
