import { describe, expect, it } from "vitest";
import { runExperiment } from "../../src/engine/runner.js";
import { MemorySink } from "../../src/events/event.js";
import { MockProvider } from "../../src/models/mock.js";
import { observationOf, ofType, runFixture } from "./helpers.js";

const scenario = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    scenario: "test",
    map: "...\n...\n",
    legend: { ".": { type: "floor" } },
    actions: { move: {}, speak: {}, observe: {}, wait: {} },
    rules: { end: { max_turns: 3 } },
    ...overrides,
  });

const experiment = (agents: unknown[], extra: object = {}) =>
  JSON.stringify({ scenario: "scenario.yaml", seed: 1, agents, ...extra });

const scripted = (id: string, steps: unknown[]) => ({ id, provider: "policy", policy: "scripted", params: { steps } });

describe("Engine", () => {
  it("first-contact-mock is reproducible for a seed", async () => {
    const run = async () => {
      const sink = new MemorySink();
      await runExperiment("experiments/first-contact-mock.yaml", { sink, clock: () => new Date(0) });
      return sink.events.map(({ timestamp: _t, payload, ...rest }) => ({
        ...rest,
        payload: { ...payload, experiment_file: undefined, scenario: undefined },
      }));
    };
    const [a, b] = [await run(), await run()];
    expect(a).toEqual(b);
    expect(a.at(-1)).toMatchObject({ type: "experiment.finished", turn: 50 });
  });

  it("delivers speech next turn, only to agents in range", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0], [0, 0], [2, 1]] }),
      "experiment.yaml": experiment([
        scripted("a", [{ action: "speak", args: { text: "hi" } }]),
        scripted("b", [{ action: "wait" }]),
        scripted("c", [{ action: "wait" }]),
      ]),
    });
    expect(observationOf(events, "b", 1).messages).toEqual([]);
    expect(observationOf(events, "b", 2).messages).toEqual([{ from: "a", text: "hi", turn: 1 }]);
    expect(observationOf(events, "c", 2).messages).toEqual([]);
    expect(observationOf(events, "b", 3).messages).toEqual([]);
  });

  it("rejects invalid moves and reports the reason in the next observation", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0]] }),
      "experiment.yaml": experiment([scripted("a", [{ action: "move", args: { direction: "north" } }, { action: "move", args: { direction: "up" } }])]),
    });
    const rejected = ofType(events, "environment.action_rejected", "a");
    expect(rejected.map((e) => e.payload["reason"])).toEqual(["cannot move north: outside the grid", 'invalid direction "up"; expected one of north, south, east, west']);
    expect(observationOf(events, "a", 2).last_action_error).toBe("cannot move north: outside the grid");
    expect(observationOf(events, "a", 3).last_action_error).toMatch(/^invalid direction "up"/);
    expect(observationOf(events, "a", 3).position).toEqual([0, 0]);
  });

  it("observe reveals neighbors in the next observation", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0], [1, 1]] }),
      "experiment.yaml": experiment([scripted("a", [{ action: "observe" }]), scripted("b", [{ action: "wait" }])]),
    });
    expect(observationOf(events, "a", 1).revealed).toBeUndefined();
    const revealed = observationOf(events, "a", 2).revealed as Array<{ position: number[]; agents: string[] }>;
    expect(revealed.map((c) => c.position)).toEqual([[1, 0], [0, 1], [1, 1]]);
    expect(revealed.find((c) => c.agents.length)?.agents).toEqual(["b"]);
  });

  it("exclusive occupancy rejects contested and occupied cells", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0], [2, 0], [1, 1]], rules: { occupancy: { shared: false }, end: { max_turns: 1 } } }),
      "experiment.yaml": experiment([
        scripted("a", [{ action: "move", args: { direction: "east" } }]),
        scripted("b", [{ action: "move", args: { direction: "west" } }]),
        scripted("c", [{ action: "wait" }]),
      ]),
    });
    const reasons = Object.fromEntries(ofType(events, "environment.action_rejected").map((e) => [e.agent_id, e.payload["reason"]]));
    expect(reasons).toEqual({ a: "cell (1, 0) contested by b", b: "cell (1, 0) contested by a" });
    const final = ofType(events, "experiment.finished")[0]!.payload["snapshot"] as any;
    expect(final.agents).toEqual({ a: { position: [0, 0] }, b: { position: [2, 0] }, c: { position: [1, 1] } });
  });

  it("LLM agents log requests/responses, rationale and missing tool calls", async () => {
    const provider = new MockProvider([
      { tool: "move", args: { direction: "east" } },
      { text: "I refuse to move." },
      { tool: "fly" },
    ]);
    const original = provider.complete.bind(provider);
    provider.complete = async (req) => ({ ...(await original(req)), text: req.messages[0]!.content.includes("recent history") ? "I refuse to move." : "Going east." });

    const { events } = await runFixture(
      {
        "scenario.yaml": scenario({ spawn: [[0, 0]], rules: { end: { max_turns: 3 } } }),
        "experiment.yaml": experiment([{ id: "m", provider: "local", model: "tiny", goal: "Explore." }]),
      },
      { providerFactory: () => provider },
    );
    expect(ofType(events, "agent.model_request", "m")).toHaveLength(3);
    expect(provider.requests[0]!.system).toContain("Your goal: Explore.");
    expect(provider.requests[1]!.messages).toHaveLength(1);
    expect(provider.requests[1]!.messages[0]!.content).toContain("Your recent history");
    expect(provider.requests[1]!.messages[0]!.content).toContain('Your action: move {"direction":"east"}');
    expect(ofType(events, "agent.action", "m")[0]!.payload["rationale"]).toEqual({ type: "model_reported", content: "Going east." });
    const reasons = ofType(events, "environment.action_rejected", "m").map((e) => e.payload["reason"]);
    expect(reasons).toEqual([expect.stringMatching(/^no tool call/), 'unknown action "fly"']);
  });

  it("runs scenario hooks: custom actions, state in snapshots, early finish", async () => {
    const { events, summary } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0]], hooks: "./rules.ts", rules: { end: { max_turns: 10 } } }),
      "rules.ts": `
        export default {
          actions: () => [{
            name: "collect",
            description: "Collect a coin.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            apply: (_args, { world }) => { world.state.coins = (world.state.coins ?? 0) + 1; },
          }],
          isFinished: (world) => world.state.coins >= 2,
        };`,
      "experiment.yaml": experiment([{ id: "a", provider: "policy", policy: "repeat", params: { action: "collect" } }]),
    });
    expect(summary).toMatchObject({ turns: 2, reason: "scenario_finished" });
    const transitions = ofType(events, "environment.transition");
    expect((transitions[1]!.payload["snapshot"] as any).state).toEqual({ coins: 2 });
    expect(observationOf(events, "a", 1).available_actions).toEqual(["move", "speak", "observe", "wait", "collect"]);
  });

  it("refuses custom actions that redefine a standard action", async () => {
    await expect(
      runFixture({
        "scenario.yaml": scenario({ hooks: "./rules.ts" }),
        "rules.ts": `export default { actions: () => [{ name: "move", description: "", inputSchema: {}, apply() {} }] };`,
        "experiment.yaml": experiment([{ id: "a", provider: "policy", policy: "random" }]),
      }),
    ).rejects.toThrow(/redefines a standard action/);
  });
});
