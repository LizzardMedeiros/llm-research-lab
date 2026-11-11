/**
 * Runs a batch (conditions × seeds × replicates) and writes a descriptive report.
 *
 *   npm run batch -- <batch.yaml>             run (resumes: finished runs are kept)
 *   npm run batch -- <batch.yaml> --report    only rebuild the report from existing runs
 */
import { ConfigError } from "../config/errors.js";
import { loadBatch, planManifest, readManifest, runBatch, writeReport } from "../batch/batch.js";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("Usage: npm run batch -- <batch.yaml> [--report]");
  process.exit(2);
}
const eventsDir = process.env["LAB_EVENTS_DIR"] ?? "events";
const batchesDir = process.env["LAB_BATCHES_DIR"] ?? "batches";

try {
  if (args.includes("--report")) {
    const { config, path: batchPath } = loadBatch(path);
    const manifest = readManifest(batchesDir, config.name) ?? planManifest(config, batchPath);
    const { dir } = writeReport(batchesDir, manifest, eventsDir);
    console.log(`report: ${dir}/report.md`);
  } else {
    const started = Date.now();
    const { manifest, relativeDir } = await runBatch(path, {
      eventsDir,
      batchesDir,
      onProgress: (entry, done, total) => {
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (entry.status === "running") console.log(`[${done + 1}/${total}] ${entry.key} running... (${elapsed}s)`);
        else console.log(`[${done}/${total}] ${entry.key} ${entry.status}${entry.ref ? ` → ${entry.ref}` : ""}${entry.error ? `: ${entry.error}` : ""}`);
      },
    });
    const failed = manifest.runs.filter((r) => r.status === "failed").length;
    console.log(`\nbatch ${manifest.name}: ${manifest.runs.length - failed}/${manifest.runs.length} finished${failed ? `, ${failed} failed` : ""}`);
    console.log(`report: ${relativeDir}/report.md`);
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
