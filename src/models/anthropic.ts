import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "./errors.js";
import type { ModelProvider, ModelRequest, ModelResponse, ToolCall } from "./types.js";

export interface AnthropicOptions {
  endpoint: string;
  /** Falls back to the SDK's own credential resolution when omitted. */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  defaultMaxTokens: number;
  /** SDK retries (408/409/429/5xx and connection errors). */
  maxRetries: number;
  /** Merged into every request (e.g. `output_config: { effort: "low" }`). */
  extraBody?: Record<string, unknown>;
  client?: Anthropic;
}

/**
 * Claude via the official SDK.
 *
 * - `temperature` is never sent: current API versions reject sampling params.
 * - `tool_choice` stays `auto`: forced tool use is rejected on current models.
 *   A turn without a tool call is rejected by the engine (becomes `wait`).
 * - No server-side refusal fallback: a fallback would answer with a
 *   different model and corrupt per-agent attribution. A refusal surfaces as
 *   `stopReason: "refusal"` with no tool call, and is logged as such.
 */
export class AnthropicProvider implements ModelProvider {
  readonly endpoint: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicOptions) {
    this.endpoint = options.endpoint;
    this.client =
      options.client ??
      new Anthropic({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        timeout: options.timeoutMs,
        maxRetries: options.maxRetries,
      });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? this.options.defaultMaxTokens,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
            tool_choice: { type: "auto" as const },
          }
        : {}),
      ...(this.options.extraBody as Partial<Anthropic.MessageCreateParamsNonStreaming> | undefined),
    };

    const started = performance.now();
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(params);
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ProviderError(error.message, this.endpoint, error.status);
      }
      throw new ProviderError(String(error), this.endpoint);
    }
    const latencyMs = Math.round(performance.now() - started);

    const toolCalls: ToolCall[] = [];
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const input = block.input;
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments:
            input !== null && typeof input === "object" && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : null,
          rawArguments: JSON.stringify(input),
        });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }

    return {
      endpoint: this.endpoint,
      model: request.model,
      ...(message.model !== request.model ? { servedModel: message.model } : {}),
      toolCalls,
      text: texts.join("\n"),
      stopReason: (message.stop_reason ?? "unknown").toLowerCase(),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      latencyMs,
    };
  }
}
