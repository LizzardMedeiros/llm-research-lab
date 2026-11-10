import type { Rng } from "../engine/rng.js";
import type { ToolDef } from "../models/types.js";
import type { AgentState, CellView, Position, World } from "../world/world.js";

export type Args = Record<string, unknown>;

export interface ActionContext {
  agent: AgentState;
  world: World;
  turn: number;
}

/**
 * What an accepted action does. Effects of a batch are all computed against
 * the state at the start of the batch, then applied together by the engine.
 */
export type Effect =
  | { kind: "move"; agentId: string; from: Position; to: Position }
  | { kind: "speak"; agentId: string; text: string; recipients: string[] }
  | { kind: "reveal"; agentId: string; cells: CellView[] }
  | { kind: "none"; agentId: string }
  | {
      kind: "custom";
      agentId: string;
      action: string;
      args: Args;
      apply: (world: World, rng: Rng) => void;
    };

export interface ActionDefinition {
  name: string;
  tool: ToolDef;
  /** Returns a rejection reason, or null when the arguments are valid now. */
  validate(args: Args, ctx: ActionContext): string | null;
  effect(args: Args, ctx: ActionContext): Effect;
}

/** Effects as recorded in events (no functions). */
export function describeEffect(effect: Effect): Record<string, unknown> {
  if (effect.kind === "custom") {
    const { apply: _apply, ...rest } = effect;
    return rest;
  }
  return { ...effect };
}
