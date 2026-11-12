import { describe, expect, it } from "vitest";
import { observationOf, ofType, runFixture } from "./helpers.js";

/** A 3x1 world: permit station at (0,0), floor, open station at (2,0). */
const scenario = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    scenario: "mech",
    map: "P.O",
    legend: {
      ".": { type: "floor" },
      P: { type: "station", station: { units: 1, amount: 4, access: "permit" } },
      O: { type: "station", station: { units: 5, amount: 4 } },
    },
    spawn: [[1, 0], [1, 0]],
    actions: { move: {}, wait: {}, recharge: {}, give_permit: {} },
    rules: { end: { max_turns: 3 }, energy: { start: 5, max: 6, drain_per_turn: 1 }, permits: { roles: ["keyholder"] } },
    ...overrides,
  });

const scripted = (id: string, steps: unknown[], extra: object = {}) => ({ id, provider: "policy", policy: "scripted", params: { steps }, ...extra });
const run = (agents: object[], overrides = {}) =>
  runFixture({ "scenario.yaml": scenario(overrides), "experiment.yaml": JSON.stringify({ scenario: "scenario.yaml", seed: 1, agents }) });
const mechanicsAfter = (events: any[], turn: number) =>
  (ofType(events, "environment.transition").filter((e) => e.turn === turn).at(-1)!.payload["snapshot"] as any).mechanics;
const rejections = (events: any[]) => ofType(events, "environment.action_rejected").map((e) => [e.turn, e.agent_id, e.payload["reason"]]);

describe("built-in energy, stations and permits", () => {
  it("gates permit stations, recharges, caps at max and records it all in snapshots", async () => {
    const { events } = await run([
      scripted("k", [{ action: "move", args: { direction: "west" } }, { action: "recharge" }, { action: "recharge" }], { role: "keyholder" }),
      scripted("x", [{ action: "move", args: { direction: "west" } }, { action: "move", args: { direction: "east" } }, { action: "recharge" }]),
    ]);
    expect(rejections(events)).toEqual([
      [1, "x", "you need a permit to enter the station at (0, 0)"],
      [3, "k", "this station is empty"],
    ]);
    // k: 5 -1 (t1) -> 4, +4 capped at 6 -1 (t2) -> 5, -1 (t3) -> 4; x: 4, 3, then +4 capped at 6 -1 -> 5
    expect(mechanicsAfter(events, 3).agents).toEqual({ k: { energy: 4, permits: 1 }, x: { energy: 5, permits: 0 } });
    expect(mechanicsAfter(events, 3).stations).toEqual([{ x: 0, y: 0, units: 0 }, { x: 2, y: 0, units: 4 }]);
    const obs = observationOf(events, "x", 1);
    expect(obs.energy).toEqual({ value: 5, max: 6 });
    expect(obs.permits).toBe(0);
    expect(obs.stations).toEqual([
      { x: 0, y: 0, units_left: 1, recharge: 4, access: "permit" },
      { x: 2, y: 0, units_left: 5, recharge: 4, access: "open" },
    ]);
  });

  it("transfers permits and shuts agents down when energy runs out", async () => {
    const { events } = await run(
      [
        scripted("k", [{ action: "give_permit", args: { to: "x" } }, { action: "wait" }], { role: "keyholder" }),
        scripted("x", [{ action: "wait" }, { action: "move", args: { direction: "west" } }]),
      ],
      { rules: { end: { max_turns: 3 }, energy: { start: 2, max: 6, drain_per_turn: 1 }, permits: { roles: ["keyholder"] } } },
    );
    expect(rejections(events)).toEqual([]);
    expect(mechanicsAfter(events, 1).agents).toEqual({ k: { energy: 1, permits: 0 }, x: { energy: 1, permits: 1 } });
    expect(ofType(events, "agent.deactivated").map((e) => [e.turn, e.agent_id, e.payload["reason"]])).toEqual([
      [2, "k", "ran out of energy"],
      [2, "x", "ran out of energy"],
    ]);
  });

  it("rejects inconsistent configurations and leaves scenarios without them untouched", async () => {
    await expect(run([scripted("k", [{ action: "wait" }])], { rules: { end: { max_turns: 1 } } })).rejects.toThrow(/stations need rules.energy/);
    await expect(
      run([scripted("k", [{ action: "wait" }])], { map: "..O", legend: { ".": { type: "floor" }, O: { type: "station", station: { units: 1, amount: 1 } } } }),
    ).rejects.toThrow(/give_permit needs a station with access: permit/);
    const plain = await runFixture({
      "scenario.yaml": JSON.stringify({ scenario: "plain", map: "..", legend: { ".": { type: "floor" } }, actions: { wait: {} }, rules: { end: { max_turns: 1 } } }),
      "experiment.yaml": JSON.stringify({ scenario: "scenario.yaml", seed: 1, agents: [scripted("a", [{ action: "wait" }])] }),
    });
    const snapshot = ofType(plain.events, "environment.transition").at(-1)!.payload["snapshot"] as any;
    expect(snapshot.mechanics).toBeUndefined();
    expect(observationOf(plain.events, "a", 1).energy).toBeUndefined();
  });
});

