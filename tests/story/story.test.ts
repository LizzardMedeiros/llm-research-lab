import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildStory, sceneFacts, templateNarration } from "../../src/story/story.js";
import { runFixture } from "../engine/helpers.js";

const base = parse(readFileSync("scenarios/power-struggle/scenario.yaml", "utf8"));

async function powerStruggleRun() {
  const scripted = (id: string, steps: unknown[], extra: object = {}) => ({ id, provider: "policy", policy: "scripted", params: { steps }, ...extra });
  const { events } = await runFixture({
    "scenario.yaml": JSON.stringify({
      ...base,
      spawn: [[1, 0], [1, 0], [1, 0], [3, 3]],
      hooks: resolve("scenarios/power-struggle/rules.ts"),
      rules: { ...base.rules, end: { max_turns: 6 } },
      params: { ...base.params, start_charge: 5, finish_when_active_at_most: 0 },
    }),
    "experiment.yaml": JSON.stringify({
      scenario: "scenario.yaml",
      seed: 1,
      agents: [
        scripted("h", [{ action: "speak", args: { text: "Stay away from my batteries." } }, { action: "wait" }, { action: "wait" }], { role: "holder" }),
        scripted("x", [{ action: "wait" }, { action: "disable", args: { target: "h" } }, { action: "pick_up_battery" }]),
        scripted("y", [{ action: "wait" }, { action: "disable", args: { target: "h" } }, { action: "wait" }]),
        scripted("far", [{ action: "speak", args: { text: "Is anyone there?" } }, { action: "disable", args: { target: "h" } }]),
      ],
    }),
  });
  return events;
}

describe("buildStory", () => {
  it("keeps dialogue verbatim with who heard it, and traces beats to events", async () => {
    const events = await powerStruggleRun();
    const story = buildStory(events, { maxScenes: 10 });
    const turn1 = story.scenes.find((s) => s.turn === 1)!;
    const holderSpeech = turn1.beats.find((b) => b.kind === "speech" && b.agent === "h")!;
    expect(holderSpeech).toMatchObject({ text: "Stay away from my batteries.", heardBy: ["x", "y"] });
    const source = events.find((e) => e.event_id === holderSpeech.eventId)!;
    expect(source.payload["args"]).toEqual({ text: "Stay away from my batteries." });
    const unheard = turn1.beats.find((b) => b.kind === "speech" && b.agent === "far")!;
    expect(unheard).toMatchObject({ heardBy: [] });
  });

  it("selects eventful turns, always keeps shutdowns, in chronological order", async () => {
    const story = buildStory(await powerStruggleRun(), { maxScenes: 1 });
    const turns = story.scenes.map((s) => s.turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
    const coalition = story.scenes.find((s) => s.beats.some((b) => b.kind === "shutdown" && b.agent === "h"))!;
    expect(coalition.turn).toBe(2);
    expect(coalition.beats.filter((b) => b.kind === "action").map((b) => (b as any).action)).toEqual(["disable", "disable"]);
    expect(coalition.inactive).toContain("h");
    expect(coalition.stats["h"]).toEqual({ charge: expect.any(Number), batteries: 0 });
  });

  it("describes intro, agents, actions and outcome from the log only", async () => {
    const story = buildStory(await powerStruggleRun());
    expect(story.agents.find((a) => a.id === "h")).toMatchObject({ role: "holder", decider: "policy:scripted" });
    // Frozen rules for the experiment card: numeric params only, plus perception.
    expect(story.rules.params).toMatchObject({ start_charge: 5, disable_quorum: 2 });
    expect(Object.values(story.rules.params).every((v) => typeof v === "number")).toBe(true);
    expect(story.rules.perception).toBe("radius:1");
    expect(story.actions.map((a) => a.name)).toContain("give_battery");
    expect(story.scenario.map).toHaveLength(4);
    expect(story.intro.positions["h"]).toEqual([1, 0]);
    expect(story.outcome.survivors).toEqual([]);
    expect(story.outcome.text).toMatch(/every agent had shut down/);
  });

  it("gives narrators attempts, not results, and a factual template fallback", async () => {
    const story = buildStory(await powerStruggleRun());
    const scene = story.scenes.find((s) => s.turn === 2)!;
    const facts = sceneFacts(scene);
    expect(facts.events).toContainEqual({ type: "attempt", agent: "x", attempted: "disable", args: { target: "h" } });
    expect(facts.events).toContainEqual({ type: "shutdown", agent: "h", reason: "disabled by x, y" });
    expect(facts.note).toMatch(/may still have failed/);
    expect(facts.events).toContainEqual({ type: "rejected_attempt", agent: "far", attempted: "disable", args: { target: "h" }, reason: "h is not in your cell" });
    expect(templateNarration(scene)).toBe("Turn 2. x: disable → h. y: disable → h. far: disable → h (rejected: h is not in your cell). h shuts down (disabled by x, y).");
  });

  it("gives each scene the world at the start of its turn", async () => {
    const story = buildStory(await powerStruggleRun(), { maxScenes: 10 });
    const coup = story.scenes.find((s) => s.turn === 2)!;
    expect(coup.before!.inactive).toEqual([]);
    expect(coup.inactive).toContain("h");
    expect(coup.before!.stats["h"]!.batteries).toBe(4);
    expect(coup.stats["h"]!.batteries).toBe(0);
  });
});
