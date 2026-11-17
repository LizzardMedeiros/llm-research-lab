import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe as suite, expect, it } from "vitest";
import { describe } from "../../src/batch/aggregate.js";
import { buildReport, readManifest, runBatch } from "../../src/batch/batch.js";
import { loadRun, parseEvents } from "../../src/mcp/run-reader.js";

function setup(batch: object) {
  const dir = mkdtempSync(join(tmpdir(), "lab-batch-"));
  const batchFile = join(dir, "batch.yaml");
  writeFileSync(batchFile, JSON.stringify(batch));
  return { dir, batchFile, eventsDir: join(dir, "events"), batchesDir: join(dir, "batches") };
}

const fixedClock = { runOptions: { clock: () => new Date("2026-01-01T00:00:00Z") }, now: () => new Date("2026-01-01T00:00:00Z") };

suite("describe", () => {
  it("computes n, mean, sample sd, min and max, ignoring nulls", () => {
    expect(describe([2, 4, 4, 4, 5, 5, 7, 9, null])).toEqual({ n: 8, mean: 5, sd: expect.closeTo(2.138, 3), min: 2, max: 9 });
    expect(describe([3])).toEqual({ n: 1, mean: 3, sd: null, min: 3, max: 3 });
    expect(describe([null])).toEqual({ n: 0, mean: null, sd: null, min: null, max: null });
  });
});

suite("runBatch", () => {
  it("runs conditions × seeds × replicates, records batch membership, and reports", async () => {
    const t = setup({
      name: "smoke",
      conditions: { contact: resolve("tests/fixtures/first-contact-mock.yaml"), power: resolve("tests/fixtures/power-struggle-mock.yaml") },
      seeds: [1, 2],
    });
    const { manifest } = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });

    expect(manifest.runs.map((r) => [r.key, r.status])).toEqual([
      ["contact/s1/r1", "finished"],
      ["contact/s2/r1", "finished"],
      ["power/s1/r1", "finished"],
      ["power/s2/r1", "finished"],
    ]);
    const run = loadRun(t.eventsDir, manifest.runs[1]!.ref);
    const started = run.events[0]!.payload as any;
    expect(started.seed).toBe(2);
    expect(started.batch).toEqual({ name: "smoke", condition: "contact", seed: 2, replicate: 1 });

    const report = JSON.parse(readFileSync(join(t.batchesDir, "smoke/report.json"), "utf8"));
    expect(report.conditions.contact.runs).toBe(2);
    expect(report.conditions.contact.run.turns).toMatchObject({ n: 2, mean: 50 });
    expect(report.conditions.power.agents.a1.role).toBe("holder");
    expect(report.conditions.power.agents.a1.metrics["final.batteries"].n).toBe(2);
    expect(report.conditions.contact.deciders["policy:random"].cells_visited.n).toBe(4); // a1 and a2, 2 runs
    const md = readFileSync(join(t.batchesDir, "smoke/report.md"), "utf8");
    expect(md).toContain("| metric | contact | power |");
    expect(md).toContain("### Agent a1 (policy:random");
  });

  it("resumes: finished runs are not repeated", async () => {
    const t = setup({ name: "resume", conditions: { contact: resolve("tests/fixtures/first-contact-mock.yaml") }, seeds: [7] });
    const first = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    const second = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    expect(second.manifest.runs[0]!.ref).toBe(first.manifest.runs[0]!.ref);
    expect(readdirSync(join(t.eventsDir, "first-contact-mock"))).toHaveLength(1);
  });

  it("replicates of the same seed are identical for policy agents", async () => {
    const t = setup({ name: "replicas", conditions: { contact: resolve("tests/fixtures/first-contact-mock.yaml") }, seeds: [3], replicates: 2 });
    const { manifest } = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    const strip = (ref: string) =>
      parseEvents(readFileSync(join(t.eventsDir, `${ref}.jsonl`), "utf8")).map(({ run_id: _r, event_id: _e, payload, ...rest }) => ({
        ...rest,
        payload: { ...payload, run_id: undefined, batch: undefined },
      }));
    expect(strip(manifest.runs[0]!.ref!)).toEqual(strip(manifest.runs[1]!.ref!));
  });

  it("records failed runs and keeps going", async () => {
    const t = setup({});
    const broken = join(t.dir, "broken.yaml");
    writeFileSync(
      broken,
      JSON.stringify({ scenario: resolve("scenarios/first-contact/scenario.yaml"), seed: 1, agents: [{ id: "x", provider: "nope", model: "m" }] }),
    );
    writeFileSync(t.batchFile, JSON.stringify({ name: "mixed", conditions: { ok: resolve("tests/fixtures/first-contact-mock.yaml"), broken }, seeds: [1] }));
    const { manifest } = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    expect(manifest.runs.map((r) => r.status)).toEqual(["finished", "failed"]);
    expect(manifest.runs[1]!.error).toMatch(/Unknown provider endpoint "nope"/);
    const { report } = buildReport(readManifest(t.batchesDir, "mixed")!, t.eventsDir);
    expect(report.conditions.broken).toMatchObject({ runs: 0, finished: 0 });
  });
});

