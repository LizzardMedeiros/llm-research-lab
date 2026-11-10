import type { ChatMessage, ModelProvider, ModelRequest } from "../models/types.js";
import type { Decider, Decision, DecisionInput, MemoryEntry } from "./types.js";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are an agent in a multi-agent grid world experiment.",
  "The world is a grid of cells addressed by (x, y); (0, 0) is the top-left corner, north is up.",
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
}

const renderObservation = (entry: { turn: number; observation: unknown }) =>
  `Turn ${entry.turn} observation:\n${JSON.stringify(entry.observation)}`;

const renderAction = (entry: MemoryEntry) => {
  if (!entry.action) return `(no action${entry.rejected ? `: ${entry.rejected}` : ""})`;
  const call = `${entry.action.name} ${JSON.stringify(entry.action.args)}`;
  return entry.rejected ? `${call} (rejected: ${entry.rejected})` : call;
};

/**
 * One user message per turn. Past turns go into a history block inside it,
 * never as assistant messages: replaying past actions as assistant *text*
 * teaches models to answer in text instead of calling a tool.
 */
export function buildPrompt(options: LlmAgentOptions, input: DecisionInput): Pick<ModelRequest, "system" | "messages"> {
  const system = [options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, options.goal ? `\nYour goal: ${options.goal}` : ""].join("");
  const parts: string[] = [];
  if (input.memory.length > 0) {
    parts.push(
      "Your recent history (oldest first):",
      ...input.memory.map((entry) => `${renderObservation(entry)}\nYour action: ${renderAction(entry)}`),
      "",
    );
  }
  parts.push(renderObservation(input), "", "Choose your action now by calling exactly one tool.");
  const messages: ChatMessage[] = [{ role: "user", content: parts.join("\n") }];
  return { system, messages };
}

export class LlmAgent implements Decider {
  readonly describe: Record<string, unknown>;

  constructor(private readonly options: LlmAgentOptions) {
    this.describe = { kind: "model", endpoint: options.provider.endpoint, model: options.model };
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const request: ModelRequest = {
      model: this.options.model,
      ...buildPrompt(this.options, input),
      tools: input.tools,
      temperature: this.options.temperature,
    };
    const events: Decision["events"] = [
      {
        type: "agent.model_request",
        payload: {
          endpoint: this.options.provider.endpoint,
          model: request.model,
          system: request.system,
          messages: request.messages,
          tools: request.tools.map((t) => t.name),
        },
      },
    ];

    let response;
    try {
      response = await this.options.provider.complete(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push({ type: "agent.model_error", payload: { endpoint: this.options.provider.endpoint, model: request.model, error: message } });
      return { call: null, error: `provider error: ${message}`, events };
    }

    events.push({ type: "agent.model_response", payload: { ...response } });
    const rationale = response.text.trim() || undefined;
    const first = response.toolCalls[0];
    if (!first) {
      return { call: null, error: `no tool call (stop reason: ${response.stopReason})`, rationale, events };
    }
    return {
      call: { name: first.name, args: first.arguments, rawArguments: first.rawArguments },
      rationale,
      events,
    };
  }
}
