import type { ModelProvider, ModelRequest, ModelResponse, ToolCall } from "./types.js";

export type MockReply = { tool: string; args?: Record<string, unknown> } | { text: string };

/**
 * Internal provider for engine unit tests: replays a fixed list of replies,
 * one per call, and records every request it receives.
 * Experiments should use `policy` agents instead.
 */
export class MockProvider implements ModelProvider {
  readonly endpoint = "mock";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly replies: MockReply[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const reply = this.replies[Math.min(this.index++, this.replies.length - 1)] ?? { text: "" };
    const toolCalls: ToolCall[] =
      "tool" in reply
        ? [{ name: reply.tool, arguments: reply.args ?? {}, rawArguments: JSON.stringify(reply.args ?? {}) }]
        : [];
    return {
      endpoint: this.endpoint,
      model: request.model,
      toolCalls,
      text: "text" in reply ? reply.text : "",
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: {},
      latencyMs: 0,
    };
  }
}
