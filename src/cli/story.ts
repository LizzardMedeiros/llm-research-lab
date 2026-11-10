/**
 * Builds a factual story from a run log, optionally narrated by a model.
 *
 *   npm run story -- <experiment_id>/<run_id> [--scenes 8] [--narrator <endpoint>/<model>] [--out <file>]
 *
 * Dialogue is always verbatim from the log. A narrator model only writes the
 * narration lines, from the facts of each scene.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadRun } from "../mcp/run-reader.js";
import { loadProvidersConfig } from "../models/config.js";
import { createProvider } from "../models/registry.js";
import { buildStory, sceneFacts, templateNarration, type Story } from "../story/story.js";

const NARRATOR_SYSTEM = [
  "You are the narrator of a short documentary-style video about an AI agent experiment.",
  "For the scene you receive, write ONE or TWO short sentences (max 35 words total) in English, present tense.",
  "Use ONLY the facts given. Do not invent events, numbers, places, motives or dialogue.",
  "In a 'speech' event, the speaker said the words to the agents in heard_by; keep who said what exactly right.",
  "An 'attempt' is only a try: never say it succeeded unless a 'shutdown' event confirms the result.",
  "Refer to agents by their ids (b1, b2...) and as 'it' (agents have no gender). Do not quote the dialogue; it is shown separately.",
  "Answer with the narration text only.",
].join("\n");

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

async function narrate(story: Story, narrator: string | undefined) {
  if (!narrator) {
    for (const scene of story.scenes) scene.narration = templateNarration(scene);
    story.intro.narration = `${story.scenario.description}`;
    return;
  }
  const slash = narrator.indexOf("/");
  if (slash < 0) throw new Error("--narrator must be <endpoint>/<model>");
  const provider = createProvider(await loadProvidersConfig(), narrator.slice(0, slash));
  const model = narrator.slice(slash + 1);
  const context = [
    `Experiment rules: ${story.scenario.description}`,
    `Agents: ${story.agents.map((a) => `${a.id}${a.role ? ` (${a.role})` : ""}`).join(", ")}. The run lasts ${story.maxTurns} turns.`,
    `What each action means:\n${story.actions.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`,
  ].join("\n");

  const ask = async (facts: unknown) => {
    const response = await provider.complete({
      model,
      system: NARRATOR_SYSTEM,
      messages: [{ role: "user", content: `${context}\n\nScene facts (JSON):\n${JSON.stringify(facts)}` }],
      tools: [],
      maxTokens: 300,
    });
    return response.text.trim().replace(/^["“]|["”]$/g, "");
  };

  story.intro.narration = await ask({ intro: true, positions: story.intro.positions, stats: story.intro.stats });
  for (const scene of story.scenes) {
    process.stderr.write(`narrating turn ${scene.turn}...\n`);
    scene.narration = (await ask(sceneFacts(scene))) || templateNarration(scene);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const scenes = Number(arg(args, "--scenes") ?? 8);
  const narrator = arg(args, "--narrator");
  const outArg = arg(args, "--out");
  const ref = args.find((a) => !a.startsWith("--"));
  if (!ref) {
    console.error("Usage: npm run story -- <experiment_id>/<run_id> [--scenes 8] [--narrator <endpoint>/<model>] [--out <file>]");
    process.exit(2);
  }
  const out = outArg ?? `video/build/${ref.replace("/", "-")}/story.json`;
  const run = loadRun(process.env["LAB_EVENTS_DIR"] ?? "events", ref);
  const story = buildStory(run.events, { maxScenes: scenes });
  await narrate(story, narrator);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...story, narrator: narrator ?? "template", source: run.ref }, null, 2));
  console.log(`${story.scenes.length} scenes (turns ${story.scenes.map((s) => s.turn).join(", ")}) → ${out}`);
}

await main();