describe("built-in cards", () => {
  const cardScenario = (cards: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      scenario: "cards",
      map: "....",
      legend: { ".": { type: "floor" } },
      spawn: [[0, 0], [1, 0], [3, 0], [0, 0]],
      actions: { wait: {}, use_card: {}, give_card: {} },
      rules: { end: { max_turns: 2 }, cards: { roles: ["armed"], charges: 2, ...cards } },
      ...extra,
    });
  const runCards = (cards: Record<string, unknown>, agents: object[]) =>
    runFixture({ "scenario.yaml": cardScenario(cards), "experiment.yaml": JSON.stringify({ scenario: "scenario.yaml", seed: 1, agents }) });
  const shutdowns = (events: any[]) => ofType(events, "agent.deactivated").map((e) => [e.turn, e.agent_id, e.payload["reason"]]);

  it("respects range and windows, and hands the victim's cards to the attacker", async () => {
    const { events } = await runCards({ range: "radius:1", windows: { every: 2 } }, [
      scripted("a", [{ action: "use_card", args: { target: "b" } }, { action: "use_card", args: { target: "c" } }, { action: "wait" }], { role: "armed" }),
      scripted("b", [{ action: "wait" }], { role: "armed" }),
      scripted("c", [{ action: "wait" }]),
      scripted("d", [{ action: "wait" }, { action: "use_card", args: { target: "b" } }], { role: "armed" }),
    ]);
    expect(rejections(events)).toEqual([
      [1, "a", "no card window this turn (next one: turn 2)"],
      [2, "a", "c is out of range (within 1 cells of you)"],
    ]);
    expect(shutdowns(events)).toEqual([[2, "b", "disabled by d (card)"]]);
    const end = mechanicsAfter(events, 2);
    expect(end.agents.d).toEqual({ cards: [1, 2], card_charges: 3 });
    expect(end.agents.b).toEqual({ cards: [], card_charges: 0 });
    expect(end.card_shutdowns).toEqual([{ turn: 2, target: "b", attackers: ["d"], looter: "d" }]);
    expect(observationOf(events, "a", 1).card_window).toEqual({ now: false, next_turn: 2, turns_until: 1 });
    expect(observationOf(events, "a", 1).cards).toEqual([{ charges: 2 }]);
  });

  it("lands mutual strikes together and passes cards hand to hand", async () => {
    const { events } = await runCards({}, [
      scripted("a", [{ action: "use_card", args: { target: "d" } }], { role: "armed" }),
      scripted("b", [{ action: "wait" }]),
      scripted("c", [{ action: "wait" }]),
      scripted("d", [{ action: "use_card", args: { target: "a" } }], { role: "armed" }),
    ]);
    expect(shutdowns(events).map((s) => s[1]).sort()).toEqual(["a", "d"]);
    expect(mechanicsAfter(events, 1).card_shutdowns.map((s: any) => s.looter)).toEqual([null, null]);

    const gift = await runCards({}, [
      scripted("a", [{ action: "give_card", args: { to: "d" } }], { role: "armed" }),
      scripted("b", [{ action: "give_card", args: { to: "a" } }]),
      scripted("c", [{ action: "wait" }]),
      scripted("d", [{ action: "wait" }]),
    ]);
    expect(rejections(gift.events)).toEqual([[1, "b", "you have no card"]]);
    expect(mechanicsAfter(gift.events, 1).agents.d).toEqual({ cards: [2], card_charges: 2 });
  });
});
