import type { Args } from "../actions/types.js";
import { ConfigError } from "../config/errors.js";
import type { Rng } from "../engine/rng.js";
import type { JsonSchema, ToolDef } from "../models/types.js";
import type { Policy, PolicyCall, PolicyRequirements } from "./types.js";

/** Random arguments that satisfy simple JSON Schemas (enums, strings, numbers, booleans). */
export function randomArgs(schema: JsonSchema, rng: Rng, text = "Hello."): Args {
  const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
  const required = (schema["required"] ?? []) as string[];
  const args: Args = {};
  for (const name of required) {
    const prop = properties[name] ?? {};
    const values = prop["enum"] as unknown[] | undefined;
    if (values?.length) args[name] = rng.pick(values);
    else if (prop["type"] === "string") args[name] = text;
    else if (prop["type"] === "integer" || prop["type"] === "number") args[name] = 0;
    else if (prop["type"] === "boolean") args[name] = rng.int(2) === 1;
    else args[name] = null;
  }
  return args;
}

const stringList = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(`policy param "${field}" must be a list of action names`);
  }
  return value;
};

const parseCall = (value: unknown, field: string): PolicyCall => {
  const call = value as { action?: unknown; args?: unknown };
  if (!call || typeof call.action !== "string") throw new ConfigError(`policy param "${field}" needs an "action"`);
  if (call.args !== undefined && (typeof call.args !== "object" || call.args === null)) {
    throw new ConfigError(`policy param "${field}.args" must be an object`);
  }
  return { action: call.action, args: (call.args as Args | undefined) ?? {} };
};

/** `random` — seeded random tool and arguments. Params: actions?, text? */
const random: Policy = ({ tools, params, rng }) => {
  const allowed = stringList(params["actions"], "actions");
  const candidates: ToolDef[] = allowed ? tools.filter((t) => allowed.includes(t.name)) : tools;
  if (candidates.length === 0) return { action: "wait" };
  const tool = rng.pick(candidates);
  const text = typeof params["text"] === "string" ? params["text"] : undefined;
  return { action: tool.name, args: randomArgs(tool.inputSchema, rng, text) };
};

/** `repeat` — always the same call. Params: action, args? */
const repeat: Policy = ({ params }) => parseCall(params, "repeat");

/** `scripted` — one call per turn from `steps`; then: wait | loop | repeat_last. */
const scripted: Policy = ({ params, turn }) => {
  const steps = params["steps"];
  if (!Array.isArray(steps) || steps.length === 0) throw new ConfigError(`policy "scripted" needs a non-empty "steps" list`);
  const then = params["then"] ?? "wait";
  const index = turn - 1;
  if (index < steps.length) return parseCall(steps[index], `steps[${index}]`);
  if (then === "loop") return parseCall(steps[index % steps.length], "steps");
  if (then === "repeat_last") return parseCall(steps[steps.length - 1], "steps");
  return { action: "wait" };
};

export const BUILTIN_POLICIES: Record<string, { policy: Policy; requires: PolicyRequirements }> = {
  random: { policy: random, requires: (params) => stringList(params["actions"], "actions") ?? [] },
  repeat: { policy: repeat, requires: (params) => [parseCall(params, "repeat").action] },
  scripted: {
    policy: scripted,
    requires: (params) => {
      const steps = params["steps"];
      if (!Array.isArray(steps) || steps.length === 0) throw new ConfigError(`policy "scripted" needs a non-empty "steps" list`);
      const then = params["then"] ?? "wait";
      if (!["wait", "loop", "repeat_last"].includes(then as string)) {
        throw new ConfigError(`policy "scripted": "then" must be wait, loop or repeat_last`);
      }
      const names = steps.map((step, i) => parseCall(step, `steps[${i}]`).action);
      return then === "wait" ? [...names, "wait"] : names;
    },
  },
};
