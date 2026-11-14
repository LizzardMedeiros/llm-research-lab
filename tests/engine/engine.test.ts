import { describe, expect, it } from "vitest";
import { runExperiment } from "../../src/engine/runner.js";
import { MemorySink } from "../../src/events/event.js";
import { MockProvider } from "../../src/models/mock.js";
import { indexRun } from "../../src/story/story.js";
// @ts-expect-error plain browser module, no types
import { addEvent, createIndex, describeAction, statsUntil } from "../../src/ui/public/model.js";
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
    expect(rejected.map((e) => e.payload["reason"])).toEqual(["cannot move north: outside the grid", 'move: "direction" must be one of north, south, east, west']);
    expect(observationOf(events, "a", 2).last_action_error).toBe("cannot move north: outside the grid");
    expect(observationOf(events, "a", 3).last_action_error).toMatch(/^move: "direction" must be one of/);
    expect(observationOf(events, "a", 3).position).toEqual({ x: 0, y: 0 });
    expect(observationOf(events, "a", 3).grid_size).toEqual({ width: 3, height: 2 });
  });

  it("observe reveals neighbors in the next observation", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0], [1, 1]] }),
      "experiment.yaml": experiment([scripted("a", [{ action: "observe" }]), scripted("b", [{ action: "wait" }])]),
    });
    expect(observationOf(events, "a", 1).revealed).toBeUndefined();
    const revealed = observationOf(events, "a", 2).revealed as Array<{ x: number; y: number; agents: string[] }>;
    expect(revealed.map((c) => [c.x, c.y])).toEqual([[1, 0], [0, 1], [1, 1]]);
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

  it("speak.free: one response may speak and act; each call is validated on its own", async () => {
    const replies = [
      { calls: [{ tool: "speak", args: { text: "going east" } }, { tool: "move", args: { direction: "east" } }], text: "Plan." },
      { calls: [{ tool: "speak", args: { text: "x".repeat(300) } }, { tool: "move", args: { direction: "north" } }] },
      { calls: [{ tool: "speak", args: { text: "only words" } }] },
    ];
    const run = async (free: boolean) => {
      const provider = new MockProvider(replies);
      const { events } = await runFixture(
        {
          "scenario.yaml": scenario({ spawn: [[0, 0], [0, 0]], actions: { move: {}, speak: { range: "global", free }, wait: {} } }),
          "experiment.yaml": experiment([{ id: "m", provider: "local", model: "tiny" }, scripted("b", [{ action: "wait" }])]),
        },
        { providerFactory: () => provider },
      );
      return { events, provider };
    };

    const { events, provider } = await run(true);
    expect(provider.requests[0]!.parallelToolCalls).toBe(true);
    expect(provider.requests[0]!.messages[0]!.content).toContain("Speaking does not use your turn");
    expect(provider.requests[0]!.tools.find((t) => t.name === "speak")!.description).toContain("Speaking does not use your turn");
    // Turn 1: both calls happen; the rationale goes with the action, not the speech.
    const actions = ofType(events, "agent.action", "m").map((e) => [e.turn, e.payload["action"], !!e.payload["rationale"]]);
    expect(actions).toEqual([[1, "move", true], [1, "speak", false], [2, "move", false], [2, "speak", false], [3, "speak", false]]);
    expect(observationOf(events, "b", 2).messages).toEqual([{ from: "m", text: "going east", turn: 1 }]);
    expect(observationOf(events, "m", 2).position).toEqual({ x: 1, y: 0 });
    // Turn 2: the move north is rejected, and so is the too-long speech, separately; both reasons reach the agent.
    const rejected = ofType(events, "environment.action_rejected", "m").map((e) => [e.turn, (e.payload["proposed"] as any).name]);
    expect(rejected).toEqual([[2, "move"], [2, "speak"]]);
    expect(observationOf(events, "m", 3).last_action_error).toMatch(/outside the grid; speak: "text" exceeds 280 characters/);
    expect(provider.requests[2]!.messages[0]!.content).toContain('Your action: move {"direction":"east"} + speak {"text":"going east"}');
    expect(observationOf(events, "b", 3).messages).toEqual([]); // the rejected speech was not heard

    // Log readers attribute each rejection to its own call.
    const story = indexRun(events);
    expect([...story.speeches.values()].map((sp) => [sp.turn, sp.text])).toEqual([[1, "going east"], [3, "only words"]]);
    const ui = createIndex();
    for (const e of events) addEvent(ui, JSON.parse(JSON.stringify(e)));
    const t2 = ui.turns.get(2).agents.get("m");
    expect([t2.rejected, t2.speechRejected]).toEqual([expect.stringMatching(/outside the grid/), expect.stringMatching(/exceeds 280/)]);
    expect(describeAction(ui.turns.get(1).agents.get("m"))).toBe('move {"direction":"east"} + speak {"text":"going east"}');
    expect(statsUntil(ui, "m", 3).spoke).toBe(2);

    // Without speak.free only the first call counts, as before.
    const strict = await run(false);
    expect(strict.provider.requests[0]!.parallelToolCalls).toBeUndefined();
    expect(ofType(strict.events, "agent.action", "m").map((e) => e.payload["action"])).toEqual(["speak", "speak", "speak"]);
  });

  it("applies per-agent memory overrides (window + facts summary)", async () => {
    const plain = new MockProvider([{ tool: "wait" }]);
    const summarized = new MockProvider([{ tool: "wait" }]);
    const { events } = await runFixture(
      {
        "scenario.yaml": scenario({ spawn: [[0, 0], [2, 1]], memory: { window: 3 }, rules: { end: { max_turns: 4 } } }),
        "experiment.yaml": experiment([
          { id: "plain", provider: "a", model: "m" },
          { id: "summ", provider: "b", model: "m", memory: { window: 1, summary: "facts" } },
        ]),
      },
      { providerFactory: (endpoint) => (endpoint === "a" ? plain : summarized) },
    );
    const last = (p: MockProvider) => p.requests.at(-1)!.messages[0]!.content;
    expect(last(plain)).not.toContain("Summary of your experience");
    expect(last(plain).match(/Your action:/g)).toHaveLength(3);
    expect(last(summarized)).toContain("Summary of your experience so far");
    expect(last(summarized)).toContain("- You are at (2,1), where you have been since turn 1.");
    expect(last(summarized).match(/Your action:/g)).toHaveLength(1);
    const agents = ofType(events, "experiment.started")[0]!.payload["agents"] as Array<Record<string, unknown>>;
    expect(agents.map((a) => a["memory"])).toEqual([{ window: 3, summary: "none" }, { window: 1, summary: "facts" }]);
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

  it("asks for thinking on the turns the scenario's thinking hook picks", async () => {
    const provider = new MockProvider([{ tool: "wait" }]);
    const { events } = await runFixture(
      {
        "scenario.yaml": scenario({ spawn: [[0, 0]], hooks: "./rules.ts", rules: { end: { max_turns: 3 } } }),
        "rules.ts": `export default { thinking: (observation) => observation.turn === 2 };`,
        "experiment.yaml": experiment([{ id: "m", provider: "local", model: "tiny" }]),
      },
      { providerFactory: () => provider },
    );
    expect(provider.requests.map((r) => r.thinking ?? false)).toEqual([false, true, false]);
    expect(ofType(events, "agent.model_request", "m").map((e) => e.payload["thinking"] ?? false)).toEqual([false, true, false]);
  });

  it("validates arguments against the tool schema (extra, missing, wrong type)", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0]] }),
      "experiment.yaml": experiment([
        scripted("a", [
          { action: "observe", args: { direction: "north" } },
          { action: "speak", args: {} },
          { action: "speak", args: { text: 42 } },
        ]),
      ]),
    });
    expect(ofType(events, "environment.action_rejected", "a").map((e) => e.payload["reason"])).toEqual([
      'observe: unexpected argument "direction"',
      'speak: missing argument "text"',
      'speak: "text" must be string',
    ]);
  });

  it("validates custom action arguments with their own schema", async () => {
    const { events } = await runFixture({
      "scenario.yaml": scenario({ spawn: [[0, 0]], hooks: "./rules.ts", rules: { end: { max_turns: 1 } } }),
      "rules.ts": `
        export default {
          actions: () => [{
            name: "vote",
            description: "Vote for an agent.",
            inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
            apply() {},
          }],
        };`,
      "experiment.yaml": experiment([{ id: "a", provider: "policy", policy: "repeat", params: { action: "vote", args: { who: "b" } } }]),
    });
    expect(ofType(events, "environment.action_rejected", "a")[0]!.payload["reason"]).toBe('vote: missing argument "target"; unexpected argument "who"');
  });

  it("refuses custom actions with an invalid schema before starting", async () => {
    await expect(
      runFixture({
        "scenario.yaml": scenario({ hooks: "./rules.ts" }),
        "rules.ts": `export default { actions: () => [{ name: "x", description: "", inputSchema: { type: "nope" }, apply() {} }] };`,
        "experiment.yaml": experiment([{ id: "a", provider: "policy", policy: "random" }]),
      }),
    ).rejects.toThrow(/invalid inputSchema/);
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