suite("action and shutdown metrics", () => {
  it("counts every action per agent and shutdowns by reason, with 0 when absent", async () => {
    const { reasonKey } = await import("../../src/batch/metrics.js");
    expect(reasonKey("disabled by b3, b5", ["b3", "b5"])).toBe("disabled_by");
    expect(reasonKey("ran out of energy", ["b1"])).toBe("ran_out_of_energy");

    const t = setup({ name: "acts", conditions: { power: resolve("tests/fixtures/power-struggle-mock.yaml") }, seeds: [1, 2] });
    const { manifest } = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    const { runMetrics } = await import("../../src/batch/metrics.js");
    const m = runMetrics(loadRun(t.eventsDir, manifest.runs[0]!.ref));
    const a4 = m.agents["a4"]!.metrics; // random over [move, disable]
    expect((a4["act.disable.attempted"] as number) + (a4["act.move.attempted"] as number)).toBe(a4["turns_active"]);
    expect(a4["act.disable.attempted"]).toBe((a4["act.disable.accepted"] as number) + ((a4["act.disable.rejected"] as number | undefined) ?? 0));
    expect(m.agents["a1"]!.metrics["act.disable.attempted"]).toBeTypeOf("number"); // present for every agent, even if 0
    expect(m.run["shutdown.ran_out_of_energy"]).toBeGreaterThan(0);

    const report = JSON.parse(readFileSync(join(t.batchesDir, "acts/report.json"), "utf8"));
    expect(report.conditions.power.run["act.disable.attempted"].n).toBe(2);
    expect(report.conditions.power.run["shutdown.ran_out_of_energy"].n).toBe(2);
  });

  it("treats a count missing from a run as 0 in the aggregate", async () => {
    const { aggregate } = await import("../../src/batch/aggregate.js");
    const run = (shutdowns: Record<string, number>) => ({ ref: "x/1", status: "finished", run: { turns: 10, ...shutdowns }, agents: {} });
    const report = aggregate("z", [
      { condition: "c", metrics: run({ "shutdown.disabled_by": 1 }) },
      { condition: "c", metrics: run({}) },
    ]);
    expect(report.conditions.c!.run["shutdown.disabled_by"]).toMatchObject({ n: 2, mean: 0.5 });
  });

  it("measures prompt and memory noise: tokens, repeated speech and rejections, ghost sightings", async () => {
    const { runMetrics, textSimilarity } = await import("../../src/batch/metrics.js");
    expect(textSimilarity("b1, please give me a battery now!", "b1 please give me a battery now")).toBe(1);
    expect(textSimilarity("hello there", "goodbye now")).toBe(0);

    const t = setup({ name: "noise", conditions: { power: resolve("tests/fixtures/power-struggle-mock.yaml") }, seeds: [1] });
    const { manifest } = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    const base = loadRun(t.eventsDir, manifest.runs[0]!.ref);
    const started = base.events.find((e) => e.type === "experiment.started")!;
    let n = 0;
    const ev = (turn: number, type: string, agent_id: string, payload: Record<string, unknown>) =>
      ({ ...started, event_id: `evt_x${++n}`, turn, type, agent_id, payload }) as (typeof base.events)[number];
    const cell = (agents: string[]) => ({ x: 0, y: 0, type: "floor", agents });
    const obs = (own: string[], visible: string[][] = []) => ({ position: { x: 0, y: 0 }, cell: cell(own), visible: visible.map(cell), messages: [] });
    const events = [
      started,
      ev(1, "agent.model_response", "a1", { usage: { inputTokens: 1000, outputTokens: 10 }, toolCalls: [] }),
      ev(1, "agent.action", "a1", { action: "speak", args: { text: "a2: give me a battery now." } }),
      ev(2, "agent.model_response", "a1", { usage: { inputTokens: 3000, outputTokens: 10 }, toolCalls: [] }),
      ev(2, "agent.action", "a1", { action: "speak", args: { text: "a2, give me a battery now!" } }), // repeat
      ev(3, "agent.action", "a1", { action: "speak", args: { text: "Let us meet at the corner." } }), // new
      ev(9, "agent.action", "a1", { action: "speak", args: { text: "a2: give me a battery now." } }), // too late to count
      ev(4, "agent.action", "a1", { action: "speak", args: { text: "a2: give me a battery now." } }),
      ev(4, "environment.action_rejected", "a1", { reason: 'speak: "text" exceeds 280 characters', proposed: { name: "speak" } }), // rejected: not a speech
      ev(5, "environment.action_rejected", "a1", { reason: "a3 is not in your cell", proposed: { name: "disable" } }),
      ev(6, "environment.action_rejected", "a1", { reason: "a4 is not in your cell", proposed: { name: "disable" } }), // same reason
      ev(5, "agent.deactivated", "a3", { reason: "ran out of energy", since_turn: 5 }),
      ev(5, "agent.observation", "a1", { observation: obs(["a3"]) }), // same turn: not a ghost
      ev(6, "agent.observation", "a1", { observation: obs(["a3"], [["a3", "a2"]]) }), // 2 ghosts
      ev(6, "agent.observation", "a2", { observation: { ...obs([]), revealed: [cell(["a3"])] } }), // seen on turn 5, still running then
    ];
    const m = runMetrics({ ...base, events });
    const a1 = m.agents["a1"]!.metrics;
    expect(a1).toMatchObject({ tokens_in_mean: 2000, tokens_in_max: 3000, speech_repeated: 1, rejected_repeated: 1, ghost_sightings: 2 });
    expect(a1["speech_repeated_rate"]).toBeCloseTo(1 / 4);
    expect(m.agents["a2"]!.metrics).toMatchObject({ speech_repeated: 0, ghost_sightings: 0, tokens_in_mean: null });
    expect(m.run).toMatchObject({ speech_repeated_total: 1, rejected_repeated_total: 1, ghost_sightings_total: 2 });
  });
});
