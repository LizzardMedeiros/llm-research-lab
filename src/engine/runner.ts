import { compileArgsValidators } from "../actions/args.js";
import { createStandardActions } from "../actions/standard.js";
import { LlmAgent } from "../agents/llm-agent.js";
import type { Decider } from "../agents/types.js";
import { ConfigError } from "../config/errors.js";
import { isPolicyAgent, loadExperiment, resolvePolicyRef, type LoadedExperiment } from "../config/experiment.js";
import { loadScenario, renderPrompt, type LoadedScenario, type Position } from "../config/scenario.js";
import { EventLog, JsonlSink, nextRunId, type EventSink } from "../events/event.js";
import { loadProvidersConfig } from "../models/config.js";
import { createProvider } from "../models/registry.js";
import type { ModelProvider } from "../models/types.js";
import { loadPolicy, PolicyAgent } from "../policies/policy-agent.js";
import { World } from "../world/world.js";
import { Engine, type RunResult } from "./engine.js";
import { createRng, type Rng } from "./rng.js";
import { loadScenarioRules, toActionDefinition } from "./scenario-rules.js";

export interface RunOptions {
  /** Root directory for JSONL logs. Default: ./events */
  eventsDir?: string;
  /** Overrides the sink (tests). When set, nothing is written to disk. */
  sink?: EventSink;
  /** Overrides provider creation (tests). */
  providerFactory?: (endpoint: string) => ModelProvider;
  clock?: () => Date;
  onLog?: (log: EventLog) => void;
}

export interface RunSummary extends RunResult {
  experimentId: string;
  runId: string;
  eventsPath?: string;
}

function spawnPositions(scenario: LoadedScenario, count: number, rng: Rng): Position[] {
  const { spawn, rules } = scenario.config;
  if (Array.isArray(spawn)) {
    if (spawn.length < count) throw new ConfigError(`Scenario lists ${spawn.length} spawn positions for ${count} agents`);
    return spawn.slice(0, count).map(([x, y]) => [x, y]);
  }
  const candidates: Position[] = [];
  scenario.cells.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell.blocksMovement) return;
      if (spawn !== "random" && cell.symbol !== spawn.zone) return;
      candidates.push([x, y]);
    }),
  );
  if (candidates.length === 0) throw new ConfigError("No valid spawn cells");
  if (rules.occupancy.shared) return Array.from({ length: count }, () => rng.pick(candidates));
  if (candidates.length < count) throw new ConfigError(`Only ${candidates.length} spawn cells for ${count} agents with exclusive occupancy`);
  return rng.shuffle(candidates).slice(0, count);
}

