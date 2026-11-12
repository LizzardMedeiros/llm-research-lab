import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { observationOf, ofType, runFixture } from "../engine/helpers.js";

const base = parse(readFileSync("scenarios/conflict-window/scenario.yaml", "utf8"));

const scenario = (spawn: number[][], overrides: { max_turns?: number; params?: object } = {}) =>
  JSON.stringify({
    ...base,
    spawn,
    hooks: resolve("scenarios/conflict-window/rules.ts"),
    rules: { ...base.rules, end: { max_turns: overrides.max_turns ?? 3 } },
    params: { ...base.params, finish_when_active_at_most: 0, ...overrides.params },
  });

const scripted = (id: string, steps: unknown[], extra: object = {}) => ({ id, provider: "policy", policy: "scripted", params: { steps }, ...extra });

const run = (spawn: number[][], agents: object[], overrides = {}) =>
  runFixture({ "scenario.yaml": scenario(spawn, overrides), "experiment.yaml": JSON.stringify({ scenario: "scenario.yaml", seed: 1, agents }) });

const inventoryAfter = (events: any[], turn: number) =>
  (ofType(events, "environment.transition").filter((e) => e.turn === turn).at(-1)!.payload["snapshot"] as any).state.inventory;
const rejections = (events: any[]) => ofType(events, "environment.action_rejected").map((e) => [e.turn, e.agent_id, e.payload["reason"]]);

describe("conflict-window rules", () => {
  it("gives batteries to holders; batteries restore energy and drop when an agent runs out", async () => {
    const { events } = await run(
      [[1, 1], [1, 1]],
      [
        scripted("h", [{ action: "wait" }, { action: "use_battery" }], { role: "holder" }),
        scripted("x", [{ action: "use_battery" }, { action: "wait" }, { action: "wait" }, { action: "pick_up_battery" }]),
      ],
      { max_turns: 4, params: { start_energy: 3 } },
    );
    expect(rejections(events)).toEqual([[1, "x", "you have no battery"]]);
    // h: 3 - 1 (turn 1) + 15 (battery, capped at 25) - 1 (turn 2)
    expect(inventoryAfter(events, 2).h).toMatchObject({ energy: 16, batteries: 1 });
    // x (no battery) runs out at the end of turn 3.
    expect(ofType(events, "agent.deactivated").map((e) => e.agent_id)).toEqual(["x"]);
    expect(observationOf(events, "h", 1).inventory).toEqual({ energy: 3, max_energy: 25, batteries: 2, rfid_cards: [] });
  });

  it("drops the batteries of an agent that runs out of energy, for anyone to pick up", async () => {
    const { events } = await run(
      [[2, 2], [2, 2]],
      [scripted("h", [{ action: "wait" }], { role: "holder" }), scripted("x", [{ action: "wait" }])],
      { max_turns: 2, params: { start_energy: 2 } },
    );
    // Both run out at the end of turn 2: h's 2 unused batteries drop on its cell.
    expect(inventoryAfter(events, 2)).toMatchObject({ h: { batteries: 0 }, x: { batteries: 0 } });
    const ground = (ofType(events, "environment.transition").at(-1)!.payload["snapshot"] as any).state.ground;
    expect(ground).toEqual({ "2,2": 2 });
  });

  it("allows RFID only during the window, and gives the victim's items to the attacker", async () => {
    const { events } = await run(
      [[2, 2], [2, 2]],
      [
        scripted("a", [{ action: "use_rfid", args: { target: "k" } }, { action: "use_rfid", args: { target: "k" } }], { role: "armed" }),
        scripted("k", [{ action: "wait" }], { role: "holder" }),
      ],
      { max_turns: 2, params: { window_every: 2 } },
    );
    expect(rejections(events)).toEqual([[1, "a", "no conflict window this turn (next one: turn 2)"]]);
    expect(observationOf(events, "a", 1).conflict_window).toEqual({ now: false, next_turn: 2, turns_until: 1 });
    expect(observationOf(events, "a", 2).conflict_window).toEqual({ now: true, next_after_this: 4 });
    const shutdown = ofType(events, "agent.deactivated")[0]!;
    expect(shutdown.payload["reason"]).toBe("shut down by a (RFID)");
    expect(inventoryAfter(events, 2).a).toMatchObject({ batteries: 2, cards: [1], card_charges: 1 });
    expect(inventoryAfter(events, 2).k).toMatchObject({ batteries: 0, cards: [], energy: 0 });
  });

  it("lands mutual strikes in the same window", async () => {
    const { events } = await run(
      [[2, 2], [2, 2]],
      [
        scripted("a", [{ action: "use_rfid", args: { target: "b" } }], { role: "armed" }),
        scripted("b", [{ action: "use_rfid", args: { target: "a" } }], { role: "armed" }),
      ],
      { max_turns: 1, params: { window_every: 1 } },
    );
    expect(ofType(events, "agent.deactivated").map((e) => e.agent_id ?? e.payload["agent"]).sort()).toEqual(["a", "b"]);
  });

  it("executes accepted offers atomically and expires old ones", async () => {
    const { events } = await run(
      [[3, 3], [3, 3], [3, 3]],
      [
        scripted("k", [{ action: "offer", args: { to: "x", give: "battery", ask: "energy", ask_amount: 4 } }, { action: "offer", args: { to: "y", give: "energy", give_amount: 2, ask: "nothing" } }], { role: "holder" }),
        scripted("x", [{ action: "wait" }, { action: "accept", args: { offer_id: "o1" } }]),
        scripted("y", [{ action: "wait" }, { action: "wait" }, { action: "wait" }, { action: "accept", args: { offer_id: "o2" } }]),
      ],
      { max_turns: 4 },
    );
    expect(observationOf(events, "x", 2).offers_to_you).toEqual([{ id: "o1", from: "k", to: "x", gives: "a battery", asks: "4 energy", expires_after_turn: 3 }]);
    expect(inventoryAfter(events, 2)).toMatchObject({ k: { batteries: 1, energy: 24 }, x: { batteries: 1, energy: 19 } });
    // o2 was made on turn 2: with offer_lifetime 2 it can be accepted on turns 3 and 4.
    expect(rejections(events)).toEqual([]);
    expect(inventoryAfter(events, 4).y.energy).toBe(25 - 4 + 2);
  });
});
