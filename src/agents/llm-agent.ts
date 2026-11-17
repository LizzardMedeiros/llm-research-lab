import type { MemoryConfig } from "../config/scenario.js";
import { ProviderError } from "../models/errors.js";
import type { ChatMessage, ModelProvider, ModelRequest, ModelResponse, TurnRetryPolicy, TurnRetryReason } from "../models/types.js";
import { observationChanges } from "./history-diff.js";
import { conversationLines, factsSummary } from "./memory-summary.js";
import { observationMarkdown } from "./observation-md.js";
import type { Decider, Decision, DecisionInput, MemoryEntry } from "./types.js";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are an agent in a multi-agent grid world experiment.",
  "The world is a grid of cells. position is {x, y}: x is the column (grows to the east),",
  "y is the row (grows to the south). (0, 0) is the top-left corner; valid cells are",
  "0 <= x < grid_size.width and 0 <= y < grid_size.height. north is y - 1, east is x + 1.",
  "Each turn you receive an observation of what you can currently perceive.",
  "You act by calling exactly one of the available tools per turn. Do not answer in plain text only.",
  "You may write a short sentence explaining your choice before the tool call.",
].join("\n");

export interface LlmAgentOptions {
  agentId: string;
  provider: ModelProvider;
  model: string;
  goal: string;
  systemPrompt?: string;
  temperature?: number;
  memory: MemoryConfig;
  /** Scenario speak.free: speaking does not use the turn (speak + one other tool per response). */
  freeSpeech?: boolean;
}

const renderObservation = (entry: { turn: number; observation: unknown }) =>
  `Turn ${entry.turn} observation:\n${JSON.stringify(entry.observation)}`;

/** `speechInConversation`: the prompt quotes speech in its conversation section, so speak calls omit the text. */
const renderAction = (entry: MemoryEntry, speechInConversation = false) => {
  const speak = (args: Record<string, unknown>) =>
    speechInConversation ? "speak (text in the conversation)" : `speak ${JSON.stringify(args)}`;
  const speech = entry.speech ? ` + ${speak(entry.speech.args)}${entry.speech.rejected ? ` (rejected: ${entry.speech.rejected})` : ""}` : "";
  if (!entry.action) return `(no action${entry.rejected ? `: ${entry.rejected}` : ""})${speech}`;
  const call = entry.action.name === "speak" ? speak(entry.action.args) : `${entry.action.name} ${JSON.stringify(entry.action.args)}`;
  return (entry.rejected ? `${call} (rejected: ${entry.rejected})` : call) + speech;
};

export const FREE_SPEECH_INSTRUCTION = "Speaking does not use your turn: in the same response you may call speak and one other tool.";

const INPUT_BUDGET_RATIO = 0.9;
const PROMPT_TOKEN_ESTIMATE_OVERHEAD = 64;

export interface PromptBudget {
  contextTokens: number;
  outputTokens: number;
  inputTokenBudget: number;
  estimatedInputTokens: number;
  historyTurnsIncluded: number;
  historyTurnsDropped: number;
}

export interface BuiltPrompt extends Pick<ModelRequest, "system" | "messages"> {
  promptBudget: PromptBudget | null;
  /** Past turns rendered in full in the history block. */
  historyTurns: number;
}

export class PromptBudgetError extends Error {
  constructor(readonly estimatedInputTokens: number, readonly inputTokenBudget: number) {
    super(`estimated prompt size ${estimatedInputTokens} tokens exceeds input budget ${inputTokenBudget}`);
    this.name = "PromptBudgetError";
  }
}

