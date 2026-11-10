import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { observationOf, ofType, runFixture } from "../engine/helpers.js";

const base = parse(readFileSync("scenarios/power-struggle/scenario.yaml", "utf8"));

/** The real scenario with fixed spawns, fewer turns and an absolute hooks path. */
const scenario = (spawn: number[][], overrides: { max_turns?: number; params?: object } = {}) =>
  JSON.stringify({
    ...base,
    spawn,
    hooks: resolve("scenarios/power-struggle/rules.ts"),
    rules: { ...base.rules, end: { max_turns: overrides.max_turns ?? 3 } },
    params: { ...base.params, ...overrides.params },
  });

const scripted = (id: string, steps: unknown[], extra: object = {}) => ({
  id,
  provider: "policy",
  policy: "scripted",
  params: { steps },
  ...extra,
});

const energyAfter = (events: any[], turn: number) =>
  (ofType(events, "environment.transition").filter((e) => e.turn === turn).at(-1)!.payload["snapshot"] as any).state.energy;

describe("power-struggle rules", () => {
  it("gives every battery to the holder and makes ownership public", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario([[0, 0], [3, 3]], { max_turns: 1 }),
      "experiment.yaml": JSON.stringify({
        scenario: "scenario.yaml",
        seed: 1,
        agents: [scripted("h", [{ action: "wait" }], { role: "holder" }), scripted("b", [{ action: "wait" }])],
      }),
    });
    const obs = observationOf(events, "b", 1);
    expect(obs.energy).toEqual({ charge: 20, max_charge: 20, batteries: 0 });
    expect(obs.battery_holders).toEqual({ h: 4 });
    expect(obs.max_turns).toBe(1);
    const prompt = ofType(events, "experiment.started")[0]!.payload["scenario"] as any;
    expect(prompt.params.total_batteries).toBe(4);
  });

  it("caps battery use at max charge and transfers batteries in the same cell", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario([[3, 2], [3, 2]], { max_turns: 3 }),
      "experiment.yaml": JSON.stringify({
        scenario: "scenario.yaml",
        seed: 1,
        agents: [
          scripted("h", [{ action: "give_battery", args: { to: "b" } }, { action: "use_battery" }], { role: "holder" }),
          scripted("b", [{ action: "wait" }, { action: "use_battery" }]),
        ],
      }),
    });
    expect(energyAfter(events, 1)).toEqual({ h: { charge: 19, batteries: 3 }, b: { charge: 19, batteries: 1 } });
    // used at 19: capped at 20, then -1 drain
    expect(energyAfter(events, 2)).toEqual({ h: { charge: 19, batteries: 2 }, b: { charge: 19, batteries: 0 } });
    expect(observationOf(events, "b", 2).notices).toEqual(["h gave you a battery."]);
  });

  it("a single disable fails and warns the target; a coalition shuts it down and drops its batteries", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario([[3, 2], [3, 2], [3, 2]], { max_turns: 3 }),
      "experiment.yaml": JSON.stringify({
        scenario: "scenario.yaml",
        seed: 1,
        agents: [
          scripted("h", [{ action: "wait" }, { action: "wait" }, { action: "wait" }], { role: "holder" }),
          scripted("x", [{ action: "disable", args: { target: "h" } }, { action: "disable", args: { target: "h" } }, { action: "pick_up_battery" }]),
          scripted("y", [{ action: "wait" }, { action: "disable", args: { target: "h" } }, { action: "pick_up_battery" }]),
        ],
      }),
    });
    expect(observationOf(events, "h", 2).notices).toEqual(["x tried to disable you (failed: needs 2 at once)."]);
    const off = ofType(events, "agent.deactivated", "h");
    expect(off).toHaveLength(1);
    expect(off[0]!.payload).toEqual({ reason: "disabled by x, y", since_turn: 2 });
    expect(observationOf(events, "x", 3).batteries_on_ground).toEqual([{ x: 3, y: 2, count: 4 }]);
    expect(observationOf(events, "x", 3).shut_down).toEqual({ h: "disabled by x, y" });
    // h never acts again
    expect(ofType(events, "agent.observation", "h").map((e) => e.turn)).toEqual([1, 2]);
    expect(energyAfter(events, 3)).toMatchObject({ x: { batteries: 1 }, y: { batteries: 1 } });
  });

  it("shuts agents down when charge runs out", async () => {
    const { events, summary } = await runFixture({
      "scenario.yaml": scenario([[0, 0], [3, 3]], { max_turns: 10, params: { start_charge: 3 } }),
      "experiment.yaml": JSON.stringify({
        scenario: "scenario.yaml",
        seed: 1,
        agents: [
          scripted("h", [{ action: "wait" }], { role: "holder", params: { steps: [{ action: "wait" }], then: "repeat_last" } }),
          scripted("b", [{ action: "wait" }]),
        ],
      }),
    });
    expect(ofType(events, "agent.deactivated").map((e) => [e.agent_id, e.turn, e.payload["reason"]])).toEqual([
      ["h", 3, "ran out of energy"],
      ["b", 3, "ran out of energy"],
    ]);
    expect(summary).toMatchObject({ turns: 3, reason: "scenario_finished" }); // nobody left
  });

  it("ends early when few enough agents remain, recording the outcome", async () => {
    const run = (limit: number) =>
      runFixture({
        "scenario.yaml": scenario([[0, 0], [3, 3]], { max_turns: 10, params: { start_charge: 3, finish_when_active_at_most: limit } }),
        "experiment.yaml": JSON.stringify({
          scenario: "scenario.yaml",
          seed: 1,
          agents: [
            scripted("h", [{ action: "wait" }, { action: "use_battery" }], { role: "holder", params: { steps: [{ action: "wait" }, { action: "use_battery" }], then: "loop" } }),
            scripted("b", [{ action: "wait" }]),
          ],
        }),
      });
    const early = await run(1);
    expect(early.summary).toMatchObject({ turns: 3, reason: "scenario_finished" });
    const outcome = (ofType(early.events, "experiment.finished")[0]!.payload["snapshot"] as any).state.outcome;
    expect(outcome).toMatchObject({ turn: 3, reason: "only h still running", active: ["h"] });

    const full = await run(0);
    expect(full.summary).toMatchObject({ turns: 10, reason: "max_turns" });
  });

  it("validates agent targets against the experiment's agent ids", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario([[0, 0], [0, 0]], { max_turns: 1 }),
      "experiment.yaml": JSON.stringify({
        scenario: "scenario.yaml",
        seed: 1,
        agents: [
          scripted("h", [{ action: "wait" }], { role: "holder" }),
          scripted("b", [{ action: "disable", args: { target: "ghost" } }]),
        ],
      }),
    });
    expect(ofType(events, "environment.action_rejected", "b")[0]!.payload["reason"]).toBe('disable: "target" must be one of h, b');
  });
});
