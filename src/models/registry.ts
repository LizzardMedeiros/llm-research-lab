import { AnthropicProvider } from "./anthropic.js";
import { interpolateEnv, type ProvidersConfig } from "./config.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { DEFAULT_RETRY, type RetryPolicy, type Sleep } from "./retry.js";
import type { ModelProvider } from "./types.js";

export interface RegistryDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

/**
 * Builds the provider for a named endpoint from providers.yaml.
 * Agents choose `provider: <endpoint>` and `model: <name>` independently, so
 * the same endpoint serves any number of models.
 */
export function createProvider(config: ProvidersConfig, endpoint: string, deps: RegistryDeps = {}): ModelProvider {
  const entry = config.endpoints[endpoint];
  if (!entry) {
    const known = Object.keys(config.endpoints).join(", ");
    throw new Error(`Unknown provider endpoint "${endpoint}". Known: ${known}`);
  }
  const env = deps.env ?? process.env;
  const resolve = (value: string | undefined) => (value === undefined ? undefined : interpolateEnv(value, env));
  const apiKey = resolve(entry.api_key) || undefined;
  const baseUrl = resolve(entry.base_url) || undefined;

  const retry: RetryPolicy = {
    statuses: entry.retry?.statuses ?? DEFAULT_RETRY.statuses,
    maxAttempts: entry.retry?.max_attempts ?? DEFAULT_RETRY.maxAttempts,
    baseDelayMs: entry.retry?.base_delay_ms ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: entry.retry?.max_delay_ms ?? DEFAULT_RETRY.maxDelayMs,
  };

  switch (entry.protocol) {
    case "anthropic":
      return new AnthropicProvider({
        endpoint,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        timeoutMs: entry.timeout_ms,
        defaultMaxTokens: entry.max_tokens,
        maxRetries: retry.maxAttempts - 1,
        ...(entry.extra_body ? { extraBody: entry.extra_body } : {}),
      });
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        endpoint,
        baseUrl: baseUrl!, // required by the schema
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: entry.timeout_ms,
        defaultMaxTokens: entry.max_tokens,
        retry,
        ...(entry.extra_body ? { extraBody: entry.extra_body } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
  }
}
