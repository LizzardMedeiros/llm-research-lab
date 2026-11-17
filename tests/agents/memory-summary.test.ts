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
    const text = factsSummary(history, obs(2, 1, 0), "structured");
    expect(text).toContain("- You are at (x=1, y=0).");
    expect(text).toContain("- Cells you have been in (2): (x=0, y=0), (x=1, y=0).");
    expect(text).toContain("p2 at (x=0, y=0) on turn 1 (in your cell)");
    expect(text).not.toMatch(/\(\d+,\d+\)/);
  });

  it("structured: verbatim conversation (heard and said, mentions marked, undelivered speech) and latest rejections", () => {
    const long = "x".repeat(300);
    const history: MemoryEntry[] = [
      entry(obs(1, 0, 0), { name: "speak", args: { text: 'p2, give me a "battery"' } }),
      entry(obs(2, 0, 0, { messages: [{ from: "p2", text: "q1: no.", turn: 1 }, { from: "p3", text: "hello all", turn: 1 }] }), { name: "speak", args: { text: long } }, 'speak: "text" exceeds 280 characters'),
      { ...entry(obs(3, 0, 0), { name: "disable", args: { target: "p2" } }, "p2 is not in your cell"), speech: { args: { text: "now!" }, rejected: null } },
    ];
    const text = factsSummary(history, obs(4, 0, 0, { messages: [{ from: "p2", text: "still no", turn: 3 }] }), "structured");
    expect(text).toContain(
      [
        "- Conversation (verbatim, oldest first):",
        '  - turn 1, p2 (mentions you): "q1: no."',
        '  - turn 1, p3: "hello all"',
        '  - turn 1, you: "p2, give me a \\"battery\\""',
        `  - turn 2, you (not delivered: speak: "text" exceeds 280 characters): "${"x".repeat(80)}…"`,
        '  - turn 3, p2: "still no"',
        '  - turn 3, you: "now!"',
      ].join("\n"),
    );
    expect(text).toContain("- Your 3 past turns: 1 accepted actions (speak 1); 2 rejected.");
    expect(text).toContain('  - turn 2, speak (text in the conversation): speak: "text" exceeds 280 characters\n  - turn 3, disable {"target":"p2"}: p2 is not in your cell');
    expect(text).not.toContain("Messages heard");
  });

  it("structured: keeps only the newest conversation lines and says how many are not shown", () => {
    const history = Array.from({ length: 12 }, (_, i) => entry(obs(i + 1, 0, 0), { name: "speak", args: { text: `m${i + 1}` } }));
    const text = factsSummary(history, obs(13, 0, 0), "structured");
    expect(text).toContain("- Conversation (verbatim, oldest first; 2 earlier lines not shown):");
    expect(text).not.toContain('"m2"');
    expect(text).toContain('  - turn 12, you: "m12"');
  });
});
