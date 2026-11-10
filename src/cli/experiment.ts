/**
 * Runs an experiment and prints a one-line live feed per action.
 *
 *   npm run experiment -- <experiment.yaml> [--quiet]
 */
import { ConfigError } from "../config/errors.js";
import { runExperiment } from "../engine/runner.js";
import type { LabEvent } from "../events/event.js";

function describe(event: LabEvent): string | null {
  const p = event.payload;
  const who = event.agent_id ?? "";
  switch (event.type) {
    case "agent.action":
      return `t${event.turn} ${who} ${p["action"]} ${JSON.stringify(p["args"])}`;
    case "environment.action_rejected":
      return `t${event.turn} ${who}   ✗ rejected: ${p["reason"]}`;
    case "agent.model_error":
      return `t${event.turn} ${who}   ! ${p["error"]}`;
    default:
      return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: npm run experiment -- <experiment.yaml> [--quiet]");
    process.exit(2);
  }
  try {
    const summary = await runExperiment(path, {
      onLog: (log) => {
        if (quiet) return;
        log.subscribe((event) => {
          const line = describe(event);
          if (line) console.log(line);
        });
      },
    });
    console.log(`\n${summary.experimentId} run ${summary.runId}: ${summary.turns} turns (${summary.reason})`);
    console.log(`events: ${summary.eventsPath}`);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}

await main();
