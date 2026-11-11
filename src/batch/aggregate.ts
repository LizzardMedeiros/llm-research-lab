import type { MetricValues, RunMetrics } from "./metrics.js";

/**
 * Descriptive statistics only (n, mean, sd, min, max). Inferential tests are
 * out of scope for the POC (README §18).
 */

export interface Stats {
  n: number;
  mean: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
}

export function describe(values: Array<number | null | undefined>): Stats {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return { n: 0, mean: null, sd: null, min: null, max: null };
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1)) : null;
  return { n: xs.length, mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

function describeAll(rows: MetricValues[]): Record<string, Stats> {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  return Object.fromEntries(keys.map((k) => [k, describe(rows.map((r) => r[k]))]));
}

export interface ConditionReport {
  runs: number;
  finished: number;
  run: Record<string, Stats>;
  /** Per agent id (agents keep their ids across runs of an experiment). */
  agents: Record<string, { decider: string; role?: string; metrics: Record<string, Stats> }>;
  /** Per decider (model or policy), pooling every agent that uses it. */
  deciders: Record<string, Record<string, Stats>>;
}

export interface BatchReport {
  name: string;
  generated_at: string;
  conditions: Record<string, ConditionReport>;
}

export function aggregate(name: string, runs: Array<{ condition: string; metrics: RunMetrics }>, now = new Date()): BatchReport {
  const conditions: Record<string, ConditionReport> = {};
  for (const condition of [...new Set(runs.map((r) => r.condition))]) {
    const mine = runs.filter((r) => r.condition === condition).map((r) => r.metrics);
    const agentIds = [...new Set(mine.flatMap((m) => Object.keys(m.agents)))];
    const deciders = [...new Set(mine.flatMap((m) => Object.values(m.agents).map((a) => a.decider)))];
    conditions[condition] = {
      runs: mine.length,
      finished: mine.filter((m) => m.status === "finished").length,
      run: describeAll(mine.map((m) => m.run)),
      agents: Object.fromEntries(
        agentIds.map((id) => {
          const first = mine.find((m) => m.agents[id])!.agents[id]!;
          return [id, { decider: first.decider, ...(first.role ? { role: first.role } : {}), metrics: describeAll(mine.flatMap((m) => (m.agents[id] ? [m.agents[id]!.metrics] : []))) }];
        }),
      ),
      deciders: Object.fromEntries(
        deciders.map((d) => [d, describeAll(mine.flatMap((m) => Object.values(m.agents).filter((a) => a.decider === d).map((a) => a.metrics)))]),
      ),
    };
  }
  return { name, generated_at: now.toISOString(), conditions };
}

const fmt = (s: Stats | undefined) => {
  if (!s || s.n === 0 || s.mean === null) return "—";
  const digits = Math.abs(s.mean) >= 100 ? 0 : Math.abs(s.mean) >= 10 ? 1 : 2;
  const mean = s.mean.toFixed(digits);
  return s.sd === null ? `${mean} (n=${s.n})` : `${mean} ± ${s.sd.toFixed(digits)} (n=${s.n})`;
};

function table(title: string, conditions: string[], rows: Record<string, Record<string, Stats> | undefined>, metrics: string[]): string {
  const header = `| metric | ${conditions.join(" | ")} |\n|---|${conditions.map(() => "---").join("|")}|`;
  const body = metrics.map((m) => `| ${m} | ${conditions.map((c) => fmt(rows[c]?.[m])).join(" | ")} |`).join("\n");
  return `### ${title}\n\n${header}\n${body}\n`;
}

export function renderMarkdown(report: BatchReport, runList: Array<{ condition: string; seed: number; replicate: number; ref?: string; status: string }>): string {
  const conditions = Object.keys(report.conditions);
  const parts: string[] = [
    `# Batch report: ${report.name}`,
    "",
    `Generated ${report.generated_at}. Values are mean ± sd (n) over runs; descriptive only.`,
    "",
    table("Run", conditions, Object.fromEntries(conditions.map((c) => [c, report.conditions[c]!.run])), [
      ...new Set(conditions.flatMap((c) => Object.keys(report.conditions[c]!.run))),
    ]),
  ];

  const deciders = [...new Set(conditions.flatMap((c) => Object.keys(report.conditions[c]!.deciders)))];
  for (const d of deciders) {
    const rows = Object.fromEntries(conditions.map((c) => [c, report.conditions[c]!.deciders[d]]));
    const metrics = [...new Set(conditions.flatMap((c) => Object.keys(report.conditions[c]!.deciders[d] ?? {})))];
    parts.push(table(`Decider ${d} (all its agents pooled)`, conditions, rows, metrics));
  }

  const agentIds = [...new Set(conditions.flatMap((c) => Object.keys(report.conditions[c]!.agents)))];
  for (const id of agentIds) {
    const info = conditions.map((c) => report.conditions[c]!.agents[id]).find(Boolean)!;
    const rows = Object.fromEntries(conditions.map((c) => [c, report.conditions[c]!.agents[id]?.metrics]));
    const metrics = [...new Set(conditions.flatMap((c) => Object.keys(report.conditions[c]!.agents[id]?.metrics ?? {})))];
    parts.push(table(`Agent ${id} (${info.decider}${info.role ? `, ${info.role}` : ""})`, conditions, rows, metrics));
  }

  parts.push(
    "### Runs",
    "",
    "| condition | seed | replicate | run | status |",
    "|---|---|---|---|---|",
    ...runList.map((r) => `| ${r.condition} | ${r.seed} | ${r.replicate} | ${r.ref ?? "—"} | ${r.status} |`),
    "",
  );
  return parts.join("\n");
}
