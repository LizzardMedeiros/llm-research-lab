import type { Args } from "../actions/types.js";
import type { Observation } from "../mechanics/perception.js";
import type { ToolDef } from "../models/types.js";

export interface MemoryEntry {
  turn: number;
  observation: Observation;
  action: { name: string; args: Args } | null;
  rejected: string | null;
}

export interface DecisionInput {
  turn: number;
  observation: Observation;
  tools: ToolDef[];
  /**
   * Every past turn of this agent, oldest first. Each decider applies its own
   * memory strategy (window, summary) to it.
   */
  history: MemoryEntry[];
}

export interface ProposedCall {
  name: string;
  /** null when the arguments could not be parsed. */
  args: Args | null;
  rawArguments?: string;
}

export interface Decision {
  call: ProposedCall | null;
  /** Why there is no usable call (no tool call, provider error...). */
  error?: string;
  /** Model-reported explanation (free text next to the tool call). */
  rationale?: string;
  /** Events produced while deciding (model request/response), emitted in agent order. */
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

/**
 * Anything that chooses an action for an agent: an LLM or a policy.
 * The engine treats every decider the same way.
 */
export interface Decider {
  /** Description recorded in experiment.started (provider/model or policy). */
  readonly describe: Record<string, unknown>;
  decide(input: DecisionInput): Promise<Decision>;
}
