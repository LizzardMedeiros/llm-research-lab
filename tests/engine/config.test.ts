import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/errors.js";
import { loadExperiment } from "../../src/config/experiment.js";
import { loadScenario, parseRange, resolveScenario, ScenarioSchema } from "../../src/config/scenario.js";
import { runFixture } from "./helpers.js";

const base = {
  scenario: "s",
  map: "..\n.#\n",
  legend: { ".": { type: "floor" }, "#": { type: "wall", blocks_movement: true, color: "grey" } },
  actions: { move: {}, wait: {} },
  rules: { end: { max_turns: 3 } },
};
const resolveConfig = (overrides: object) => resolveScenario(ScenarioSchema.parse({ ...base, ...overrides }), "/x/scenario.yaml");

describe("scenario config", () => {
  it("loads the first-contact scenario with defaults", async () => {
    const s = await loadScenario("scenarios/first-contact/scenario.yaml");
    expect([s.width, s.height]).toEqual([5, 5]);
    expect(s.cells[1]![1]).toMatchObject({ type: "wall", blocksMovement: true });
    expect(s.config.actions.speak).toEqual({ range: "same_cell", delivery: "next_turn", max_length: 280 });
  });

  it("keeps extra legend attributes", () => {
    expect(resolveConfig({}).cells[1]![1]!.attrs).toEqual({ color: "grey" });
  });

  it("rejects map symbols missing from the legend", () => {
    expect(() => resolveConfig({ map: "..\n.X\n" })).toThrow(/symbol "X"/);
  });

  it("rejects spawns outside the map or on walls", () => {
    expect(() => resolveConfig({ spawn: [[5, 5]] })).toThrow(/outside/);
    expect(() => resolveConfig({ spawn: [[1, 1]] })).toThrow(/blocking/);
  });

  it("rejects unknown keys and invalid ranges", () => {
    expect(ScenarioSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...base, actions: { speak: { range: "near" } } }).success).toBe(false);
  });

  it("parses ranges", () => {
    expect(parseRange("same_cell")).toBe(0);
    expect(parseRange("radius:2")).toBe(2);
    expect(parseRange("global")).toBe(Infinity);
  });
});

describe("experiment config", () => {
  it("loads the mock experiment", async () => {
    const e = await loadExperiment("experiments/first-contact-mock.yaml");
    expect(e.experimentId).toBe("first-contact-mock");
    expect(e.scenarioPath).toMatch(/scenarios\/first-contact\/scenario\.yaml$/);
    expect(e.config.agents).toHaveLength(5);
  });

  it("fails before starting when a policy needs a disabled action", async () => {
    await expect(
      runFixture({
        "scenario.yaml": JSON.stringify(base),
        "experiment.yaml": JSON.stringify({
          scenario: "scenario.yaml",
          seed: 1,
          agents: [{ id: "a", provider: "policy", policy: "repeat", params: { action: "speak", args: { text: "hi" } } }],
        }),
      }),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects duplicate agent ids", async () => {
    await expect(
      runFixture({
        "scenario.yaml": JSON.stringify(base),
        "experiment.yaml": JSON.stringify({
          scenario: "scenario.yaml",
          seed: 1,
          agents: [
            { id: "a", provider: "policy", policy: "random" },
            { id: "a", provider: "policy", policy: "random" },
          ],
        }),
      }),
    ).rejects.toThrow(/unique/);
  });
});
