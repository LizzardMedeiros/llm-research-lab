import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/models/errors.js";
import { OpenAICompatibleProvider, parseToolCall } from "../../src/models/openai-compatible.js";
import type { ModelRequest } from "../../src/models/types.js";

const request: ModelRequest = {
  model: "test-model",
  system: "sys",
  messages: [{ role: "user", content: "obs" }],
  tools: [{ name: "wait", description: "noop", inputSchema: { type: "object", properties: {} } }],
};

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (message: unknown, extra: object = {}) => ({
  status: 200,
  body: { model: "test-model", choices: [{ finish_reason: "tool_calls", message }], usage: { prompt_tokens: 10, completion_tokens: 3 }, ...extra },
});

const make = (fetchImpl: typeof fetch, extra: object = {}) =>
  new OpenAICompatibleProvider({
    endpoint: "local",
    baseUrl: "http://host/v1/",
    timeoutMs: 1000,
    defaultMaxTokens: 256,
    fetchImpl,
    sleep: async () => {},
    ...extra,
  });

describe("OpenAICompatibleProvider", () => {
  it("sends a single leading system message, tools and extra_body", async () => {
    const { impl, calls } = fakeFetch([ok({ content: "", tool_calls: [{ id: "c1", function: { name: "wait", arguments: "{}" } }] })]);
    await make(impl, { apiKey: "k", extraBody: { reasoning_effort: "none" } }).complete(request);

    const { url, body, headers } = calls[0]!;
    expect(url).toBe("http://host/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer k");
    expect(body.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "obs" }]);
    expect(body.tools[0].function.name).toBe("wait");
    expect(body.tool_choice).toBe("auto");
    expect(body.max_tokens).toBe(256);
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("temperature");
  });

  it("merges thinking_body over extra_body only on thinking requests", async () => {
    const { impl, calls } = fakeFetch([ok({ content: "", tool_calls: [{ id: "c1", function: { name: "wait", arguments: "{}" } }] })]);
    const provider = make(impl, { extraBody: { reasoning_effort: "none" }, thinkingBody: { reasoning_effort: "low", thinking_budget_tokens: 256 } });
    await provider.complete(request);
    await provider.complete({ ...request, thinking: true });
    expect(calls[0]!.body).toMatchObject({ reasoning_effort: "none" });
    expect(calls[0]!.body).not.toHaveProperty("thinking_budget_tokens");
    expect(calls[1]!.body).toMatchObject({ reasoning_effort: "low", thinking_budget_tokens: 256 });
  });

  it("normalizes the response", async () => {
    const { impl } = fakeFetch([ok({ content: "thinking aloud", tool_calls: [{ id: "c1", function: { name: "move", arguments: '{"direction":"north"}' } }] })]);
    const res = await make(impl).complete(request);
    expect(res.toolCalls).toEqual([{ id: "c1", name: "move", arguments: { direction: "north" }, rawArguments: '{"direction":"north"}' }]);
    expect(res.text).toBe("thinking aloud");
    expect(res.stopReason).toBe("tool_calls");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(res.servedModel).toBeUndefined();
  });

  it("retries configured statuses, then succeeds", async () => {
    const { impl, calls } = fakeFetch([{ status: 524, body: {} }, ok({ content: "hi" })]);
    const provider = make(impl, { retry: { statuses: [524], maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } });
    const res = await provider.complete(request);
    expect(calls).toHaveLength(2);
    expect(res.toolCalls).toEqual([]);
  });

  it("does not retry client errors", async () => {
    const { impl, calls } = fakeFetch([{ status: 400, body: { error: "bad" } }]);
    await expect(make(impl).complete(request)).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });
});

describe("reasoning field", () => {
  it("records server-exposed reasoning as model-reported, from either field name", async () => {
    for (const field of ["reasoning", "reasoning_content"]) {
      const { impl } = fakeFetch([ok({ content: "", [field]: "  I should move north.  ", tool_calls: [{ id: "c1", function: { name: "wait", arguments: "{}" } }] })]);
      const res = await make(impl).complete(request);
      expect(res.reasoning).toEqual({ type: "model_reported", source: "provider_reasoning_field", content: "I should move north." });
    }
    const { impl } = fakeFetch([ok({ content: "hi" })]);
    expect((await make(impl).complete(request)).reasoning).toBeUndefined();
  });
});

describe("parseToolCall", () => {
  it("treats empty arguments as {}", () => {
    expect(parseToolCall("wait", "  ").arguments).toEqual({});
  });
  it("returns null arguments for invalid JSON or non-objects", () => {
    expect(parseToolCall("move", "{direction: north").arguments).toBeNull();
    expect(parseToolCall("move", "[1]").arguments).toBeNull();
  });
});

describe("OpenAICompatibleProvider default fetch", () => {
  /** A local server that holds the response headers, like a non-streaming model server. */
  async function slowServer(delayMs: number) {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(ok({ content: "", tool_calls: [{ id: "c1", function: { name: "wait", arguments: "" } }] }).body));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const real = (baseUrl: string, timeoutMs: number) =>
    new OpenAICompatibleProvider({
      endpoint: "local",
      baseUrl,
      timeoutMs,
      defaultMaxTokens: 16,
      retry: { statuses: [], maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });

  it("waits for late headers within timeout_ms and fails past it", async () => {
    const server = await slowServer(150);
    try {
      expect((await real(server.baseUrl, 2_000).complete(request)).toolCalls[0]!.name).toBe("wait");
      await expect(real(server.baseUrl, 50).complete(request)).rejects.toThrow(ProviderError);
    } finally {
      await server.close();
    }
  });
});
