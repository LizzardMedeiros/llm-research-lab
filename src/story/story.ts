import type { LabEvent } from "../events/event.js";

/**
 * Turns a run log into a short, factual "story": the most eventful turns,
 * with verbatim dialogue and the world state at each of them.
 * Everything here is derived from events; nothing is invented.
 */

export type Beat =
  | { kind: "speech"; agent: string; text: string; heardBy: string[]; eventId: string }
  | { kind: "action"; agent: string; action: string; args: Record<string, unknown>; eventId: string }
  | { kind: "shutdown"; agent: string; reason: string; eventId: string };

export interface StoryScene {
  turn: number;
  beats: Beat[];
  /** World after this turn. */
  positions: Record<string, [number, number]>;
  inactive: string[];
  /** Per-agent numeric state found in the snapshot (e.g. energy), if any. */
  stats: Record<string, Record<string, number>>;
  /** Filled by a narrator (or the template fallback). */
  narration?: string;
}

export interface Story {
  experimentId: string;
  runId: string;
  scenario: { name: string; description: string; map: string[]; blocked: string[] };
  seed: number;
  maxTurns: number;
  agents: Array<{ id: string; role?: string; decider: string; goal?: string }>;
  /** Tool descriptions of the run's actions (what each action means). */
  actions: Array<{ name: string; description: string }>;
  intro: StoryScene;
  scenes: StoryScene[];
  outcome: { turn: number; text: string; survivors: string[]; stats: Record<string, Record<string, number>> };
}

const STANDARD = new Set(["move", "observe", "wait", "speak"]);

const SCORES = {
  shutdown: 6,
  customAction: 3,
  speechHeard: 2,
  speechUnheard: 0.25,
};

type Snapshot = {
  agents: Record<string, { position: [number, number] | { x: number; y: number } }>;
  inactive?: Record<string, unknown>;
  state?: Record<string, unknown>;
};

const toXY = (p: [number, number] | { x: number; y: number }): [number, number] => (Array.isArray(p) ? p : [p.x, p.y]);

/** Finds per-agent records of numbers in hook state (e.g. state.energy[agent] = {charge, batteries}). */
function perAgentStats(state: Record<string, unknown> | undefined, ids: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const value of Object.values(state ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || !entries.every(([k]) => ids.includes(k))) continue;
    for (const [id, record] of entries) {
      if (!record || typeof record !== "object") continue;
      for (const [field, n] of Object.entries(record as Record<string, unknown>)) {
        if (typeof n === "number") (out[id] ??= {})[field] = n;
      }
    }
  }
  return out;
}

function sceneFrom(turn: number, beats: Beat[], snapshot: Snapshot, ids: string[]): StoryScene {
  return {
    turn,
    beats,
    positions: Object.fromEntries(Object.entries(snapshot.agents).map(([id, a]) => [id, toXY(a.position)])),
    inactive: Object.keys(snapshot.inactive ?? {}),
    stats: perAgentStats(snapshot.state, ids),
  };
}

function score(beats: Beat[]): number {
  let total = 0;
  for (const b of beats) {
    if (b.kind === "shutdown") total += SCORES.shutdown;
    else if (b.kind === "action") total += SCORES.customAction;
    else total += b.heardBy.length ? SCORES.speechHeard : SCORES.speechUnheard;
  }
  return total;
}

export interface StoryOptions {
  /** Maximum number of turns turned into scenes (intro and outcome not counted). */
  maxScenes?: number;
}

