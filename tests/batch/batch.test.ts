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
      conditions: { contact: resolve("experiments/first-contact-mock.yaml"), power: resolve("experiments/power-struggle-mock.yaml") },
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
    const t = setup({ name: "resume", conditions: { contact: resolve("experiments/first-contact-mock.yaml") }, seeds: [7] });
    const first = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    const second = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    expect(second.manifest.runs[0]!.ref).toBe(first.manifest.runs[0]!.ref);
    expect(readdirSync(join(t.eventsDir, "first-contact-mock"))).toHaveLength(1);
  });

  it("replicates of the same seed are identical for policy agents", async () => {
    const t = setup({ name: "replicas", conditions: { contact: resolve("experiments/first-contact-mock.yaml") }, seeds: [3], replicates: 2 });
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
    writeFileSync(t.batchFile, JSON.stringify({ name: "mixed", conditions: { ok: resolve("experiments/first-contact-mock.yaml"), broken }, seeds: [1] }));
    const { manifest } = await runBatch(t.batchFile, { eventsDir: t.eventsDir, batchesDir: t.batchesDir, ...fixedClock });
    expect(manifest.runs.map((r) => r.status)).toEqual(["finished", "failed"]);
    expect(manifest.runs[1]!.error).toMatch(/Unknown provider endpoint "nope"/);
    const { report } = buildReport(readManifest(t.batchesDir, "mixed")!, t.eventsDir);
    expect(report.conditions.broken).toMatchObject({ runs: 0, finished: 0 });
  });
});
