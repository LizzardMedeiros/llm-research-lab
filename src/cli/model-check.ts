/**
 * Checks whether a model can play in the lab: sends one standard turn and
 * verifies the response is exactly one valid tool call.
 *
 *   npm run model:check -- <endpoint> <model> [--repeat N]
 */
import { loadProvidersConfig } from "../models/config.js";
import { createProvider } from "../models/registry.js";
import type { ModelRequest, ModelResponse } from "../models/types.js";

const DIRECTIONS = ["north", "south", "east", "west"];

const request = (model: string): ModelRequest => ({
  model,
  system:
    "You are an agent in a grid world experiment. Each turn you receive an observation " +
    "and must act by calling exactly one of the available tools. Do not answer in plain text.",
  messages: [
    {
      role: "user",
      content: JSON.stringify({
        turn: 1,
        position: [2, 2],
        grid_size: [5, 5],
        cell: { type: "floor", agents: [] },
        messages: [],
        goal: "Reach the top-left corner of the grid.",
      }),
    },
  ],
  tools: [
    {
      name: "move",
      description: "Move one cell in a cardinal direction.",
      inputSchema: {
        type: "object",
        properties: { direction: { type: "string", enum: DIRECTIONS } },
        required: ["direction"],
        additionalProperties: false,
      },
    },
    {
      name: "wait",
      description: "Do nothing this turn.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
});

function verdict(response: ModelResponse): string | null {
  if (response.toolCalls.length === 0) return `no tool call (stop: ${response.stopReason})`;
  if (response.toolCalls.length > 1) return `${response.toolCalls.length} tool calls, expected 1`;
  const call = response.toolCalls[0]!;
  if (call.arguments === null) return `invalid JSON arguments: ${call.rawArguments}`;
  if (call.name === "wait") return null;
  if (call.name !== "move") return `unknown tool "${call.name}"`;
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
