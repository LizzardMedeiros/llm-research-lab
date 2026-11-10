import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/models/anthropic.js";
import { interpolateEnv, loadProvidersConfig, MissingEnvError, ProvidersConfigSchema } from "../../src/models/config.js";
import { OpenAICompatibleProvider } from "../../src/models/openai-compatible.js";
import { createProvider } from "../../src/models/registry.js";

describe("interpolateEnv", () => {
  it("expands variables and defaults", () => {
    expect(interpolateEnv("${A}/v1", { A: "http://x" })).toBe("http://x/v1");
    expect(interpolateEnv("${B:-http://d}/v1", {})).toBe("http://d/v1");
    expect(interpolateEnv("${B:-}", {})).toBe("");
  });
  it("fails on missing variables without default", () => {
    expect(() => interpolateEnv("${MISSING}", {})).toThrow(MissingEnvError);
  });
});

describe("providers.yaml", () => {
  it("is valid and every endpoint builds with its env", async () => {
    const config = await loadProvidersConfig("providers.yaml");
    const env = { GEMINI_API_KEY: "g", UMARAIZ_BASE_URL: "https://u/v1", UMARAIZ_API_KEY: "u" };
    for (const name of Object.keys(config.endpoints)) {
      expect(() => createProvider(config, name, { env })).not.toThrow();
    }
  });
});

describe("createProvider", () => {
  const config = ProvidersConfigSchema.parse({
    endpoints: {
      claude: { protocol: "anthropic", api_key: "${ANTHROPIC_API_KEY:-}" },
      local: { protocol: "openai-compatible", base_url: "${HOST:-http://h}/v1" },
      remote: { protocol: "openai-compatible", base_url: "http://r/v1", api_key: "${KEY}" },
    },
  });

  it("builds the adapter for each protocol", () => {
    expect(createProvider(config, "claude", { env: {} })).toBeInstanceOf(AnthropicProvider);
    expect(createProvider(config, "local", { env: {} })).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it("only requires env vars of the endpoint being used", () => {
    expect(() => createProvider(config, "local", { env: {} })).not.toThrow();
    expect(() => createProvider(config, "remote", { env: {} })).toThrow(/KEY/);
  });

  it("rejects unknown endpoints", () => {
    expect(() => createProvider(config, "nope")).toThrow(/Known: claude, local, remote/);
  });

  it("requires base_url for openai-compatible", () => {
    expect(() => ProvidersConfigSchema.parse({ endpoints: { x: { protocol: "openai-compatible" } } })).toThrow();
  });
});
