import { pathToFileURL } from "node:url";
import { STANDARD_ACTIONS } from "../actions/standard.js";
import type { ActionContext, ActionDefinition, Args } from "../actions/types.js";
import { ConfigError } from "../config/errors.js";
import type { Observation } from "../mechanics/perception.js";
import type { JsonSchema } from "../models/types.js";
import type { AgentState, World } from "../world/world.js";
import type { Rng } from "./rng.js";

/** A scenario-specific action, exposed to agents as a tool like any other. */
export interface CustomAction {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Returns a rejection reason, or null. Runs against the state at the start of the batch. */
  validate?(args: Args, ctx: ActionContext): string | null;
  /** Applies the action. Runs after standard effects of the same batch. */
  apply(args: Args, ctx: ActionContext & { rng: Rng }): void;
}

/**
 * Optional hooks a scenario can provide in its `rules.ts` (default export).
 * Hooks may only mutate the world inside `apply` (custom actions) and
 * `afterTurn`; any new state must live in `world.state` so it is snapshotted.
 */
export interface ScenarioRules {
  actions?(): CustomAction[];
  observe?(observation: Observation, agent: AgentState, world: World): Observation;
  validate?(action: { name: string; args: Args }, ctx: ActionContext): string | null;
  afterTurn?(world: World, rng: Rng, turn: number): void;
  isFinished?(world: World, turn: number): boolean;
}

export async function loadScenarioRules(path: string | undefined): Promise<ScenarioRules> {
  if (!path) return {};
  let module: { default?: ScenarioRules };
  try {
    module = (await import(pathToFileURL(path).href)) as { default?: ScenarioRules };
  } catch (error) {
    throw new ConfigError(`Cannot load scenario hooks ${path}: ${(error as Error).message}`);
  }
  if (!module.default || typeof module.default !== "object") {
    throw new ConfigError(`Scenario hooks ${path} must default-export a ScenarioRules object`);
  }
  return module.default;
}

export function toActionDefinition(custom: CustomAction): ActionDefinition {
  if ((STANDARD_ACTIONS as readonly string[]).includes(custom.name)) {
    throw new ConfigError(`Custom action "${custom.name}" redefines a standard action; use a different name`);
  }
  return {
    name: custom.name,
    tool: { name: custom.name, description: custom.description, inputSchema: custom.inputSchema },
    validate: (args, ctx) => custom.validate?.(args, ctx) ?? null,
    effect: (args, ctx) => ({
      kind: "custom",
      agentId: ctx.agent.id,
      action: custom.name,
      args,
      apply: (world, rng) => custom.apply(args, { agent: world.agent(ctx.agent.id), world, turn: ctx.turn, rng }),
    }),
  };
}
