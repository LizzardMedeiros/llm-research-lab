/**
 * Validates a script.json against its run log, resolves quotes verbatim and
 * writes script.resolved.json + facts.md next to it.
 *
 *   npm run script:check -- <path/to/script.json>
 *
 * Exit code 1 when the script has errors.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadRun } from "../mcp/run-reader.js";
import { checkScript, factSheet } from "../story/script.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: npm run script:check -- <path/to/script.json>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(path, "utf8")) as { source?: string };
if (!input.source) {
  console.error("script.json needs a \"source\": \"<experiment_id>/<run_id>\"");
  process.exit(1);
}
const run = loadRun(process.env["LAB_EVENTS_DIR"] ?? "events", input.source);
const report = checkScript(input, run.events);

for (const e of report.errors) console.log(`ERROR   ${e}`);
for (const w of report.warnings) console.log(`WARNING ${w}`);
console.log(`estimated length: ${Math.floor(report.estimatedSeconds / 60)}:${String(report.estimatedSeconds % 60).padStart(2, "0")}`);

if (!report.resolved) process.exit(1);
const dir = dirname(path);
writeFileSync(join(dir, "script.resolved.json"), JSON.stringify(report.resolved, null, 2));
writeFileSync(join(dir, "facts.md"), `# Fact sheet: ${report.resolved.title}\n\nCompare every NARRATION line with the FACTS of its scene.\n\n${factSheet(report.resolved)}\n`);
console.log(`OK → ${join(dir, "script.resolved.json")}, ${join(dir, "facts.md")}`);
