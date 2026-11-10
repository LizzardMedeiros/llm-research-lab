import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const RetrySchema = z
  .object({
    statuses: z.array(z.number().int()).optional(),
    max_attempts: z.number().int().min(1).optional(),
    base_delay_ms: z.number().int().min(0).optional(),
    max_delay_ms: z.number().int().min(0).optional(),
  })
  .strict();

const EndpointSchema = z
  .object({
    protocol: z.enum(["anthropic", "openai-compatible"]),
    base_url: z.string().optional(),
    api_key: z.string().optional(),
    timeout_ms: z.number().int().positive().default(300_000),
    max_tokens: z.number().int().positive().default(4096),
    retry: RetrySchema.optional(),
    extra_body: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine((e) => e.protocol !== "openai-compatible" || e.base_url, {
    message: "openai-compatible endpoints require base_url",
  });

export const ProvidersConfigSchema = z
  .object({ endpoints: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), EndpointSchema) })
  .strict();

export type EndpointConfig = z.infer<typeof EndpointSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

export const DEFAULT_PROVIDERS_FILE = "providers.yaml";

export async function loadProvidersConfig(path = DEFAULT_PROVIDERS_FILE): Promise<ProvidersConfig> {
  return ProvidersConfigSchema.parse(parse(await readFile(path, "utf8")));
}

export class MissingEnvError extends Error {}

/**
 * Expands `${VAR}` and `${VAR:-default}`. Called lazily, when an endpoint is
 * actually used, so running an experiment only requires the keys of the
 * endpoints it references.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (resolved !== undefined && resolved !== "") return resolved;
    if (fallback !== undefined) return fallback;
    throw new MissingEnvError(`Environment variable ${name} is not set`);
  });
}
