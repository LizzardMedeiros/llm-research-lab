import { describe, expect, it, vi } from "vitest";
import { buildPrompt, estimatePromptTokens, isContextOverflow, isTruncatedWithoutCall, LlmAgent } from "../../src/agents/llm-agent.js";
import type { DecisionInput, MemoryEntry } from "../../src/agents/types.js";
import type { Observation } from "../../src/mechanics/perception.js";
import { ProviderError } from "../../src/models/errors.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/models/types.js";

const observation = (turn: number): Observation => ({
  turn,
  max_turns: 50,
  agent_id: "a1",
  position: { x: 0, y: 0 },
  grid_size: { width: 1, height: 1 },
  cell: { type: "floor", agents: [] },
  messages: [],
  last_action_error: null,
  available_actions: ["wait", "speak"],
});

const tools: DecisionInput["tools"] = [
  { name: "wait", description: "Wait.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

const history: MemoryEntry[] = [1, 2, 3].map((turn) => ({
  turn,
  observation: observation(turn),
  action: { name: "speak", args: { text: `marker-${turn} ${"x".repeat(800)}` } },
  rejected: null,
}));

const input: DecisionInput = { turn: 4, observation: observation(4), tools, history };

const options = (provider: ModelProvider, window = 3, format: "classic" | "structured" = "classic") => ({
  agentId: "a1",
  provider,
  model: "test-model",
  goal: "Keep running.",
  systemPrompt: "Scenario rules.",
  memory: { window, summary: "facts" as const, format },
});

describe("buildPrompt", () => {
  it("structured: past turns as changes since the previous turn; the oldest without one in full", () => {
    const provider: ModelProvider = { endpoint: "test", complete: vi.fn() };
    const moved: MemoryEntry[] = history.map((entry) =>
      entry.turn === 3 ? { ...entry, observation: { ...entry.observation, messages: [{ from: "a2", text: "hi", turn: 2 }] } } : entry,
    );
    const content = buildPrompt(options(provider, 3, "structured"), { ...input, history: moved }).messages[0]!.content;
    expect(content.startsWith("You are agent a1.\n")).toBe(true);
    expect(content).toContain("Turn 1 observation:\n{"); // no previous turn: full observation
    expect(content).toContain("Turn 2: no change\nYour action: speak");
    expect(content).toContain('Turn 3: heard a2 (said on turn 2): "hi"\nYour action: speak');
    expect(content).toContain("Turn 4 observation:\n{"); // the current observation stays in full
    expect(content).not.toContain("Turn 2 observation");

    // A window that starts later still diffs against the turn before it.
    const windowed = buildPrompt(options(provider, 1, "structured"), { ...input, history: moved }).messages[0]!.content;
    expect(windowed).toContain('Turn 3: heard a2');
    expect(windowed).not.toContain("Turn 1 observation");
  });

  it("drops oldest full turns to fit while retaining the facts summary and current observation", () => {
    const unlimited: ModelProvider = { endpoint: "test", complete: vi.fn() };
    const full = buildPrompt(options(unlimited), input);
    const newest = buildPrompt(options(unlimited, 1), input);
    const fullEstimate = estimatePromptTokens(full.system, full.messages, tools);
    const newestEstimate = estimatePromptTokens(newest.system, newest.messages, tools);
    const targetBudget = Math.floor((fullEstimate + newestEstimate) / 2);
    const contextTokens = Math.ceil(targetBudget / 0.9 + 128);

    const prompt = buildPrompt(options({
      endpoint: "test",
      contextTokens,
      maxOutputTokens: 128,
      complete: vi.fn(),
    }), input);
    const content = prompt.messages[0]!.content;

    expect(prompt.promptBudget?.historyTurnsDropped).toBeGreaterThan(0);
    expect(content).toContain("marker-3");
    expect(content).not.toContain("marker-1");
    expect(content).toContain("Your 3 past turns");
    expect(content).toContain("Turn 4 observation");
  });

  it("fails explicitly when mandatory prompt content exceeds the available input budget", async () => {
    const provider: ModelProvider = {
      endpoint: "test",
      contextTokens: 100,
      maxOutputTokens: 50,
      complete: vi.fn(),
    };
    const agent = new LlmAgent({
      ...options(provider, 0),
      systemPrompt: "Mandatory rules. ".repeat(100),
    });

    const decision = await agent.decide(input);

    expect(decision.call).toBeNull();
    expect(decision.error).toContain("prompt budget error");
    expect(decision.events[0]).toMatchObject({
      type: "agent.model_error",
      payload: { reason: "prompt_budget_exceeded" },
    });
    expect(provider.complete).not.toHaveBeenCalled();
  });
});

const response = (overrides: Partial<ModelResponse> = {}): ModelResponse => ({
  endpoint: "test",
  model: "test-model",
  toolCalls: [{ name: "wait", arguments: {}, rawArguments: "{}" }],
  text: "",
  stopReason: "tool_calls",
  usage: {},
  latencyMs: 1,
  ...overrides,
});

const overflow = () => new ProviderError("HTTP 400 from x: the request exceeds the available context size", "test", 400);

describe("LlmAgent turn retry", () => {
  const withRetry = (complete: ModelProvider["complete"], turnRetry?: ModelProvider["turnRetry"]): ModelProvider => ({
    endpoint: "test",
    ...(turnRetry ? { turnRetry } : {}),
    complete,
  });
  const policy = { maxAttempts: 3, on: ["context_overflow" as const, "output_truncated" as const] };

  it("retries a context overflow with less history and returns a single action", async () => {
    const complete = vi.fn().mockRejectedValueOnce(overflow()).mockResolvedValueOnce(response());
    const decision = await new LlmAgent(options(withRetry(complete, policy))).decide(input);

    expect(complete).toHaveBeenCalledTimes(2);
    const [first, second] = complete.mock.calls.map(([request]) => (request as ModelRequest).messages[0]!.content);
    expect(first).toContain("marker-1");
    expect(second).not.toContain("marker-1");
    expect(second).toContain("marker-3");
    expect(decision.call).toMatchObject({ name: "wait" });
    expect(decision.error).toBeUndefined();
    expect(decision.events.map((e) => e.type)).toEqual([
      "agent.model_request",
      "agent.model_error",
      "agent.model_request",
      "agent.model_response",
    ]);
    expect(decision.events[1]!.payload).toMatchObject({ reason: "context_overflow" });
    expect(decision.events[2]!.payload).toMatchObject({ attempt: 2, retryReason: "context_overflow" });
  });

  it("retries a completion truncated before a usable tool call", async () => {
    const truncated = response({ toolCalls: [{ name: "speak", arguments: null, rawArguments: '{"text": "unfini' }], stopReason: "length" });
    const complete = vi.fn().mockResolvedValueOnce(truncated).mockResolvedValueOnce(response());
    const decision = await new LlmAgent(options(withRetry(complete, policy))).decide(input);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(decision.call).toMatchObject({ name: "wait" });
    expect(decision.calls).toBeUndefined();
  });

  it("stops at max attempts and keeps the last failure as the turn's error", async () => {
    const complete = vi.fn().mockResolvedValue(response({ toolCalls: [], text: "...", stopReason: "length" }));
    const decision = await new LlmAgent(options(withRetry(complete, policy))).decide(input);

    expect(complete).toHaveBeenCalledTimes(3);
    expect(decision.call).toBeNull();
    expect(decision.error).toContain("no tool call");
  });

  it("does not retry ineligible failures", async () => {
    const http500 = vi.fn().mockRejectedValue(new ProviderError("HTTP 500 from x: boom", "test", 500));
    expect((await new LlmAgent(options(withRetry(http500, policy))).decide(input)).error).toContain("provider error");
    expect(http500).toHaveBeenCalledTimes(1);

    const noCall = vi.fn().mockResolvedValue(response({ toolCalls: [], text: "I think...", stopReason: "stop" }));
    await new LlmAgent(options(withRetry(noCall, policy))).decide(input);
    expect(noCall).toHaveBeenCalledTimes(1);
  });

  it("only retries reasons the endpoint enables, and never without a policy", async () => {
    const onlyTruncation = vi.fn().mockRejectedValue(overflow());
    await new LlmAgent(options(withRetry(onlyTruncation, { maxAttempts: 3, on: ["output_truncated"] }))).decide(input);
    expect(onlyTruncation).toHaveBeenCalledTimes(1);

    const noPolicy = vi.fn().mockRejectedValue(overflow());
    await new LlmAgent(options(withRetry(noPolicy))).decide(input);
    expect(noPolicy).toHaveBeenCalledTimes(1);
  });

  it("gives up on overflow once no history is left to drop", async () => {
    const complete = vi.fn().mockRejectedValue(overflow());
    const decision = await new LlmAgent(options(withRetry(complete, { maxAttempts: 10, on: ["context_overflow"] }))).decide(input);

    // window 3 -> 1 -> 0, then nothing left to drop.
    expect(complete).toHaveBeenCalledTimes(3);
    expect(decision.error).toContain("context size");
  });
});

describe("retry classification", () => {
  it("recognizes context overflow messages from the supported servers", () => {
    expect(isContextOverflow(overflow())).toBe(true);
    expect(isContextOverflow(new ProviderError("prompt is too long: 210000 tokens > 200000 maximum", "a", 400))).toBe(true);
    expect(isContextOverflow(new ProviderError("This model's maximum context length is 8192 tokens", "o", 400))).toBe(true);
    expect(isContextOverflow(new ProviderError("invalid tool schema", "o", 400))).toBe(false);
    expect(isContextOverflow(new ProviderError("context length", "o", 500))).toBe(false);
  });

  it("treats only max-token stops without a parseable call as truncated", () => {
    expect(isTruncatedWithoutCall(response({ toolCalls: [], stopReason: "max_tokens" }))).toBe(true);
    expect(isTruncatedWithoutCall(response({ stopReason: "length" }))).toBe(false);
    expect(isTruncatedWithoutCall(response({ toolCalls: [], stopReason: "stop" }))).toBe(false);
  });
});
