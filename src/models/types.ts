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

export interface ModelProvider {
  readonly endpoint: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
