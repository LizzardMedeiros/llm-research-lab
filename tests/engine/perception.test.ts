import { describe, expect, it } from "vitest";
import { buildObservation } from "../../src/mechanics/perception.js";
import { World } from "../../src/world/world.js";

const floor = { symbol: ".", type: "floor", blocksMovement: false, attrs: {} };

function world() {
  const w = new World({ width: 3, height: 1, cells: [[floor, floor, floor]] });
  w.addAgent("a1", [0, 0]);
  w.addAgent("a2", [0, 0]);
  w.addAgent("a3", [0, 0]);
  w.addAgent("a4", [1, 0]);
  return w;
}

describe("perception", () => {
  it("marks shut-down agents in cells instead of listing them as present", () => {
    const w = world();
    w.deactivate("a2", 3, "ran out of energy");
    w.deactivate("a4", 3, "ran out of energy");
    const o = buildObservation(w, "a1", 4, "radius:1", ["wait"], w.mailbox("a1"), 10);
    expect(o.cell).toEqual({ type: "floor", agents: ["a3"], shut_down_agents: ["a2"] });
    expect(o.visible).toEqual([{ x: 1, y: 0, type: "floor", agents: [], shut_down_agents: ["a4"] }]);
  });

  it("omits shut_down_agents when nobody in the cell shut down", () => {
    const w = world();
    const o = buildObservation(w, "a1", 1, "radius:1", ["wait"], w.mailbox("a1"), 10);
    expect(o.cell).toEqual({ type: "floor", agents: ["a2", "a3"] });
    expect(o.visible![0]).not.toHaveProperty("shut_down_agents");
  });

  it("shows revealed cells as seen during the previous turn (shut down later = still running there)", () => {
    const w = world();
    // a1 observed on turn 4 and saw a4 at (1,0); a4 then moved and shut down at the end of turn 4.
    w.mailbox("a1").revealed = [{ position: [1, 0], type: "floor", agents: ["a4"] }];
    w.deactivate("a4", 4, "disabled");
    w.deactivate("a2", 3, "ran out of energy");
    w.mailbox("a1").revealed!.push({ position: [0, 0], type: "floor", agents: ["a1", "a2"] });
    const o = buildObservation(w, "a1", 5, "same_cell", ["wait"], w.mailbox("a1"), 10);
    expect(o.revealed).toEqual([
      { x: 1, y: 0, type: "floor", agents: ["a4"] },
      { x: 0, y: 0, type: "floor", agents: [], shut_down_agents: ["a2"] },
    ]);
  });
});
