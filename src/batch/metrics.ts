import type { LoadedRun } from "../mcp/run-reader.js";
import { experimentSummary } from "../mcp/run-reader.js";
import { indexRun, runOutcome } from "../story/story.js";

/**
 * Per-run metrics derived only from the event log. Generic: they work for
 * any scenario. Scenario state shows up as `final.<field>` for every numeric
 * per-agent value found in the final snapshot (e.g. final.charge).
 */

export type MetricValues = Record<string, number | null>;

export interface RunMetrics {
  ref: string;
  status: string;
  run: MetricValues;
  agents: Record<string, { decider: string; role?: string; metrics: MetricValues }>;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

export function runMetrics(run: LoadedRun): RunMetrics {
  const summary = experimentSummary(run);
  const index = indexRun(run.events);
  const outcome = runOutcome(index);

  const heardSpeeches = new Map<string, number>();
  for (const speech of index.speeches.values()) {
    if (speech.heardBy.length) heardSpeeches.set(speech.agent, (heardSpeeches.get(speech.agent) ?? 0) + 1);
  }

  const agents: RunMetrics["agents"] = {};
  for (const a of summary.agents) {
    const rejected = Object.values(a.rejections).reduce((sum, n) => sum + n, 0);
    const model = "model" in a ? a.model : undefined;
    const metrics: MetricValues = {
      turns_active: a.turns,
      accepted_rate: ratio(a.accepted_actions, a.turns),
      rejected,
      tool_call_rate: model ? ratio(model.responses_with_tool_call, model.requests) : null,
      cells_visited: a.cells_visited,
      turns_with_company: a.encounters.turns_sharing_a_cell,
      speech_sent: a.speech.sent,
      speech_heard: heardSpeeches.get(a.id) ?? 0,
      speech_received: a.speech.received,
      lasted: index.lasted[a.id] ?? null,
      survived: outcome.survivors.includes(a.id) ? 1 : 0,
      tokens_in: model ? model.tokens.input : null,
      tokens_out: model ? model.tokens.output : null,
      median_latency_ms: model ? model.median_latency_ms : null,
    };
    for (const [field, value] of Object.entries(outcome.stats[a.id] ?? {})) metrics[`final.${field}`] = value;
    agents[a.id] = { decider: a.decider, ...(a.role ? { role: String(a.role) } : {}), metrics };
  }

  return {
    ref: run.ref,
    status: run.status,
    run: {
      turns: run.lastTurn,
      survivors: outcome.survivors.length,
      shutdowns: index.ids.length - outcome.survivors.length,
      speech_heard_total: [...heardSpeeches.values()].reduce((s, n) => s + n, 0),
    },
    agents,
  };
}
