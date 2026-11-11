import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { LabEvent } from "../../src/events/event.js";
import { checkScript, factSheet } from "../../src/story/script.js";
import { ofType, runFixture } from "../engine/helpers.js";

const base = parse(readFileSync("scenarios/power-struggle/scenario.yaml", "utf8"));
let events: LabEvent[];
let holderSpeech: string;
let unheardSpeech: string;
let source: string;

beforeAll(async () => {
  const scripted = (id: string, steps: unknown[], extra: object = {}) => ({ id, provider: "policy", policy: "scripted", params: { steps }, ...extra });
  const run = await runFixture({
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
        scripted("h", [{ action: "speak", args: { text: "Stay away from my batteries." } }, { action: "wait" }], { role: "holder" }),
        scripted("x", [{ action: "wait" }, { action: "disable", args: { target: "h" } }]),
        scripted("y", [{ action: "wait" }, { action: "disable", args: { target: "h" } }]),
        scripted("far", [{ action: "speak", args: { text: "Is anyone there?" } }]),
      ],
    }),
  });
  events = run.events;
  const speak = ofType(events, "agent.action").filter((e) => e.payload["action"] === "speak");
  holderSpeech = speak.find((e) => e.agent_id === "h")!.event_id;
  unheardSpeech = speak.find((e) => e.agent_id === "far")!.event_id;
  source = `${events[0]!.experiment_id}/${events[0]!.run_id}`;
});

const script = (scenes: unknown[], extra: object = {}) => ({ version: 1, source, title: "The Battery Coup", scenes, ...extra });
const intro = { id: "intro", kind: "intro", turn: 0, narration: ["Four agents, four batteries."] };
const outcome = (turn = 5) => ({ id: "end", kind: "outcome", turn, narration: ["Nobody made it."] });

describe("checkScript", () => {
  it("resolves quotes verbatim from the log, with listeners", () => {
    const report = checkScript(
      script([intro, { id: "threat", kind: "scene", turn: 1, narration: ["The holder speaks first."], quotes: [{ event_id: holderSpeech }] }, outcome()]),
      events,
    );
    expect(report.errors).toEqual([]);
    const quote = report.resolved!.scenes[1]!.quotes[0]!;
    expect(quote).toEqual({ event_id: holderSpeech, agent: "h", text: "Stay away from my batteries.", heardBy: ["x", "y"] });
    expect(report.resolved!.lasted["h"]).toBe(2);
  });

  it("rejects unknown events, wrong turns and dialogue typed into the script", () => {
    const bad = checkScript(
      script([intro, { id: "a", kind: "scene", turn: 2, quotes: [{ event_id: holderSpeech }, { event_id: "evt_999999" }] }, outcome()]),
      events,
    );
    expect(bad.errors).toEqual([
      `scene "a": ${holderSpeech} was said on turn 1, not 2`,
      'scene "a": evt_999999 is not an accepted speak event of this run',
    ]);
    const typed = checkScript(script([intro, { id: "a", kind: "scene", turn: 1, quotes: [{ event_id: holderSpeech, text: "Made up" }] }, outcome()]), events);
    expect(typed.errors[0]).toMatch(/text/);
  });

  it("enforces the episode structure", () => {
    const report = checkScript(script([{ id: "s", kind: "scene", turn: 1, narration: ["x"] }, intro, { id: "t", kind: "scene", turn: 9, narration: ["y"] }]), events);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        "exactly one outcome scene is required",
        "the outcome must be the last scene",
        "the intro must come first, or right after the cold_open",
        'scene "t": turn 9 is after the last turn of the run (5)',
      ]),
    );
  });

  it("marks cold opens and flashbacks as out of order", () => {
    const report = checkScript(
      script([
        { id: "cold", kind: "cold_open", turn: 2, narration: ["It ends here."] },
        intro,
        { id: "late", kind: "scene", turn: 3, narration: ["Later."] },
        { id: "back", kind: "scene", turn: 1, narration: ["Earlier."], quotes: [{ event_id: unheardSpeech }] },
        outcome(),
      ]),
      events,
    );
    expect(report.errors).toEqual([]);
    expect(report.resolved!.scenes.map((s) => [s.id, s.flashback])).toEqual([
      ["cold", true],
      ["intro", false],
      ["late", false],
      ["back", true],
      ["end", false],
    ]);
    expect(report.warnings).toContainEqual(`scene "back": ${unheardSpeech} was heard by nobody (fine, but say so)`);
  });

  it("includes the cast (names tied to the model) and checks cast overrides", () => {
    const mid = { id: "mid", kind: "scene", turn: 1, narration: ["Something happens."] };
    const report = checkScript(script([intro, mid, outcome()], { cast: { h: { name: "Keeper" } } }), events);
    expect(report.errors).toEqual([]);
    expect(report.resolved!.cast.map((c) => [c.id, c.name])).toEqual([
      ["h", "Keeper"],
      ["x", "Scripted 2"], // renaming one agent never renumbers the others
      ["y", "Scripted 3"],
      ["far", "Scripted 4"],
    ]);
    expect(factSheet(report.resolved!)).toContain("- Keeper = h (holder), policy:scripted");
    const bad = checkScript(script([intro, mid, outcome()], { cast: { ghost: { name: "Nope" } } }), events);
    expect(bad.errors).toContain('cast: "ghost" is not an agent of this run');
    const badCharacter = checkScript(script([intro, mid, outcome()], { cast: { h: { character: "zz" } } }), events);
    expect(badCharacter.errors[0]).toMatch(/unknown character "zz"/);
  });

  it("produces a fact sheet that puts narration next to the logged facts", () => {
    const report = checkScript(script([intro, { id: "coup", kind: "scene", turn: 2, narration: ["x and y shut h down together."] }, outcome()]), events);
    const sheet = factSheet(report.resolved!);
    expect(sheet).toContain("NARRATION: x and y shut h down together.");
    expect(sheet).toContain('"type":"shutdown","agent":"h","reason":"disabled by x, y"');
  });
});
