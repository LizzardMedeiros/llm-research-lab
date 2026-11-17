/**
 * Provider-agnostic model interface.
 *
 * The engine makes exactly one request per agent turn: the agent's memory
 * window is rendered into `messages`, the enabled actions are offered as
 * `tools`, and the response is expected to contain one tool call. Tool
 * results are never sent back to the model within a turn, so adapters do not
 * need a tool-calling loop.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool arguments (an object schema). */
  inputSchema: JsonSchema;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  /** Ignored by providers that do not accept sampling parameters. */
  temperature?: number;
  maxTokens?: number;
  /** Allow more than one tool call in the response (free speech). */
  parallelToolCalls?: boolean;
  /** The scenario asks this agent to think this turn; endpoints apply their thinking_body (others ignore it). */
  thinking?: boolean;
}

export interface ToolCall {
  id?: string;
  name: string;
  /** Parsed arguments, or `null` when the model produced invalid JSON. */
  arguments: Record<string, unknown> | null;
  /** Arguments exactly as returned by the provider, for the event log. */
  rawArguments: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelResponse {
  endpoint: string;
  /** Model name requested by the experiment. */
  model: string;
  /** Model name reported by the server, when it differs or is more specific. */
  servedModel?: string;
  toolCalls: ToolCall[];
  /** Free text returned alongside (or instead of) tool calls. */
  text: string;
  /** Provider stop reason, normalized to lower case (e.g. "tool_use", "stop", "refusal"). */
  stopReason: string;
  /**
   * Reasoning text the server returned in a separate field (e.g. Ollama
   * `reasoning`, llama.cpp `reasoning_content`). It is what the provider
   * exposed, model-reported: never a capture of internal reasoning.
   */
  reasoning?: { type: "model_reported"; source: "provider_reasoning_field"; content: string };
  usage: ModelUsage;
  latencyMs: number;
}

/**
 * Failures that may be retried within the same agent turn:
 * - context_overflow: the server rejected the prompt as too long; the retry
 *   drops older history turns;
 * - output_truncated: the completion hit max tokens before a usable tool call.
 */
export const TURN_RETRY_REASONS = ["context_overflow", "output_truncated"] as const;
export type TurnRetryReason = (typeof TURN_RETRY_REASONS)[number];

export interface TurnRetryPolicy {
  /** Model calls per agent turn, including the first. */
  maxAttempts: number;
  on: TurnRetryReason[];
}

export interface ModelProvider {
  readonly endpoint: string;
  /** Server/model context window when configured for this endpoint. */
  readonly contextTokens?: number;
  /** Configured maximum completion size. */
  readonly maxOutputTokens?: number;
  /** Extra model calls allowed within one agent turn (endpoint `turn_retry`). */
  readonly turnRetry?: TurnRetryPolicy;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
