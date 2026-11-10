import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";

const AgentId = z.string().regex(/^[A-Za-z0-9_-]+$/, "agent ids use letters, digits, _ and -");

/** Per-agent override of the scenario's memory strategy (any subset). */
const MemoryOverrideSchema = z
  .object({ window: z.number().int().min(0).optional(), summary: z.enum(["none", "facts"]).optional() })
  .strict()
  .optional();

const PolicyAgentSchema = z
  .object({
    id: AgentId,
    provider: z.literal("policy"),
    /** Built-in policy name, or a path to a TS module (relative to the experiment file). */
    policy: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    goal: z.string().default(""),
    memory: MemoryOverrideSchema,
  })
  .strict();

const ModelAgentSchema = z
  .object({
    id: AgentId,
    /** Endpoint name from providers.yaml. */
    provider: z.string().min(1).refine((p) => p !== "policy" && p !== "mock", "use a providers.yaml endpoint"),
    model: z.string().min(1),
    goal: z.string().default(""),
    temperature: z.number().optional(),
    memory: MemoryOverrideSchema,
  })
  .strict();

export const ExperimentSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
    scenario: z.string().min(1),
    seed: z.number().int(),
    /** Path to the providers file, relative to the experiment file. Default: ./providers.yaml (cwd). */
    providers: z.string().optional(),
    agents: z.array(z.union([PolicyAgentSchema, ModelAgentSchema])).min(1),
  })
  .strict()
  .refine((e) => new Set(e.agents.map((a) => a.id)).size === e.agents.length, { message: "agent ids must be unique" });

export type ExperimentConfig = z.infer<typeof ExperimentSchema>;
export type AgentConfig = ExperimentConfig["agents"][number];
export type PolicyAgentConfig = z.infer<typeof PolicyAgentSchema>;
export type ModelAgentConfig = z.infer<typeof ModelAgentSchema>;

export const isPolicyAgent = (agent: AgentConfig): agent is PolicyAgentConfig => agent.provider === "policy";

export interface LoadedExperiment {
  config: ExperimentConfig;
  experimentId: string;
  /** Absolute path of the experiment file. */
  path: string;
  scenarioPath: string;
  providersPath: string;
}

export async function loadExperiment(path: string): Promise<LoadedExperiment> {
  const absolute = resolve(path);
  const result = ExperimentSchema.safeParse(parse(await readFile(absolute, "utf8")));
  if (!result.success) throw new ConfigError(`Invalid experiment ${path}:\n${z.prettifyError(result.error)}`);
  const config = result.data;
  const dir = dirname(absolute);
  return {
    config,
    experimentId: config.name ?? basename(absolute, extname(absolute)),
    path: absolute,
    scenarioPath: resolve(dir, config.scenario),
    providersPath: config.providers ? resolve(dir, config.providers) : resolve("providers.yaml"),
  };
}

/** Resolves a policy reference: built-in names stay as is, paths become absolute. */
export function resolvePolicyRef(policy: string, experimentPath: string): string {
  return /[./\\]/.test(policy) ? resolve(dirname(experimentPath), policy) : policy;
}
