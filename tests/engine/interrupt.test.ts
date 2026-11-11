import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { interruptActiveRuns, runExperiment } from "../../src/engine/runner.js";
import { MemorySink } from "../../src/events/event.js";
import { loadRun } from "../../src/mcp/run-reader.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/models/types.js";

/** A provider that answers only when released, so a run can be caught mid-turn. */
function blockingProvider() {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const provider: ModelProvider = {
    endpoint: "slow",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      await released;
      return { endpoint: "slow", model: request.model, toolCalls: [{ name: "wait", arguments: {}, rawArguments: "{}" }], text: "", stopReason: "tool_use", usage: {}, latencyMs: 0 };
    },
  };
  return { provider, release };
}

describe("interruption", () => {
  it("records experiment.interrupted, closes the log and stops the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lab-int-"));
    writeFileSync(
      join(dir, "scenario.yaml"),
      JSON.stringify({ scenario: "t", map: "...\n", legend: { ".": { type: "floor" } }, actions: { wait: {} }, rules: { end: { max_turns: 5 } } }),
    );
    writeFileSync(join(dir, "experiment.yaml"), JSON.stringify({ scenario: "scenario.yaml", seed: 1, agents: [{ id: "a", provider: "slow", model: "m" }] }));
    const { provider, release } = blockingProvider();
    const sink = new MemorySink();
    const running = runExperiment(join(dir, "experiment.yaml"), { sink, providerFactory: () => provider });

    while (!sink.events.some((e) => e.type === "agent.observation")) await new Promise((r) => setTimeout(r, 5));
    interruptActiveRuns("SIGTERM", { exit: false });
    release();
    const summary = await running;

    expect(summary.reason).toBe("interrupted");
    const last = sink.events.at(-1)!;
    expect(last).toMatchObject({ type: "experiment.interrupted", turn: 1, payload: { signal: "SIGTERM", last_turn: 1 } });
    expect(sink.events.some((e) => e.type === "experiment.finished")).toBe(false);
    // Nothing is recorded after the interruption (the pending decision is dropped).
    expect(sink.events.filter((e) => e.type === "agent.action")).toEqual([]);
  });
});

describe("run status in the reader", () => {
  function writeRun(lines: object[]) {
    const eventsDir = mkdtempSync(join(tmpdir(), "lab-status-"));
    mkdirSync(join(eventsDir, "x"));
    const path = join(eventsDir, "x/00001.jsonl");
    writeFileSync(path, "");
    for (const line of lines) appendFileSync(path, `${JSON.stringify(line)}\n`);
    return { eventsDir, path };
  }
  const event = (type: string, turn: number, payload: object = {}) => ({ event_id: `e${turn}`, experiment_id: "x", run_id: "00001", turn, type, timestamp: "2026-01-01T00:00:00Z", payload });

  it("reports a recorded interruption", () => {
    const { eventsDir } = writeRun([event("experiment.started", 0), event("agent.observation", 3), event("experiment.interrupted", 3, { reason: "process received SIGINT" })]);
    expect(loadRun(eventsDir, "x/00001")).toMatchObject({ status: "interrupted", interruption: { inferred: false, turn: 3, reason: "process received SIGINT" } });
  });

  it("infers an interruption when a run without end event stopped growing", () => {
    const { eventsDir, path } = writeRun([event("experiment.started", 0), event("agent.observation", 7)]);
    expect(loadRun(eventsDir, "x/00001").status).toBe("running");
    const old = new Date(Date.now() - 30 * 60_000);
    utimesSync(path, old, old);
    const run = loadRun(eventsDir, "x/00001");
    expect(run.status).toBe("interrupted");
    expect(run.interruption).toMatchObject({ inferred: true, turn: 7 });
    expect(run.interruption!.reason).toMatch(/no new event for 30 min/);
  });
});
