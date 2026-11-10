import { Ajv, type ErrorObject } from "ajv";
import { ConfigError } from "../config/errors.js";
import type { ActionDefinition, Args } from "./types.js";

export type ArgsValidator = (args: Args) => string | null;

const ajv = new Ajv({ allErrors: true, strict: false });

function describeError(error: ErrorObject): string {
  const field = error.instancePath ? `"${error.instancePath.slice(1).replace(/\//g, ".")}"` : "arguments";
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      return `unexpected argument "${params["additionalProperty"]}"`;
    case "required":
      return `missing argument "${params["missingProperty"]}"`;
    case "enum":
      return `${field} must be one of ${(params["allowedValues"] as unknown[]).join(", ")}`;
    case "type":
      return `${field} must be ${params["type"]}`;
    case "maxLength":
      return `${field} exceeds ${params["limit"]} characters`;
    default:
      return `${field} ${error.message ?? "is invalid"}`;
  }
}

/**
 * Compiles every action's tool schema. Arguments are checked against the
 * exact schema the model was given, for standard and custom actions alike.
 * Invalid schemas fail before the run starts.
 */
export function compileArgsValidators(actions: ActionDefinition[]): Map<string, ArgsValidator> {
  const validators = new Map<string, ArgsValidator>();
  for (const action of actions) {
    let validate;
    try {
      validate = ajv.compile(action.tool.inputSchema);
    } catch (error) {
      throw new ConfigError(`Action "${action.name}" has an invalid inputSchema: ${(error as Error).message}`);
    }
    validators.set(action.name, (args) =>
      validate(args) ? null : [...new Set(validate.errors!.map(describeError))].join("; "),
    );
  }
  return validators;
}
