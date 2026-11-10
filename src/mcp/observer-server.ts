/**
 * Read-only MCP server over the run logs (stdio). Lets any MCP client act as
 * the Observer: it can inspect runs, never change them.
 *
 *   LAB_EVENTS_DIR=events tsx src/mcp/observer-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentHistory, experimentState, experimentSummary, listRunFiles, loadRun, recentEvents } from "./run-reader.js";
import { EVENT_TYPES } from "../events/event.js";

const eventsDir = process.env["LAB_EVENTS_DIR"] ?? "events";

const RUN = z
  .string()
  .optional()
  .describe('Run reference "<experiment_id>/<run_id>" (e.g. "first-contact-local/00002"), or just "<experiment_id>" for its latest run. Omit for the most recent run.');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/** Errors go back to the model as tool errors, not protocol failures. */
const safely =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return json(fn(args));
    } catch (error) {
      return { content: [{ type: "text" as const, text: (error as Error).message }], isError: true };
    }
  };

const server = new McpServer({ name: "llm-research-lab-observer", version: "0.1.0" });

server.registerTool(
  "list_runs",
  {
    title: "List runs",
    description: "List experiment runs, most recent first, with status (running, finished, failed) and progress.",
    inputSchema: { limit: z.number().int().positive().max(200).default(20) },
    annotations: READ_ONLY,
  },
  safely(({ limit }: { limit: number }) =>
    listRunFiles(eventsDir)
      .slice(0, limit)
      .map((info) => {
        const run = loadRun(eventsDir, info.ref);
        return { run: run.ref, status: run.status, turn: run.lastTurn, max_turns: run.maxTurns, modified_at: run.modifiedAt };
      }),
  ),
);

server.registerTool(
  "get_experiment_state",
  {
    title: "Experiment state",
    description:
      "Current state of a run: status, turn, scenario rules, agents (provider/model or policy, goal), and the world grid with agent positions (latest snapshot).",
    inputSchema: { run: RUN },
    annotations: READ_ONLY,
  },
  safely(({ run }: { run?: string }) => experimentState(loadRun(eventsDir, run))),
);

server.registerTool(
  "get_recent_events",
  {
    title: "Recent events",
    description: "Latest events of a run in compact form, optionally filtered by type, agent or starting turn.",
    inputSchema: {
      run: RUN,
      limit: z.number().int().positive().max(500).default(30),
      types: z.array(z.enum(EVENT_TYPES)).optional().describe("Only these event types."),
      agent_id: z.string().optional(),
      since_turn: z.number().int().min(0).optional(),
    },
    annotations: READ_ONLY,
  },
  safely(({ run, limit, types, agent_id, since_turn }: { run?: string; limit: number; types?: string[]; agent_id?: string; since_turn?: number }) =>
    recentEvents(loadRun(eventsDir, run), { limit, types, agentId: agent_id, sinceTurn: since_turn }),
  ),
);

server.registerTool(
  "get_agent_history",
  {
    title: "Agent history",
    description:
      "Turn-by-turn history of one agent: position, who shared its cell, what it heard or revealed, its action, model-reported rationale, rejections and model latency.",
    inputSchema: {
      run: RUN,
      agent_id: z.string(),
      last_turns: z.number().int().positive().optional().describe("Only the last N turns."),
    },
    annotations: READ_ONLY,
  },
  safely(({ run, agent_id, last_turns }: { run?: string; agent_id: string; last_turns?: number }) =>
    agentHistory(loadRun(eventsDir, run), agent_id, last_turns),
  ),
);

server.registerTool(
  "get_experiment_summary",
  {
    title: "Experiment summary",
    description:
      "Aggregated metrics per agent: actions, accepted vs rejected (by reason), cells visited, encounters, speech sent/received, and for model agents tool-call rate, latency and tokens.",
    inputSchema: { run: RUN },
    annotations: READ_ONLY,
  },
  safely(({ run }: { run?: string }) => experimentSummary(loadRun(eventsDir, run))),
);

await server.connect(new StdioServerTransport());
