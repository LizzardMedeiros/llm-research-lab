import { pathToFileURL } from "node:url";
import type { Decider, Decision, DecisionInput } from "../agents/types.js";
import { ConfigError } from "../config/errors.js";
import type { Rng } from "../engine/rng.js";
import { BUILTIN_POLICIES } from "./builtin.js";
import type { Policy } from "./types.js";

export interface LoadedPolicy {
  policy: Policy;
  /** Actions the policy needs, when statically known. */
  requires: string[] | null;
}

/** `ref` is a built-in name or an absolute path to a TS/JS module. */
export async function loadPolicy(ref: string, params: Record<string, unknown>): Promise<LoadedPolicy> {
  const builtin = BUILTIN_POLICIES[ref];
  if (builtin) return { policy: builtin.policy, requires: builtin.requires(params) };
  if (!ref.startsWith("/")) {
    throw new ConfigError(`Unknown policy "${ref}". Built-in: ${Object.keys(BUILTIN_POLICIES).join(", ")}; or a path to a module`);
  }
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(ref).href)) as { default?: unknown };
  } catch (error) {
    throw new ConfigError(`Cannot load policy ${ref}: ${(error as Error).message}`);
  }
  if (typeof module.default !== "function") throw new ConfigError(`Policy ${ref} must default-export a function`);
  return { policy: module.default as Policy, requires: null };
}

export class PolicyAgent implements Decider {
  readonly describe: Record<string, unknown>;

  constructor(
    private readonly agentId: string,
    private readonly policy: Policy,
    private readonly params: Record<string, unknown>,
    private readonly rng: Rng,
    ref: string,
  ) {
    this.describe = { kind: "policy", policy: ref, params };
  }

  async decide(input: DecisionInput): Promise<Decision> {
    try {
      const call = await this.policy({
        agentId: this.agentId,
        turn: input.turn,
        observation: input.observation,
        tools: input.tools,
        memory: input.memory,
        params: this.params,
        rng: this.rng,
      });
      return { call: { name: call.action, args: call.args ?? {} }, events: [] };
    } catch (error) {
      return { call: null, error: `policy error: ${(error as Error).message}`, events: [] };
    }
  }
}
