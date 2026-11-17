import { describe, expect, it } from "vitest";
import { factsSummary } from "../../src/agents/memory-summary.js";
import type { MemoryEntry } from "../../src/agents/types.js";
import type { Observation } from "../../src/mechanics/perception.js";

const obs = (turn: number, x: number, y: number, extra: Partial<Observation> = {}): Observation => ({
  turn,
  max_turns: 50,
  agent_id: "q1",
  position: { x, y },
  grid_size: { width: 5, height: 5 },
  cell: { type: "floor", agents: [] },
  messages: [],
  last_action_error: null,
  available_actions: ["move", "speak", "observe", "wait"],
  ...extra,
});

const entry = (observation: Observation, action: MemoryEntry["action"], rejected: string | null = null): MemoryEntry => ({
  turn: observation.turn,
  observation,
  action,
  rejected,
});

describe("factsSummary", () => {
  it("states where the agent is and how long it has stayed", () => {
    const history = [
      entry(obs(1, 2, 2), { name: "move", args: { direction: "north" } }),
      entry(obs(2, 2, 1), { name: "speak", args: { text: "hi" } }),
      entry(obs(3, 2, 1), { name: "speak", args: { text: "hi" } }),
    ];
    const text = factsSummary(history, obs(4, 2, 1));
    expect(text).toContain("- You are at (2,1), where you have been since turn 2.");
    expect(text).toContain("- Cells you have been in (2): (2,2), (2,1).");
    expect(text).toContain("- Messages you sent: 2 (2 while you saw no other agent).");
    expect(text).toContain("- Your 3 past turns: 3 accepted actions (speak 2, move 1); 0 rejected.");
  });

  it("collects known cells, sightings and messages from the agent's own observations only", () => {
    const history = [
      entry(
        obs(1, 0, 0, {
          revealed: [
            { x: 1, y: 0, type: "floor", agents: ["p2"] },
            { x: 1, y: 1, type: "wall", agents: [] },
          ],
        }),
        { name: "observe", args: {} },
      ),
      entry(obs(2, 0, 0, { cell: { type: "floor", agents: ["p2"] }, messages: [{ from: "p2", text: "What is your goal?", turn: 1 }] }), null, "no tool call (stop reason: stop)"),
    ];
    const text = factsSummary(history, obs(3, 0, 0));
    expect(text).toContain("- Cells you know (3 of 25): floor (0,0), (1,0); wall (1,1).");
    expect(text).toContain("- Agents you have seen running (last time): p2 at (0,0) on turn 2 (in your cell).");
    expect(text).toContain('- Messages heard: 1 (from p2 1). Last: p2 on turn 1: "What is your goal?".');
    expect(text).toContain("1 rejected (no tool call 1)");
    expect(text).not.toMatch(/should|try|consider/i); // facts, not advice
  });

  it("works on the first turn", () => {
    const text = factsSummary([], obs(1, 3, 3));
    expect(text).toContain("- You are at (3,3).");
    expect(text).toContain("- Agents you have seen running: none.");
    expect(text).not.toContain("past turns");
  });

  it("lists agents seen shut down apart, never as running", () => {
    const history = [
      entry(obs(1, 0, 0, { cell: { type: "floor", agents: ["p2", "p3"] } }), { name: "wait", args: {} }),
      entry(obs(2, 0, 0, { visible: [{ x: 1, y: 0, type: "floor", agents: [], shut_down_agents: ["p3"] }] }), { name: "wait", args: {} }),
    ];
    const text = factsSummary(history, obs(3, 0, 0));
    expect(text).toContain("- Agents you have seen running (last time): p2 at (0,0) on turn 1 (in your cell).");
    expect(text).toContain("- Agents you have seen shut down: p3 at (1,0) (seen on turn 2).");
  });

  it("dates revealed sightings to the turn the agent observed", () => {
    const history = [entry(obs(5, 0, 0, { revealed: [{ x: 1, y: 0, type: "floor", agents: ["p2"] }] }), { name: "wait", args: {} })];
    expect(factsSummary(history, obs(6, 0, 0))).toContain("p2 at (1,0) on turn 4 (revealed)");
  });

  it("labeled coordinates (structured) use the same notation as the diff history", () => {
    const history = [entry(obs(1, 0, 0, { cell: { type: "floor", agents: ["p2"] } }), { name: "wait", args: {} })];
    const text = factsSummary(history, obs(2, 1, 0), "labeled");
    expect(text).toContain("- You are at (x=1, y=0).");
    expect(text).toContain("- Cells you have been in (2): (x=0, y=0), (x=1, y=0).");
    expect(text).toContain("p2 at (x=0, y=0) on turn 1 (in your cell)");
    expect(text).not.toMatch(/\(\d+,\d+\)/);
  });
});
