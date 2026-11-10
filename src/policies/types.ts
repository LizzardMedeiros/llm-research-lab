import type { Args } from "../actions/types.js";
import type { MemoryEntry } from "../agents/types.js";
import type { Rng } from "../engine/rng.js";
import type { Observation } from "../mechanics/perception.js";
import type { ToolDef } from "../models/types.js";

export interface PolicyContext {
  agentId: string;
  turn: number;
  observation: Observation;
  /** Tools offered this turn (same as an LLM agent would get). */
  tools: ToolDef[];
  /** Last N turns (the agent's memory window), oldest first. */
  memory: MemoryEntry[];
  params: Record<string, unknown>;
  /** Seeded, per-agent stream. Never use Math.random() in a policy. */
  rng: Rng;
}

export interface PolicyCall {
  action: string;
  args?: Args;
}

/** A policy decides one tool call per turn, without an LLM. */
export type Policy = (ctx: PolicyContext) => PolicyCall | Promise<PolicyCall>;

/**
 * Static check run before the experiment starts: returns the action names a
 * policy may use, so unsupported actions fail validation early.
 * Custom policies cannot be checked statically.
 */
export type PolicyRequirements = (params: Record<string, unknown>) => string[];
