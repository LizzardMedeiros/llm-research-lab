import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExperiment, type RunOptions } from "../../src/engine/runner.js";
import { MemorySink, type LabEvent } from "../../src/events/event.js";

/** Writes files into a temp dir and runs `experiment.yaml` with an in-memory sink. */
export async function runFixture(files: Record<string, string>, options: RunOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lab-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const sink = new MemorySink();
  const summary = await runExperiment(join(dir, "experiment.yaml"), {
    sink,
    clock: () => new Date("2026-01-01T00:00:00Z"),
    ...options,
  });
  return { summary, events: sink.events, dir };
}

export const ofType = (events: LabEvent[], type: string, agentId?: string) =>
  events.filter((e) => e.type === type && (agentId === undefined || e.agent_id === agentId));

export const observationOf = (events: LabEvent[], agentId: string, turn: number) =>
  ofType(events, "agent.observation", agentId).find((e) => e.turn === turn)!.payload["observation"] as Record<string, any>;
