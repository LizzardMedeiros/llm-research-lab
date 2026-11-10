/**
 * Checks whether a model can play in the lab: sends turn 1 exactly as the
 * engine would (default prompt, standard actions) and verifies the response
 * is exactly one valid tool call.
 *
 *   npm run model:check -- <endpoint> <model> [--repeat N]
 */
import { createStandardActions } from "../actions/standard.js";
import { buildPrompt } from "../agents/llm-agent.js";
import { loadProvidersConfig } from "../models/config.js";
import { createProvider } from "../models/registry.js";
import type { ModelRequest, ModelResponse } from "../models/types.js";

const DIRECTIONS = ["north", "south", "east", "west"];
const TOOLS = createStandardActions({
  move: { directions: "cardinal" },
  speak: { range: "same_cell", delivery: "next_turn", max_length: 280 },
  observe: { reveals: "neighbors_8" },
  wait: {},
}).map((a) => a.tool);

/** Same prompt and tools an agent gets on turn 1 of an experiment. */
const request = (model: string): ModelRequest => ({
  model,
  ...buildPrompt(
    { agentId: "a1", provider: { endpoint: "check" } as never, model, goal: "Reach the top-left corner of the grid.", memory: { window: 0, summary: "none" } },
    {
      turn: 1,
      tools: TOOLS,
      history: [],
      observation: {
        turn: 1,
        agent_id: "a1",
        position: { x: 2, y: 2 },
        grid_size: { width: 5, height: 5 },
        cell: { type: "floor", agents: [] },
        messages: [],
        last_action_error: null,
        available_actions: TOOLS.map((t) => t.name),
      },
    },
  ),
  tools: TOOLS,
});

function verdict(response: ModelResponse): string | null {
  if (response.toolCalls.length === 0) return `no tool call (stop: ${response.stopReason})`;
  if (response.toolCalls.length > 1) return `${response.toolCalls.length} tool calls, expected 1`;
  const call = response.toolCalls[0]!;
  if (call.arguments === null) return `invalid JSON arguments: ${call.rawArguments}`;
  if (!TOOLS.some((t) => t.name === call.name)) return `unknown tool "${call.name}"`;
  if (call.name === "speak" && typeof call.arguments["text"] !== "string") return "speak without text";
  if (call.name !== "move") return null;
  const direction = call.arguments["direction"];
  if (typeof direction !== "string" || !DIRECTIONS.includes(direction)) {
    return `invalid direction: ${JSON.stringify(direction)}`;
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const repeatIndex = args.indexOf("--repeat");
  const repeat = repeatIndex >= 0 ? Number(args.splice(repeatIndex, 2)[1]) : 1;
  const [endpoint, model] = args;
  if (!endpoint || !model || !Number.isInteger(repeat) || repeat < 1) {
    console.error("Usage: npm run model:check -- <endpoint> <model> [--repeat N]");
    process.exit(2);
  }

  const provider = createProvider(await loadProvidersConfig(), endpoint);
  let passed = 0;
  for (let i = 1; i <= repeat; i++) {
    try {
      const response = await provider.complete(request(model));
      const problem = verdict(response);
      const call = response.toolCalls[0];
      const shown = call ? `${call.name} ${call.rawArguments}` : JSON.stringify(response.text.slice(0, 120));
      const tokens = `${response.usage.inputTokens ?? "?"}/${response.usage.outputTokens ?? "?"} tok`;
      console.log(`[${i}] ${problem ? "FAIL" : "OK  "} ${response.latencyMs} ms, ${tokens}: ${shown}${problem ? ` — ${problem}` : ""}`);
      if (!problem) passed++;
    } catch (error) {
      console.log(`[${i}] ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`${endpoint}/${model}: ${passed}/${repeat} valid tool calls`);
  process.exit(passed === repeat ? 0 : 1);
}

await main();
