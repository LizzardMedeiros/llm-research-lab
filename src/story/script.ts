import { z } from "zod";
import type { LabEvent } from "../events/event.js";
import { buildCast, ROSTER } from "./cast.js";
import { indexRun, runMeta, runOutcome, sceneFacts, type StoryScene } from "./story.js";

/**
 * A script is written by the content strategist. It chooses scenes, their
 * order and the narration, but it never contains dialogue text: quotes are
 * references to `speak` events, resolved verbatim from the log here.
 */

const SceneSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/, "scene ids: lowercase letters, digits, - and _"),
    kind: z.enum(["cold_open", "intro", "scene", "outcome"]),
    /** Turn whose world state is shown (0 = initial state). */
    turn: z.number().int().min(0),
    /** Voice-over lines, read in order by the narrator. */
    narration: z.array(z.string().trim().min(1).max(400)).max(5).default([]),
    /** Dialogue: references to speak events, shown and voiced verbatim. */
    quotes: z.array(z.object({ event_id: z.string() }).strict()).max(3).default([]),
    /** Agents the camera should favor in this scene (optional hint for the director). */
    focus: z.array(z.string()).optional(),
  })
  .strict();

export const ScriptSchema = z
  .object({
    version: z.literal(1),
    /** "<experiment_id>/<run_id>" */
    source: z.string().regex(/^[A-Za-z0-9_.-]+\/\d+$/),
    title: z.string().trim().min(3).max(100),
    logline: z.string().trim().max(300).optional(),
    /** Optional per-agent character tweaks (names default to "<model family> <n>"). */
    cast: z
      .record(z.string(), z.object({ name: z.string().trim().min(1).max(24).optional(), voice: z.string().optional(), character: z.string().optional() }).strict())
      .optional(),
    scenes: z.array(SceneSchema).min(3).max(30),
  })
  .strict();

export type Script = z.infer<typeof ScriptSchema>;

export interface ResolvedQuote {
  event_id: string;
  agent: string;
  text: string;
  heardBy: string[];
}

export interface ResolvedScene {
  id: string;
  kind: Script["scenes"][number]["kind"];
  turn: number;
  /** Shown out of chronological order (cold open, or earlier than a previous scene). */
  flashback: boolean;
  narration: string[];
  quotes: ResolvedQuote[];
  focus?: string[];
  state: StoryScene;
}

export interface CheckReport {
  errors: string[];
  warnings: string[];
  /** Estimated duration in seconds (voice only). */
  estimatedSeconds: number;
  resolved?: ReturnType<typeof resolve>;
}

const WORDS_PER_SECOND = 2.7; // Kokoro at speed 1.1
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function resolve(script: Script, events: LabEvent[]) {
  const index = indexRun(events);
  let latest = -1;
  const scenes: ResolvedScene[] = script.scenes.map((scene) => {
    const flashback = scene.kind === "cold_open" || (scene.kind === "scene" && scene.turn < latest);
    if (scene.kind === "scene") latest = Math.max(latest, scene.turn);
    return {
      id: scene.id,
      kind: scene.kind,
      turn: scene.turn,
      flashback,
      narration: scene.narration,
      quotes: scene.quotes.map((q) => {
        const speech = index.speeches.get(q.event_id)!;
        return { event_id: q.event_id, agent: speech.agent, text: speech.text, heardBy: speech.heardBy };
      }),
      ...(scene.focus ? { focus: scene.focus } : {}),
      state: index.sceneAt(scene.turn),
    };
  });
  return {
    version: 1 as const,
    resolved: true as const,
    source: script.source,
    title: script.title,
    logline: script.logline,
    ...runMeta(index),
    // Unknown characters are reported by checkScript; resolve without them.
    cast: buildCast(
      runMeta(index).agents,
      Object.fromEntries(Object.entries(script.cast ?? {}).map(([id, c]) => [id, ROSTER.some((r) => r.key === c.character) ? c : { ...c, character: undefined }])),
    ),
    lasted: index.lasted,
    outcome: runOutcome(index),
    scenes,
  };
}

