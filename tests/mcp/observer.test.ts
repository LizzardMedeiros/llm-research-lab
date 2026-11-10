import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runExperiment } from "../../src/engine/runner.js";
import {
  agentHistory,
  experimentState,
  experimentSummary,
  listRunFiles,
  loadRun,
  parseEvents,
  recentEvents,
} from "../../src/mcp/run-reader.js";

let eventsDir: string;

beforeAll(async () => {
  eventsDir = mkdtempSync(join(tmpdir(), "lab-events-"));
  await runExperiment("experiments/first-contact-mock.yaml", { eventsDir });
  await runExperiment("experiments/first-contact-mock.yaml", { eventsDir });
});

describe("run reader", () => {
  it("lists runs and resolves references", () => {
    expect(listRunFiles(eventsDir).map((r) => r.ref).sort()).toEqual(["first-contact-mock/00001", "first-contact-mock/00002"]);
    expect(loadRun(eventsDir, "first-contact-mock/00001").runId).toBe("00001");
    expect(loadRun(eventsDir, "first-contact-mock").status).toBe("finished");
    expect(() => loadRun(eventsDir, "nope/00001")).toThrow(/not found. Available/);
  });

  it("reports a run still being written as running, ignoring a partial line", () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-live-"));
    const lines = readFileSync(join(eventsDir, "first-contact-mock/00001.jsonl"), "utf8").split("\n").slice(0, 40);
    const path = join(dir, "live");
    mkdirSync(path);
    writeFileSync(join(path, "00001.jsonl"), lines.join("\n") + "\n");
    appendFileSync(join(path, "00001.jsonl"), '{"event_id":"evt_partial","tur');
    const run = loadRun(dir, "live/00001");
    expect(run.status).toBe("running");
    expect(run.events).toHaveLength(40);
    expect(parseEvents('{"a":1}\n{"b"')).toEqual([{ a: 1 }]);
  });

  it("builds the state with a grid of positions", () => {
    const state = experimentState(loadRun(eventsDir, "first-contact-mock/00001"));
    expect(state).toMatchObject({ status: "finished", turn: 50, max_turns: 50, seed: 12345 });
    expect(state.grid).toHaveLength(5);
    expect(state.agents.map((a) => a.id)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    const positions = Object.values(state.snapshot.agents).map((a) => a.position);
    for (const [x, y] of positions) expect(state.grid[y]!.split(" ")[x]).toMatch(/a\d/);
  });

  it("filters recent events", () => {
    const result = recentEvents(loadRun(eventsDir), { types: ["environment.action_rejected"], agentId: "a5", limit: 3 });
    expect(result.events).toHaveLength(3);
    expect(result.events.every((e) => e.type === "environment.action_rejected" && e.agent_id === "a5")).toBe(true);
    expect(result.total_matching).toBeGreaterThan(3);
  });

  it("builds one row per turn for an agent", () => {
    const history = agentHistory(loadRun(eventsDir), "a5", 5);
    expect(history.turns).toHaveLength(5);
    expect(history.turns[0]).toMatchObject({ action: 'move {"direction":"north"}' });
    expect(history.agent).toMatchObject({ id: "a5", kind: "policy", policy: "repeat" });
    expect(() => agentHistory(loadRun(eventsDir), "zz")).toThrow(/Agents: a1/);
  });

  it("summarizes per-agent metrics", () => {
    const summary = experimentSummary(loadRun(eventsDir));
    const a5 = summary.agents.find((a) => a.id === "a5")!;
    expect(a5.decider).toBe("policy:repeat");
    expect(a5.actions).toEqual({ move: 50 });
    expect(a5.accepted_actions + Object.values(a5.rejections).reduce((s, n) => s + n, 0)).toBe(50);
    const a3 = summary.agents.find((a) => a.id === "a3")!;
    expect(a3.actions).toEqual({ observe: 50 });
    expect(a3.cells_visited).toBe(1);
  });
});

describe("MCP server (stdio)", () => {
  it("exposes the read-only tools and answers calls", async () => {
    const transport = new StdioClientTransport({
      command: "node_modules/.bin/tsx",
      args: ["src/mcp/observer-server.ts"],
      env: { ...process.env, LAB_EVENTS_DIR: eventsDir } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_agent_history",
        "get_experiment_state",
        "get_experiment_summary",
        "get_recent_events",
        "list_runs",
      ]);
      expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

      const runs = await client.callTool({ name: "list_runs", arguments: {} });
      const listed = JSON.parse((runs.content as Array<{ text: string }>)[0]!.text);
      expect(listed).toHaveLength(2);

      const missing = await client.callTool({ name: "get_agent_history", arguments: { agent_id: "zz" } });
      expect(missing.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
