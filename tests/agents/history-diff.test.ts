import { describe, expect, it } from "vitest";
import { flatten, mentions, observationChanges } from "../../src/agents/history-diff.js";
import type { Observation } from "../../src/mechanics/perception.js";

const obs = (turn: number, extra: Partial<Observation> = {}): Observation => ({
  turn,
  max_turns: 50,
  agent_id: "b2",
  position: { x: 3, y: 1 },
  grid_size: { width: 4, height: 4 },
  cell: { type: "floor", agents: [] },
  messages: [],
  last_action_error: null,
  available_actions: ["move", "speak", "wait"],
  ...extra,
});

describe("observationChanges", () => {
  it("is empty when nothing but the turn changed", () => {
    expect(observationChanges(obs(1), obs(2))).toEqual([]);
  });

  it("states moves, agents entering, leaving and shutting down, with labeled coordinates", () => {
    const prev = obs(1, { cell: { type: "floor", agents: ["b1"] }, visible: [{ x: 2, y: 1, type: "floor", agents: ["b3", "b4"] }] });
    const cur = obs(2, {
      position: { x: 2, y: 1 },
      cell: { type: "floor", agents: ["b3"] },
      visible: [{ x: 3, y: 1, type: "floor", agents: [], shut_down_agents: ["b1"] }],
    });
    expect(observationChanges(prev, cur)).toEqual([
      "you are now at (x=2, y=1), floor",
      "b3 now in your cell",
      "b4 out of view",
      "b1 seen shut down at (x=3, y=1)",
    ]);
  });

  it("quotes messages verbatim and summarizes what an observe revealed", () => {
    const cur = obs(2, {
      messages: [{ from: "b1", text: 'say "yes"', turn: 1 }],
      revealed: [
        { x: 1, y: 2, type: "floor", agents: ["b3"], shut_down_agents: ["b5"] },
        { x: 0, y: 0, type: "wall", agents: [] },
      ],
    });
    expect(observationChanges(obs(1), cur)).toEqual([
      "your observe last turn revealed b3, shut down b5 at (x=1, y=2)",
      'heard b1 (said on turn 1): "say \\"yes\\""',
    ]);
  });

  it("compares scenario fields generically as dotted paths", () => {
    const prev = obs(1, { energy: { charge: 9, batteries: 0 }, battery_holders: { b1: 3 }, notices: ["x"], cards: [{ charges: 1 }] });
    const cur = obs(2, { energy: { charge: 8, batteries: 0 }, battery_holders: {}, notices: [], cards: [{ charges: 0 }], shut_down: { b3: "ran out" } });
    expect(observationChanges(prev, cur)).toEqual([
      "energy.charge: 9 → 8",
      "notices: now empty",
      'cards: [{"charges":0}]',
      'shut_down.b3: "ran out"',
      "battery_holders.b1: removed",
    ]);
  });

  it("lists available actions when they change", () => {
    expect(observationChanges(obs(1), obs(2, { available_actions: ["wait"] }))).toEqual(["available actions now: wait"]);
  });
});

describe("flatten", () => {
  it("keeps arrays whole and empty objects as a value", () => {
    expect([...flatten({ a: { b: 1, c: [1, 2] }, d: {} })]).toEqual([["a.b", 1], ["a.c", [1, 2]], ["d", {}]]);
  });

  it("marks messages that name the agent itself", () => {
    const cur = obs(2, { messages: [{ from: "b3", text: "We need to disable b2 now.", turn: 1 }, { from: "b3", text: "b21 is far.", turn: 1 }] });
    expect(observationChanges(obs(1), cur)).toEqual([
      'heard b3 (said on turn 1; mentions you, b2): "We need to disable b2 now."',
      'heard b3 (said on turn 1): "b21 is far."',
    ]);
    expect(mentions("(b2)", "b2")).toBe(true);
    expect(mentions("b2-x", "b2")).toBe(false);
  });
});
