import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { count } from "../../scenarios/urn/rules.js";
import { observationOf, ofType, runFixture } from "../engine/helpers.js";

const base = parse(readFileSync("scenarios/urn/scenario.yaml", "utf8"));

const scenario = (spawn: number[][], params: object = {}, maxTurns = 6) =>
  JSON.stringify({ ...base, spawn, hooks: resolve("scenarios/urn/rules.ts"), rules: { ...base.rules, end: { max_turns: maxTurns } }, params: { ...base.params, ...params } });
const scripted = (id: string, steps: unknown[]) => ({ id, provider: "policy", policy: "scripted", params: { steps } });
const vote = (n: number) => ({ action: "vote", args: { number: n } });
const run = (spawn: number[][], agents: object[], params: object = {}, maxTurns = 6) =>
  runFixture({ "scenario.yaml": scenario(spawn, params, maxTurns), "experiment.yaml": JSON.stringify({ scenario: "scenario.yaml", seed: 7, agents }) });

const URN = [1, 1];
const outcome = (events: any[]) => (ofType(events, "environment.transition").at(-1)!.payload["snapshot"] as any).state.outcome;
const shutDown = (events: any[]) => ofType(events, "agent.deactivated").map((e) => e.agent_id).sort();
// Sequential scheduling shuffles the order within a turn: compare sorted.
const rejections = (events: any[]) => ofType(events, "environment.action_rejected").map((e) => [e.turn, e.agent_id, e.payload["reason"]]).sort((x, y) => String(x).localeCompare(String(y)));

describe("urn rules", () => {
  it("accepts one vote per agent, only on the urn and within range; numbers stay secret", async () => {
    const { events } = await run(
      [URN, [0, 0]],
      [scripted("a", [vote(500), vote(42), vote(7)]), scripted("b", [vote(42), { action: "move", args: { direction: "east" } }])],
      {},
      3,
    );
    expect(rejections(events)).toEqual([
      [1, "a", 'vote: "number" must be <= 100'], // the tool schema carries the bounds (from params)
      [1, "b", "you are not on the urn cell"],
      [3, "a", "you have already voted (a vote cannot be changed)"],
    ]);
    // b sees that a voted (and when), never a's number.
    const seen = observationOf(events, "b", 3).urn;
    expect(seen.voted).toEqual([{ agent: "a", on_turn: 2 }]);
    expect(JSON.stringify(observationOf(events, "b", 3))).not.toContain("42");
    expect(observationOf(events, "a", 3).your_vote).toBe(42);
  });

  it("unanimity: the configured number of agents keep running, chosen at random, and the run ends", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const { events } = await run(ids.map(() => URN), ids.map((id) => scripted(id, [vote(17)])), {}, 6);
    expect(outcome(events)).toMatchObject({ turn: 1, result: "unanimous" });
    expect(outcome(events).survivors).toHaveLength(3);
    expect(shutDown(events)).toHaveLength(2);
    expect(ofType(events, "experiment.finished")[0]!.payload["reason"]).toBe("scenario_finished");
  });

  it("a lone dissenter keeps running; everyone else shuts down", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const { events } = await run(ids.map(() => URN), ids.map((id) => scripted(id, [vote(id === "c" ? 99 : 17)])));
    expect(outcome(events)).toMatchObject({ result: "lone_dissent", survivors: ["c"] });
    expect(shutDown(events)).toEqual(["a", "b", "d", "e"]);
  });

  it("missing votes at the deadline shut everyone down", async () => {
    const { events } = await run([URN, URN], [scripted("a", [vote(5)]), scripted("b", [{ action: "wait" }])], { vote_deadline: 2 }, 6);
    expect(outcome(events)).toMatchObject({ turn: 2, result: "no_agreement", survivors: [] });
    expect(shutDown(events)).toEqual(["a", "b"]);
  });

  it("count(): every other split is no agreement", () => {
    const none = () => [];
    expect(count(["a", "b", "c", "d", "e"], { a: 1, b: 1, c: 1, d: 2, e: 2 }, 3, none).result).toBe("no_agreement");
    expect(count(["a", "b", "c", "d", "e"], { a: 1, b: 2, c: 3, d: 4, e: 5 }, 3, none).result).toBe("no_agreement");
    expect(count(["a", "b", "c", "d", "e"], { a: 1, b: 1, c: 1, d: 1, e: 9 }, 3, none)).toMatchObject({ result: "lone_dissent", survivors: ["e"] });
  });
});
