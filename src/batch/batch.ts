import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError } from "../config/errors.js";
import { runExperiment, type RunOptions } from "../engine/runner.js";
import { loadRun } from "../mcp/run-reader.js";
import { aggregate, renderMarkdown, type BatchReport } from "./aggregate.js";
import { runMetrics } from "./metrics.js";

/**
 * A batch runs conditions × seeds × replicates. Each run is a normal run
 * (events/<experiment>/<run>.jsonl); the batch keeps a manifest so it can
 * resume, and a descriptive report.
 */

export const BatchSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "batch names: lowercase letters, digits, - and _"),
    description: z.string().optional(),
    /** condition name → experiment file (relative to the batch file). */
    conditions: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.string().min(1)).refine((c) => Object.keys(c).length > 0, "at least one condition"),
    seeds: z.array(z.number().int()).min(1),
    replicates: z.number().int().min(1).default(1),
    concurrency: z.number().int().min(1).max(16).default(1),
  })
  .strict();

export type BatchConfig = z.infer<typeof BatchSchema>;

export interface ManifestEntry {
  key: string;
  condition: string;
  experiment: string;
  seed: number;
  replicate: number;
  status: "pending" | "running" | "finished" | "failed";
  ref?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface Manifest {
  name: string;
  batch_file: string;
  runs: ManifestEntry[];
}

export interface BatchOptions {
  eventsDir?: string;
  batchesDir?: string;
  /** Called after each run changes state. */
  onProgress?: (entry: ManifestEntry, done: number, total: number) => void;
  /** Extra run options (tests: clock, providerFactory). */
  runOptions?: Omit<RunOptions, "seed" | "batch" | "eventsDir" | "sink">;
  now?: () => Date;
}

export function loadBatch(path: string): { config: BatchConfig; path: string } {
  const absolute = resolve(path);
  const result = BatchSchema.safeParse(parse(readFileSync(absolute, "utf8")));
  if (!result.success) throw new ConfigError(`Invalid batch ${path}:\n${z.prettifyError(result.error)}`);
  for (const [condition, experiment] of Object.entries(result.data.conditions)) {
    const file = resolve(dirname(absolute), experiment);
    if (!existsSync(file)) throw new ConfigError(`Batch ${result.data.name}: condition "${condition}" points to a missing file ${experiment}`);
  }
  return { config: result.data, path: absolute };
}

const keyOf = (condition: string, seed: number, replicate: number) => `${condition}/s${seed}/r${replicate}`;

/** Builds (or extends) the manifest; finished runs are kept, interrupted ones are retried. */
export function planManifest(config: BatchConfig, batchPath: string, previous?: Manifest): Manifest {
  const before = new Map((previous?.runs ?? []).map((r) => [r.key, r]));
  const runs: ManifestEntry[] = [];
  for (const [condition, experiment] of Object.entries(config.conditions)) {
    for (const seed of config.seeds) {
      for (let replicate = 1; replicate <= config.replicates; replicate++) {
        const key = keyOf(condition, seed, replicate);
        const old = before.get(key);
        const experimentPath = resolve(dirname(batchPath), experiment);
        if (old && old.status === "finished" && old.experiment === experimentPath) runs.push(old);
        else runs.push({ key, condition, experiment: experimentPath, seed, replicate, status: "pending" });
      }
    }
  }
  return { name: config.name, batch_file: batchPath, runs };
}

export function batchDir(batchesDir: string, name: string) {
  return join(batchesDir, name);
}

export function readManifest(batchesDir: string, name: string): Manifest | undefined {
  const file = join(batchDir(batchesDir, name), "manifest.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : undefined;
}

function writeManifest(batchesDir: string, manifest: Manifest) {
  mkdirSync(batchDir(batchesDir, manifest.name), { recursive: true });
  writeFileSync(join(batchDir(batchesDir, manifest.name), "manifest.json"), JSON.stringify(manifest, null, 2));
}

/** Report from the manifest and the run logs (works on partial batches too). */
export function buildReport(manifest: Manifest, eventsDir: string, now = new Date()): { report: BatchReport; markdown: string } {
  const runs = manifest.runs
    .filter((r) => r.ref && (r.status === "finished" || r.status === "failed"))
    .flatMap((r) => {
      try {
        return [{ condition: r.condition, metrics: runMetrics(loadRun(eventsDir, r.ref)) }];
      } catch {
        return [];
      }
    });
  const report = aggregate(manifest.name, runs, now);
  // Keep conditions without data visible in the report.
  for (const r of manifest.runs) report.conditions[r.condition] ??= { runs: 0, finished: 0, run: {}, agents: {}, deciders: {} };
  return { report, markdown: renderMarkdown(report, manifest.runs) };
}

export function writeReport(batchesDir: string, manifest: Manifest, eventsDir: string, now = new Date()) {
  const { report, markdown } = buildReport(manifest, eventsDir, now);
  const dir = batchDir(batchesDir, manifest.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "report.md"), markdown);
  return { report, markdown, dir };
}

export async function runBatch(path: string, options: BatchOptions = {}) {
  const { config, path: batchPath } = loadBatch(path);
  const eventsDir = options.eventsDir ?? "events";
  const batchesDir = options.batchesDir ?? "batches";
  const now = options.now ?? (() => new Date());
  const manifest = planManifest(config, batchPath, readManifest(batchesDir, config.name));
  writeManifest(batchesDir, manifest);

  const queue = manifest.runs.filter((r) => r.status !== "finished");
  let done = manifest.runs.length - queue.length;
  const total = manifest.runs.length;

  const work = async (entry: ManifestEntry) => {
    entry.status = "running";
    entry.started_at = now().toISOString();
    delete entry.error;
    writeManifest(batchesDir, manifest);
    options.onProgress?.(entry, done, total);
    try {
      const summary = await runExperiment(entry.experiment, {
        ...options.runOptions,
        eventsDir,
        seed: entry.seed,
        batch: { name: config.name, condition: entry.condition, seed: entry.seed, replicate: entry.replicate },
      });
      entry.ref = `${summary.experimentId}/${summary.runId}`;
      entry.status = "finished";
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
    }
    entry.finished_at = now().toISOString();
    done++;
    writeManifest(batchesDir, manifest);
    options.onProgress?.(entry, done, total);
  };

  // Simple worker pool: runs are independent.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(config.concurrency, queue.length) }, async () => {
      while (next < queue.length) await work(queue[next++]!);
    }),
  );

  const { dir } = writeReport(batchesDir, manifest, eventsDir, now());
  return { manifest, dir, relativeDir: relative(process.cwd(), dir) };
}