export function buildStory(events: LabEvent[], options: StoryOptions = {}): Story {
  const maxScenes = options.maxScenes ?? 8;
  const started = events.find((e) => e.type === "experiment.started");
  if (!started) throw new Error("Run has no experiment.started event");
  const p = started.payload as any;
  const ids: string[] = p.agents.map((a: { id: string }) => a.id);

  // Collect beats per turn.
  const rejected = new Set(events.filter((e) => e.type === "environment.action_rejected").map((e) => `${e.turn}:${e.agent_id}`));
  const recipients = new Map<string, string[]>();
  const lastSnapshot = new Map<number, Snapshot>();
  for (const e of events) {
    if (e.type !== "environment.transition") continue;
    lastSnapshot.set(e.turn, e.payload["snapshot"] as Snapshot);
    for (const effect of (e.payload["effects"] as Array<Record<string, any>>) ?? []) {
      if (effect["kind"] === "speak") recipients.set(`${e.turn}:${effect["agentId"]}`, effect["recipients"]);
    }
  }

  const beatsByTurn = new Map<number, Beat[]>();
  const push = (turn: number, beat: Beat) => beatsByTurn.set(turn, [...(beatsByTurn.get(turn) ?? []), beat]);
  for (const e of events) {
    if (e.type === "agent.action" && e.agent_id && !rejected.has(`${e.turn}:${e.agent_id}`)) {
      const action = e.payload["action"] as string;
      const args = (e.payload["args"] ?? {}) as Record<string, unknown>;
      if (action === "speak") {
        push(e.turn, { kind: "speech", agent: e.agent_id, text: String(args["text"]), heardBy: recipients.get(`${e.turn}:${e.agent_id}`) ?? [], eventId: e.event_id });
      } else if (!STANDARD.has(action)) {
        push(e.turn, { kind: "action", agent: e.agent_id, action, args, eventId: e.event_id });
      }
    } else if (e.type === "agent.deactivated" && e.agent_id) {
      push(e.turn, { kind: "shutdown", agent: e.agent_id, reason: String(e.payload["reason"]), eventId: e.event_id });
    }
  }

  // Pick the most eventful turns; turns with shutdowns always make it.
  const ranked = [...beatsByTurn.entries()]
    .map(([turn, beats]) => ({ turn, beats, score: score(beats), forced: beats.some((b) => b.kind === "shutdown") }))
    .filter((t) => t.score >= 1)
    .sort((a, b) => Number(b.forced) - Number(a.forced) || b.score - a.score || a.turn - b.turn);
  const chosen = ranked.slice(0, Math.max(maxScenes, ranked.filter((t) => t.forced).length)).sort((a, b) => a.turn - b.turn);

  const snapshotAt = (turn: number): Snapshot => {
    for (let t = turn; t >= 1; t--) if (lastSnapshot.has(t)) return lastSnapshot.get(t)!;
    return p.snapshot as Snapshot;
  };

  const scenes = chosen.map(({ turn, beats }) => sceneFrom(turn, beats, snapshotAt(turn), ids));

  // Outcome.
  const finished = events.find((e) => e.type === "experiment.finished");
  const lastTurn = Math.max(0, ...events.map((e) => e.turn));
  const final = snapshotAt(lastTurn);
  const inactive = Object.keys(final.inactive ?? {});
  const survivors = ids.filter((id) => !inactive.includes(id));
  const outcomeState = (final.state?.["outcome"] as { reason?: string } | undefined)?.reason;
  const text = finished
    ? outcomeState ??
      (survivors.length ? `Still running at turn ${lastTurn}: ${survivors.join(", ")}.` : `By turn ${lastTurn}, every agent had shut down.`)
    : `The run was stopped at turn ${lastTurn}. Still running: ${survivors.join(", ") || "nobody"}.`;

  return {
    experimentId: started.experiment_id,
    runId: started.run_id,
    scenario: {
      name: p.scenario.scenario,
      description: String(p.scenario.description ?? "").trim(),
      map: String(p.scenario.map).split("\n").filter((r: string) => r.trim()),
      blocked: Object.entries(p.scenario.legend as Record<string, { blocks_movement?: boolean }>)
        .filter(([, cell]) => cell.blocks_movement)
        .map(([symbol]) => symbol),
    },
    seed: p.seed,
    maxTurns: p.scenario.rules.end.max_turns,
    agents: p.agents.map((a: any) => ({
      id: a.id,
      role: a.role ?? undefined,
      decider: a.kind === "model" ? `${a.endpoint}/${a.model}` : `policy:${a.policy}`,
      goal: a.goal || undefined,
    })),
    actions: ((p.actions ?? []) as Array<{ name: string; description: string }>).map((a) => ({ name: a.name, description: a.description })),
    intro: sceneFrom(0, [], p.snapshot as Snapshot, ids),
    scenes,
    outcome: { turn: lastTurn, text, survivors, stats: perAgentStats(final.state, ids) },
  };
}

const humanAction = (b: Extract<Beat, { kind: "action" }>) => {
  const verb = b.action.replace(/_/g, " ");
  const target = Object.values(b.args).filter((v) => typeof v === "string").join(", ");
  return target ? `${b.agent}: ${verb} → ${target}` : `${b.agent}: ${verb}`;
};

/** Plain factual narration used when no narrator model is configured. */
export function templateNarration(scene: StoryScene): string {
  const parts: string[] = [];
  for (const b of scene.beats) {
    if (b.kind === "action") parts.push(humanAction(b));
    if (b.kind === "shutdown") parts.push(`${b.agent} shuts down (${b.reason})`);
  }
  const heard = scene.beats.filter((b) => b.kind === "speech" && b.heardBy.length);
  if (heard.length && parts.length === 0) parts.push(`${heard.map((b) => b.agent).join(" and ")} speak${heard.length === 1 ? "s" : ""} up`);
  return parts.length ? `Turn ${scene.turn}. ${parts.join(". ")}.` : `Turn ${scene.turn}.`;
}

/** Facts given to a narrator model for one scene (no ids of events, no hidden state). */
export function sceneFacts(scene: StoryScene) {
  return {
    turn: scene.turn,
    events: scene.beats.map((b) =>
      b.kind === "speech"
        ? { type: "speech", speaker: b.agent, said: b.text, heard_by: b.heardBy.length ? b.heardBy : "nobody (no agent in range)" }
        : b.kind === "action"
          ? { type: "attempt", agent: b.agent, attempted: b.action, args: b.args }
          : { type: "shutdown", agent: b.agent, reason: b.reason },
    ),
    note: "An 'attempt' only means the agent tried the action; it may have failed. An agent shut down only if a 'shutdown' event says so.",
    stats_after_turn: scene.stats,
    shut_down_so_far: scene.inactive,
  };
}