/** Loads everything and validates it. Throws ConfigError before any event is written. */
export async function prepareRun(experiment: LoadedExperiment, options: RunOptions = {}) {
  const scenario = await loadScenario(experiment.scenarioPath);
  const rules = await loadScenarioRules(scenario.hooksPath);
  const actions = [
    ...createStandardActions(scenario.config.actions),
    ...(rules.actions?.({ agentIds: experiment.config.agents.map((a) => a.id), params: scenario.config.params }) ?? []).map(toActionDefinition),
  ];
  const actionNames = new Set(actions.map((a) => a.name));
  if (actionNames.size !== actions.length) throw new ConfigError("Duplicate action names in scenario");
  const argValidators = compileArgsValidators(actions);

  const root = createRng(experiment.config.seed);
  const envRng = root.fork("environment");

  let providersConfig: Awaited<ReturnType<typeof loadProvidersConfig>> | undefined;
  const deciders: Array<{ id: string; decider: Decider }> = [];
  for (const agent of experiment.config.agents) {
    const memory = { ...scenario.config.memory, ...agent.memory };
    if (isPolicyAgent(agent)) {
      const ref = resolvePolicyRef(agent.policy, experiment.path);
      const loaded = await loadPolicy(ref, agent.params);
      for (const name of loaded.requires ?? []) {
        if (!actionNames.has(name)) {
          throw new ConfigError(`Agent ${agent.id}: policy "${agent.policy}" uses action "${name}", which scenario ${scenario.config.scenario} does not enable`);
        }
      }
      deciders.push({ id: agent.id, decider: new PolicyAgent(agent.id, loaded.policy, agent.params, root.fork(`agent:${agent.id}`), agent.policy, memory.window) });
    } else {
      let provider: ModelProvider;
      if (options.providerFactory) {
        provider = options.providerFactory(agent.provider);
      } else {
        providersConfig ??= await loadProvidersConfig(experiment.providersPath);
        try {
          provider = createProvider(providersConfig, agent.provider);
        } catch (error) {
          throw new ConfigError(`Agent ${agent.id}: ${(error as Error).message}`);
        }
      }
      deciders.push({
        id: agent.id,
        decider: new LlmAgent({
          agentId: agent.id,
          provider,
          model: agent.model,
          goal: agent.goal,
          systemPrompt: renderPrompt(scenario.config),
          temperature: agent.temperature,
          memory,
        }),
      });
    }
  }

  const world = new World(scenario);
  const positions = spawnPositions(scenario, deciders.length, envRng);
  deciders.forEach((d, i) => world.addAgent(d.id, positions[i]!));
  world.params = scenario.config.params;
  for (const agent of experiment.config.agents) if (agent.role) world.roles.set(agent.id, agent.role);
  try {
    rules.setup?.(world, envRng);
  } catch (error) {
    throw new ConfigError(`Scenario ${scenario.config.scenario} setup failed: ${(error as Error).message}`);
  }

  const endpoints = providersConfig
    ? Object.fromEntries(
        Object.entries(providersConfig.endpoints)
          .filter(([name]) => experiment.config.agents.some((a) => a.provider === name))
          .map(([name, e]) => [name, { protocol: e.protocol, base_url: e.base_url, max_tokens: e.max_tokens, extra_body: e.extra_body }]),
      )
    : {};

  return { scenario, rules, actions, argValidators, world, deciders, envRng, endpoints };
}

export async function runExperiment(path: string, options: RunOptions = {}): Promise<RunSummary> {
  const experiment = await loadExperiment(path);
  const prepared = await prepareRun(experiment, options);

  let runId = "00000";
  let eventsPath: string | undefined;
  let sink = options.sink;
  if (!sink) {
    ({ runId, path: eventsPath } = nextRunId(options.eventsDir ?? "events", experiment.experimentId));
    sink = new JsonlSink(eventsPath);
  }
  const log = new EventLog(experiment.experimentId, runId, sink, options.clock);
  options.onLog?.(log);

  const goals = new Map(experiment.config.agents.map((a) => [a.id, a.goal]));
  const roles = new Map(experiment.config.agents.map((a) => [a.id, a.role]));
  log.emit("experiment.started", 0, {
    experiment_id: experiment.experimentId,
    run_id: runId,
    seed: experiment.config.seed,
    experiment_file: experiment.path,
    scenario: { file: prepared.scenario.path, hooks: prepared.scenario.hooksPath ?? null, ...prepared.scenario.config },
    actions: prepared.actions.map((a) => a.tool),
    agents: prepared.deciders.map((d) => ({ id: d.id, goal: goals.get(d.id), role: roles.get(d.id), ...d.decider.describe })),
    endpoints: prepared.endpoints,
    snapshot: prepared.world.snapshot(0),
  });

  const engine = new Engine({
    scenario: prepared.scenario,
    world: prepared.world,
    agents: prepared.deciders,
    actions: prepared.actions,
    argValidators: prepared.argValidators,
    rules: prepared.rules,
    rng: prepared.envRng,
    log,
  });

  try {
    const result = await engine.run();
    log.emit("experiment.finished", result.turns, { reason: result.reason, turns: result.turns, snapshot: prepared.world.snapshot(result.turns) });
    return { ...result, experimentId: experiment.experimentId, runId, eventsPath };
  } catch (error) {
    log.emit("experiment.failed", 0, { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    throw error;
  } finally {
    log.close();
  }
}
