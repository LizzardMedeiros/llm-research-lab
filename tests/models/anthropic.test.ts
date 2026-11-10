import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/models/anthropic.js";

function fakeClient(message: Partial<Anthropic.Message>) {
  const calls: any[] = [];
  const client = {
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        return { model: "claude-opus-5-5", stop_reason: "tool_use", usage: { input_tokens: 50, output_tokens: 8 }, content: [], ...message };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const make = (client: Anthropic) =>
  new AnthropicProvider({ endpoint: "claude", timeoutMs: 1000, defaultMaxTokens: 1000, maxRetries: 0, client });

describe("AnthropicProvider", () => {
  it("maps request and never sends temperature", async () => {
    const { client, calls } = fakeClient({});
    await make(client).complete({
      model: "claude-opus-5-5",
      system: "sys",
      messages: [{ role: "user", content: "obs" }],
      tools: [{ name: "wait", description: "noop", inputSchema: { type: "object", properties: {} } }],
      temperature: 0.7,
    });
    const params = calls[0];
    expect(params.system).toBe("sys");
    expect(params.max_tokens).toBe(1000);
    expect(params.tools[0]).toEqual({ name: "wait", description: "noop", input_schema: { type: "object", properties: {} } });
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params).not.toHaveProperty("temperature");
  });

  it("extracts tool calls, text and usage", async () => {
    const { client } = fakeClient({
      content: [
        { type: "text", text: "Heading north.", citations: null },
        { type: "tool_use", id: "t1", name: "move", input: { direction: "north" } },
      ] as Anthropic.ContentBlock[],
    });
    const res = await make(client).complete({ model: "claude-opus-5-5", system: "s", messages: [], tools: [] });
    expect(res.toolCalls).toEqual([{ id: "t1", name: "move", arguments: { direction: "north" }, rawArguments: '{"direction":"north"}' }]);
    expect(res.text).toBe("Heading north.");
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 8 });
  });

  it("surfaces refusals without tool calls", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [] });
    const res = await make(client).complete({ model: "claude-opus-5-5", system: "s", messages: [], tools: [] });
    expect(res.stopReason).toBe("refusal");
    expect(res.toolCalls).toEqual([]);
  });
});
