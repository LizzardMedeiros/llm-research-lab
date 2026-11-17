/**
 * Descriptive metrics for existing runs, grouped by experiment (one column
 * per experiment). Same metrics and report format as a batch, without
 * running anything.
 *
 *   npm run metrics                      every run in LAB_EVENTS_DIR
 *   npm run metrics -- <exp> <exp>/<run>  only these experiments or runs
 */
import { aggregate, renderMarkdown } from "../batch/aggregate.js";
import { runMetrics } from "../batch/metrics.js";
import { listRunFiles, loadRun } from "../mcp/run-reader.js";

const eventsDir = process.env["LAB_EVENTS_DIR"] ?? "events";
const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const selected = listRunFiles(eventsDir)
  .filter((r) => filters.length === 0 || filters.some((f) => f === r.experimentId || f === r.ref))
  .sort((a, b) => a.ref.localeCompare(b.ref));
if (selected.length === 0) {
  console.error(`No runs found in ${eventsDir}${filters.length ? ` for ${filters.join(", ")}` : ""}.`);
  process.exit(2);
}

const runs: Array<{ condition: string; metrics: ReturnType<typeof runMetrics> }> = [];
const runList: Array<{ condition: string; seed: number; replicate: number; ref?: string; status: string }> = [];
for (const info of selected) {
  const run = loadRun(eventsDir, info.ref);
  const seed = Number(run.events.find((e) => e.type === "experiment.started")?.payload["seed"] ?? NaN);
  runList.push({ condition: info.experimentId, seed, replicate: Number(info.runId), ref: info.ref, status: run.status });
  // Incomplete runs never enter the metrics (same rule as batches).
  if (run.status === "finished" || run.status === "failed") runs.push({ condition: info.experimentId, metrics: runMetrics(run) });
}

console.log(renderMarkdown(aggregate("existing runs", runs), runList));