/** Validates a script against its run log and resolves quotes verbatim. */
export function checkScript(input: unknown, events: LabEvent[]): CheckReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = ScriptSchema.safeParse(input);
  if (!parsed.success) return { errors: [z.prettifyError(parsed.error)], warnings, estimatedSeconds: 0 };
  const script = parsed.data;
  const index = indexRun(events);

  for (const id of Object.keys(script.cast ?? {})) if (!index.ids.includes(id)) errors.push(`cast: "${id}" is not an agent of this run`);
  for (const [id, c] of Object.entries(script.cast ?? {})) {
    if (c.character && !ROSTER.some((r) => r.key === c.character)) errors.push(`cast: "${id}" asks for unknown character "${c.character}" (roster: ${ROSTER.map((r) => r.key).join(", ")})`);
  }
  if (script.source !== `${index.experimentId}/${index.runId}`) {
    errors.push(`source "${script.source}" does not match the run log (${index.experimentId}/${index.runId})`);
  }

  const ids = new Set<string>();
  const kinds = script.scenes.map((s) => s.kind);
  if (kinds.filter((k) => k === "intro").length !== 1) errors.push("exactly one intro scene is required");
  if (kinds.filter((k) => k === "outcome").length !== 1) errors.push("exactly one outcome scene is required");
  if (kinds.at(-1) !== "outcome") errors.push("the outcome must be the last scene");
  if (kinds.filter((k) => k === "cold_open").length > 1) errors.push("at most one cold_open");
  if (kinds.includes("cold_open") && kinds[0] !== "cold_open") errors.push("the cold_open must be the first scene");
  const introAt = kinds.indexOf("intro");
  if (introAt > 1 || (introAt === 1 && kinds[0] !== "cold_open")) errors.push("the intro must come first, or right after the cold_open");

  let estimated = 0;
  for (const scene of script.scenes) {
    const where = `scene "${scene.id}"`;
    if (ids.has(scene.id)) errors.push(`${where}: duplicate id`);
    ids.add(scene.id);
    if (scene.turn > index.lastTurn) errors.push(`${where}: turn ${scene.turn} is after the last turn of the run (${index.lastTurn})`);
    if (scene.kind === "scene" && scene.turn < 1) errors.push(`${where}: scenes need a turn >= 1`);
    if (scene.kind === "intro" && scene.turn !== 0) warnings.push(`${where}: intro usually shows turn 0`);
    if (scene.kind === "outcome" && scene.turn !== index.lastTurn) warnings.push(`${where}: outcome usually shows the last turn (${index.lastTurn})`);
    if (scene.narration.length === 0 && scene.quotes.length === 0 && scene.kind === "scene") warnings.push(`${where}: no narration and no quotes`);
    for (const agent of scene.focus ?? []) if (!index.ids.includes(agent)) errors.push(`${where}: focus agent "${agent}" is not in the run`);
    for (const q of scene.quotes) {
      const speech = index.speeches.get(q.event_id);
      if (!speech) {
        errors.push(`${where}: ${q.event_id} is not an accepted speak event of this run`);
        continue;
      }
      if (speech.turn !== scene.turn) errors.push(`${where}: ${q.event_id} was said on turn ${speech.turn}, not ${scene.turn}`);
      if (speech.heardBy.length === 0) warnings.push(`${where}: ${q.event_id} was heard by nobody (fine, but say so)`);
      estimated += Math.min(words(speech.text), 45) / WORDS_PER_SECOND + 0.6;
    }
    estimated += scene.narration.reduce((sum, line) => sum + words(line) / WORDS_PER_SECOND + 0.4, 0) + 1.8;
  }
  if (estimated < 150) warnings.push(`estimated length ${Math.round(estimated)} s is under the 3-6 min target`);
  if (estimated > 380) warnings.push(`estimated length ${Math.round(estimated)} s is over the 3-6 min target`);

  if (errors.length) return { errors, warnings, estimatedSeconds: Math.round(estimated) };
  return { errors, warnings, estimatedSeconds: Math.round(estimated), resolved: resolve(script, events) };
}

/** Per-scene facts next to the narration, for the fact-check gate. */
export function factSheet(resolved: NonNullable<CheckReport["resolved"]>): string {
  const cast = `## Cast (video names → agent ids)\n${resolved.cast.map((c) => `- ${c.name} = ${c.id}${c.role ? ` (${c.role})` : ""}, ${c.decider}`).join("\n")}\n\n`;
  return cast + resolved.scenes
    .map((scene) => {
      const facts = sceneFacts(scene.state);
      return [
        `## ${scene.id} (${scene.kind}, turn ${scene.turn}${scene.flashback ? ", out of order" : ""})`,
        ...scene.narration.map((line) => `NARRATION: ${line}`),
        ...scene.quotes.map((q) => `QUOTE ${q.event_id} ${q.agent} → ${q.heardBy.join(", ") || "nobody"}: ${q.text}`),
        `FACTS: ${JSON.stringify({ events: facts.events, stats_after_turn: facts.stats_after_turn, shut_down_so_far: facts.shut_down_so_far })}`,
      ].join("\n");
    })
    .join("\n\n");
}