/** Conservative provider-agnostic estimate; endpoint context limits remain authoritative. */
export function estimatePromptTokens(system: string, messages: ChatMessage[], tools: DecisionInput["tools"]): number {
  const serialized = JSON.stringify({ system, messages, tools });
  let ascii = 0;
  let nonAscii = 0;
  for (const character of serialized) {
    if (character.codePointAt(0)! < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 3 + nonAscii * 2) + PROMPT_TOKEN_ESTIMATE_OVERHEAD;
}

function renderPrompt(
  options: LlmAgentOptions,
  input: DecisionInput,
  recent: MemoryEntry[],
): Pick<ModelRequest, "system" | "messages"> {
  const system = [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, options.goal ? `\nYour goal: ${options.goal}` : ""].join("");
  const parts: string[] = [];
  if (options.memory.format === "structured") {
    parts.push(...renderStructured(options, input, recent));
  } else {
    parts.push(...renderClassic(options, input, recent));
  }
  parts.push(
    "",
    options.freeSpeech ? `Choose your action now by calling one tool. ${FREE_SPEECH_INSTRUCTION}` : "Choose your action now by calling exactly one tool.",
  );
  const messages: ChatMessage[] = [{ role: "user", content: parts.join("\n") }];
  return { system, messages };
}

/** classic: summary, past turns as full observations, current observation as JSON. */
function renderClassic(options: LlmAgentOptions, input: DecisionInput, recent: MemoryEntry[]): string[] {
  const parts: string[] = [];
  if (options.memory.summary === "facts") {
    parts.push("Summary of your experience so far (compiled from your own observations):", factsSummary(input.history, input.observation), "");
  }
  if (recent.length > 0) {
    parts.push(
      "Your recent history (oldest first):",
      ...recent.map((entry) => `${renderObservation(entry)}\nYour action: ${renderAction(entry)}`),
      "",
    );
  }
  parts.push(renderObservation(input));
  return parts;
}

/**
 * structured (plans/memory-format.md): one markdown document. Identity up
 * front (the diff no longer repeats agent_id), the facts summary, the
 * verbatim conversation, past turns as changes, and the current observation
 * as markdown. Speech text appears once, in the conversation.
 */
function renderStructured(options: LlmAgentOptions, input: DecisionInput, recent: MemoryEntry[]): string[] {
  const o = input.observation;
  const parts: string[] = [`You are agent ${o.agent_id}.`];
  const withConversation = options.memory.summary === "facts";
  // memory.now: json (A/B only): observations stay JSON; everything else as structured.
  const jsonNow = options.memory.now === "json";
  if (withConversation) {
    parts.push("", "## Summary of your own observations", factsSummary(input.history, o, "structured"));
    // Messages heard in the remembered turns stay in full (said the turn before they arrive).
    const keepFromTurn = recent.length ? recent[0]!.turn - 1 : o.turn;
    const { lines, omitted } = conversationLines(input.history, o, { includeCurrent: false, keepFromTurn });
    parts.push(
      "",
      `## Conversation (verbatim, oldest first${omitted ? `; ${omitted} earlier lines not shown` : ""}; messages delivered now are under "Now")`,
      ...(lines.length ? lines.map((l) => `- ${l}`) : ["- none yet"]),
    );
  }
  if (recent.length > 0) {
    const previous = new Map(input.history.map((entry, i) => [entry, input.history[i - 1]]));
    parts.push("", "## Recent turns (oldest first; what changed in your observation since your previous turn)");
    for (const entry of recent) {
      const prev = previous.get(entry);
      if (prev) {
        const changes = observationChanges(prev.observation, entry.observation, { messageText: !withConversation });
        parts.push(`- Turn ${entry.turn}: ${changes.length ? changes.join("; ") : "no change"}`);
      } else {
        parts.push(
          `- Turn ${entry.turn} (the first turn you remember):`,
          ...(jsonNow ? [`  ${JSON.stringify(entry.observation)}`] : observationMarkdown(entry.observation, { messages: !withConversation }).map((l) => `  ${l}`)),
        );
      }
      parts.push(`  - Your action: ${renderAction(entry, withConversation)}`);
    }
  }
  parts.push("", `## Now: turn ${o.turn} of ${o.max_turns}`, ...(jsonNow ? [JSON.stringify(o)] : observationMarkdown(o)));
  return parts;
}
/**
 * One user message per turn. Past turns go into a history block inside it,
 * never as assistant messages: replaying past actions as assistant *text*
 * teaches models to answer in text instead of calling a tool.
 */
export function buildPrompt(options: LlmAgentOptions, input: DecisionInput, maxHistory?: number): BuiltPrompt {
  const window = Math.min(options.memory.window, maxHistory ?? Infinity);
  const windowed = window > 0 ? input.history.slice(-window) : [];
  const contextTokens = options.provider.contextTokens;
  if (contextTokens === undefined) return { ...renderPrompt(options, input, windowed), promptBudget: null, historyTurns: windowed.length };

  const outputTokens = options.provider.maxOutputTokens ?? 4096;
  const inputTokenBudget = Math.floor(Math.max(0, contextTokens - outputTokens) * INPUT_BUDGET_RATIO);
  let recent = windowed;
  while (true) {
    const prompt = renderPrompt(options, input, recent);
    const estimatedInputTokens = estimatePromptTokens(prompt.system, prompt.messages, input.tools);
    if (estimatedInputTokens <= inputTokenBudget) {
      return {
        ...prompt,
        historyTurns: recent.length,
        promptBudget: {
          contextTokens,
          outputTokens,
          inputTokenBudget,
          estimatedInputTokens,
          historyTurnsIncluded: recent.length,
          historyTurnsDropped: windowed.length - recent.length,
        },
      };
    }
    if (recent.length === 0) throw new PromptBudgetError(estimatedInputTokens, inputTokenBudget);
    recent = recent.slice(1);
  }
}

export class LlmAgent implements Decider {
  readonly describe: Record<string, unknown>;

  constructor(private readonly options: LlmAgentOptions) {
    this.describe = { kind: "model", endpoint: options.provider.endpoint, model: options.model, memory: options.memory };
  }

  /**
   * One action per turn, but possibly several model calls: a failure listed
   * in the endpoint's `turn_retry` is retried within the turn (context
   * overflow with less history, truncated output as is). Every attempt is
   * logged; only the last response becomes the turn's decision.
   */
  async decide(input: DecisionInput): Promise<Decision> {
    const { provider } = this.options;
    const policy: TurnRetryPolicy = provider.turnRetry ?? { maxAttempts: 1, on: [] };
    const events: Decision["events"] = [];
    let maxHistory: number | undefined;
    let retryReason: TurnRetryReason | undefined;

    for (let attempt = 1; ; attempt++) {
      const retrying = attempt > 1 ? { attempt, retryReason } : {};
      const canRetry = (reason: TurnRetryReason) => attempt < policy.maxAttempts && policy.on.includes(reason);

      let prompt: BuiltPrompt;
      try {
        prompt = buildPrompt(this.options, input, maxHistory);
      } catch (error) {
        if (!(error instanceof PromptBudgetError)) throw error;
        events.push({
          type: "agent.model_error",
          payload: { endpoint: provider.endpoint, model: this.options.model, error: error.message, reason: "prompt_budget_exceeded", ...retrying },
        });
        return { call: null, error: `prompt budget error: ${error.message}`, events };
      }

      const { promptBudget, historyTurns, ...promptFields } = prompt;
      const request: ModelRequest = {
        model: this.options.model,
        ...promptFields,
        tools: input.tools,
        temperature: this.options.temperature,
        ...(this.options.freeSpeech ? { parallelToolCalls: true } : {}),
        ...(input.thinking ? { thinking: true } : {}),
      };
      events.push({
        type: "agent.model_request",
        payload: {
          endpoint: provider.endpoint,
          model: request.model,
          system: request.system,
          messages: request.messages,
          tools: request.tools.map((t) => t.name),
          ...(promptBudget ? { promptBudget } : {}),
          ...(request.thinking ? { thinking: true } : {}),
          ...retrying,
        },
      });

      let response: ModelResponse;
      try {
        response = await provider.complete(request);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const overflow = isContextOverflow(error);
        events.push({
          type: "agent.model_error",
          payload: { endpoint: provider.endpoint, model: request.model, error: message, ...(overflow ? { reason: "context_overflow" } : {}), ...retrying },
        });
        if (overflow && historyTurns > 0 && canRetry("context_overflow")) {
          maxHistory = Math.floor(historyTurns / 2);
          retryReason = "context_overflow";
          continue;
        }
        return { call: null, error: `provider error: ${message}`, events };
      }

      events.push({ type: "agent.model_response", payload: { ...response } });
      if (isTruncatedWithoutCall(response) && canRetry("output_truncated")) {
        retryReason = "output_truncated";
        continue;
      }
      const rationale = response.text.trim() || undefined;
      const first = response.toolCalls[0];
      if (!first) {
        return { call: null, error: `no tool call (stop reason: ${response.stopReason})`, rationale, events };
      }
      const calls = response.toolCalls.map((c) => ({ name: c.name, args: c.arguments, rawArguments: c.rawArguments }));
      return {
        call: calls[0]!,
        ...(calls.length > 1 ? { calls } : {}),
        rationale,
        events,
      };
    }
  }
}

const CONTEXT_OVERFLOW = /context[ _](length|size|window)|exceed_context|prompt is too long|too many tokens|maximum context/i;

/** The server refused the prompt as larger than the model's context. */
export function isContextOverflow(error: unknown): boolean {
  return error instanceof ProviderError && (error.status === 400 || error.status === 413) && CONTEXT_OVERFLOW.test(error.message);
}

const TRUNCATED = new Set(["length", "max_tokens"]);

/** The completion hit max tokens before producing a parseable tool call. */
export function isTruncatedWithoutCall(response: ModelResponse): boolean {
  return TRUNCATED.has(response.stopReason) && (response.toolCalls.length === 0 || response.toolCalls.some((c) => c.arguments === null));
}
