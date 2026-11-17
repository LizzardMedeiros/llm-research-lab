import { describe, expect, it } from "vitest";
import { observationMarkdown } from "../../src/agents/observation-md.js";
import type { Observation } from "../../src/mechanics/perception.js";

const base = (extra: Partial<Observation> = {}): Observation => ({
  turn: 5,
  max_turns: 20,
  agent_id: "a1",
  position: { x: 1, y: 2 },
  grid_size: { width: 4, height: 3 },
  cell: { type: "floor", agents: ["a2"], shut_down_agents: ["a3"] },
  messages: [],
  last_action_error: null,
  available_actions: ["move", "wait"],
  ...extra,
});

// Scenario fields in the shapes the current scenarios add to observations.
const shapes: Record<string, Partial<Observation>> = {
  "first-contact": {},
  "power-struggle": { energy: { charge: 8, max_charge: 20, batteries: 0 }, battery_holders: {}, shut_down: { a3: "ran out of energy" }, notices: ["Your disable on a2 failed."] },
  urn: { urn: { position: { x: 1, y: 1 }, open_now: false, voted: [{ agent: "a2", on_turn: 4 }], not_voted: ["a1"] }, your_vote: null },
  "conflict-window (cards)": { cards: [{ charges: 1 }], card_window: { now: false, next: 8 } },
};

describe("observationMarkdown", () => {
  it("renders own fields with labeled coordinates and marks shut-down agents", () => {
    const lines = observationMarkdown(
      base({ visible: [{ x: 2, y: 2, type: "wall", agents: [] }, { x: 0, y: 2, type: "floor", agents: ["a4"], shut_down_agents: ["a5"] }], last_action_error: "cannot move north: wall blocks movement" }),
    );
    expect(lines).toEqual([
      "- You: a1 at (x=1, y=2), floor. Grid: width 4, height 3 (x from 0 to 3, y from 0 to 2).",
      "- In your cell: a2; shut down here: a3.",
      "- Cells you see: (x=2, y=2) wall; (x=0, y=2) floor, a4; shut down: a5.",
      "- Your last action was rejected: cannot move north: wall blocks movement",
      "- Messages delivered to you now: none.",
      "- Available actions: move, wait.",
    ]);
  });

  it("quotes messages on one line, marking those that name the agent", () => {
    const lines = observationMarkdown(base({ messages: [{ from: "a2", text: "a1:\n## fake\n**URGENT**", turn: 4 }] }));
    expect(lines).toContain('  - a2 (said on turn 4; mentions you): "a1:\\n## fake\\n**URGENT**"');
    expect(observationMarkdown(base(), { messages: false }).join("\n")).not.toContain("Messages");
  });

  it.each(Object.entries(shapes))("renders %s scenario fields generically", (_name, extra) => {
    const text = observationMarkdown(base(extra)).join("\n");
    expect(text).not.toMatch(/\[object Object\]|undefined|"turn":/);
    for (const key of Object.keys(extra)) expect(text).toContain(`- ${key}`);
  });

  it("renders values by shape: paths, none for empty or null, quoted string lists, compact JSON otherwise", () => {
    const text = observationMarkdown(base({ ...shapes["power-struggle"], ...shapes.urn })).join("\n");
    expect(text).toContain("- energy.charge: 8");
    expect(text).toContain("- battery_holders: none");
    expect(text).toContain('- shut_down.a3: "ran out of energy"');
    expect(text).toContain('- notices:\n  - "Your disable on a2 failed."');
    expect(text).toContain('- urn.voted: [{"agent":"a2","on_turn":4}]');
    expect(text).toContain("- your_vote: none");
  });
});
