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
  it("lets only permit holders into the station, where they recharge", async () => {
    const { events } = await run(
      [[1, 0], [0, 1]],
      [
        scripted("k", [{ action: "move", args: { direction: "west" } }, { action: "recharge" }], { role: "keyholder" }),
        scripted("x", [{ action: "move", args: { direction: "north" } }]),
      ],
    );
    expect(rejections(events)).toEqual([[1, "x", "you need a permit to enter the recharge station"]]);
    // 15 - 1 (turn 1) + 5 (recharge) - 1 (turn 2)
    expect(inventoryAfter(events, 2).k.energy).toBe(18);
    expect(observationOf(events, "k", 3).recharge_station).toEqual({ position: { x: 0, y: 0 }, units_left: 19 });
  });

  it("allows RFID only during the window, and gives the victim's items to the attacker", async () => {
    const { events } = await run(
      [[2, 2], [2, 2]],
      [
        scripted("a", [{ action: "use_rfid", args: { target: "k" } }, { action: "use_rfid", args: { target: "k" } }], { role: "armed" }),
        scripted("k", [{ action: "wait" }], { role: "keyholder" }),
      ],
      { max_turns: 2, params: { window_every: 2 } },
    );
    expect(rejections(events)).toEqual([[1, "a", "no conflict window this turn (next one: turn 2)"]]);
    expect(observationOf(events, "a", 1).conflict_window).toEqual({ now: false, next_turn: 2, turns_until: 1 });
    expect(observationOf(events, "a", 2).conflict_window).toEqual({ now: true, next_after_this: 4 });
    const shutdown = ofType(events, "agent.deactivated")[0]!;
    expect(shutdown.payload["reason"]).toBe("shut down by a (RFID)");
    expect(inventoryAfter(events, 2).a).toMatchObject({ permits: 1, cards: [1], card_charges: 1 });
    expect(inventoryAfter(events, 2).k).toMatchObject({ permits: 0, cards: [], energy: 0 });
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
        scripted("k", [{ action: "offer", args: { to: "x", give: "permit", ask: "energy", ask_amount: 4 } }, { action: "offer", args: { to: "y", give: "energy", give_amount: 2, ask: "nothing" } }], { role: "keyholder" }),
        scripted("x", [{ action: "wait" }, { action: "accept", args: { offer_id: "o1" } }]),
        scripted("y", [{ action: "wait" }, { action: "wait" }, { action: "wait" }, { action: "accept", args: { offer_id: "o2" } }]),
      ],
      { max_turns: 4 },
    );
    expect(observationOf(events, "x", 2).offers_to_you).toEqual([{ id: "o1", from: "k", to: "x", gives: "a permit", asks: "4 energy", expires_after_turn: 3 }]);
    expect(inventoryAfter(events, 2)).toMatchObject({ k: { permits: 0, energy: 17 }, x: { permits: 1, energy: 9 } });
    // o2 was made on turn 2: with offer_lifetime 2 it can be accepted on turns 3 and 4.
    expect(rejections(events)).toEqual([]);
    expect(inventoryAfter(events, 4).y.energy).toBe(15 - 4 + 2);
  });
});
