import { ProviderError } from "./errors.js";
import { DEFAULT_RETRY, withRetry, type RetryPolicy, type Sleep } from "./retry.js";
import type { ModelProvider, ModelRequest, ModelResponse, ToolCall } from "./types.js";

export interface OpenAICompatibleOptions {
  endpoint: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  defaultMaxTokens: number;
  /** Merged into every request body (e.g. `reasoning_effort: "none"`). */
  extraBody?: Record<string, unknown>;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string | null };
      }> | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Chat Completions protocol. Covers llama.cpp (Bonsai), Ollama (/v1),
 * Gemini's OpenAI-compatible endpoint, umaraiz, vLLM, OpenRouter, OpenAI...
 *
 * Request shape is deliberately conservative so it works on the strictest
 * servers: exactly one system message, first (Bonsai's template rejects
 * anything else), and no tool results are ever replayed.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: [{ role: "system", content: request.system }, ...request.messages],
      max_tokens: request.maxTokens ?? this.options.defaultMaxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...this.options.extraBody,
    };

    const started = performance.now();
    const json = await withRetry(
      () => this.post(body),
      this.options.retry ?? DEFAULT_RETRY,
      this.options.sleep,
    );
    const latencyMs = Math.round(performance.now() - started);

    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new ProviderError("Response has no choices[0].message", this.endpoint);
    }
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((call) =>
      parseToolCall(call.function?.name ?? "", call.function?.arguments ?? "", call.id),
    );

    return {
      endpoint: this.endpoint,
      model: request.model,
      ...(json.model && json.model !== request.model ? { servedModel: json.model } : {}),
      toolCalls,
      text: choice.message.content ?? "",
      stopReason: (choice.finish_reason ?? "unknown").toLowerCase(),
      usage: {
        ...(json.usage?.prompt_tokens !== undefined ? { inputTokens: json.usage.prompt_tokens } : {}),
        ...(json.usage?.completion_tokens !== undefined ? { outputTokens: json.usage.completion_tokens } : {}),
      },
      latencyMs,
    };
  }

  private async post(body: Record<string, unknown>): Promise<ChatCompletionResponse> {
    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`Request to ${url} failed: ${String(error)}`, this.endpoint, undefined, true);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new ProviderError(`HTTP ${response.status} from ${url}: ${detail}`, this.endpoint, response.status);
    }
    return (await response.json()) as ChatCompletionResponse;
  }
}

/** Empty arguments mean "no arguments" (llama.cpp returns "" for them). */
export function parseToolCall(name: string, rawArguments: string, id?: string): ToolCall {
  let parsed: Record<string, unknown> | null = null;
  if (rawArguments.trim() === "") {
    parsed = {};
  } else {
    try {
      const value: unknown = JSON.parse(rawArguments);
      parsed = value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      parsed = null;
    }
  }
  return { ...(id ? { id } : {}), name, arguments: parsed, rawArguments };
}
