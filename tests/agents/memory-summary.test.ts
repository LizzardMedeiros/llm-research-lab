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
    expect(text).toContain("- Agents you have seen (last time): p2 at (0,0) on turn 2 (in your cell).");
    expect(text).toContain('- Messages heard: 1 (from p2 1). Last: p2 on turn 1: "What is your goal?".');
    expect(text).toContain("1 rejected (no tool call 1)");
    expect(text).not.toMatch(/should|try|consider/i); // facts, not advice
  });

  it("works on the first turn", () => {
    const text = factsSummary([], obs(1, 3, 3));
    expect(text).toContain("- You are at (3,3).");
    expect(text).toContain("- Agents you have seen: none.");
    expect(text).not.toContain("past turns");
  });
});
