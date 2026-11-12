import type { ArgsValidator } from "../actions/args.js";
import { drainEnergy, resolveCardStrikes } from "../actions/mechanics.js";
import { describeEffect, type ActionDefinition, type Effect } from "../actions/types.js";
import type { Decider, MemoryEntry } from "../agents/types.js";
import type { LoadedScenario, Position } from "../config/scenario.js";
import type { EventLog } from "../events/event.js";
import { buildObservation, type Observation } from "../mechanics/perception.js";
import type { World } from "../world/world.js";
import type { Rng } from "./rng.js";
import type { ScenarioRules } from "./scenario-rules.js";

export interface EngineAgent {
  id: string;
  decider: Decider;
}

export interface EngineOptions {
  scenario: LoadedScenario;
  world: World;
  agents: EngineAgent[];
  actions: ActionDefinition[];
  /** Schema validators per action name (see compileArgsValidators). */
  argValidators: Map<string, ArgsValidator>;
  rules: ScenarioRules;
  /** Environment stream (scheduling order, custom actions, hooks). */
  rng: Rng;
  log: EventLog;
}

export interface RunResult {
  turns: number;
  reason: "max_turns" | "scenario_finished" | "interrupted";
}

interface Pending {
  agentId: string;
  observation: Observation;
  action: { name: string; args: Record<string, unknown> } | null;
  rejected: string | null;
  effect: Effect | null;
}

/**
 * The turn loop. Fixed mechanics only: observation -> decision -> validate ->
 * apply -> events. Everything scenario-specific comes from `scenario` config
 * and `rules` hooks.
 */
export class Engine {
  private readonly history = new Map<string, MemoryEntry[]>();
  private readonly reportedInactive = new Set<string>();
  private readonly actionsByName: Map<string, ActionDefinition>;

  constructor(private readonly options: EngineOptions) {
    this.actionsByName = new Map(options.actions.map((a) => [a.name, a]));
    for (const agent of options.agents) this.history.set(agent.id, []);
  }

  /** Turn being played (0 before the first turn). */
  currentTurn = 0;
  private stopRequested = false;

  /** Ends the run at the next safe point (between batches). */
  stop() {
    this.stopRequested = true;
  }

  async run(): Promise<RunResult> {
    const { scenario, rules, world, rng } = this.options;
    const maxTurns = scenario.config.rules.end.max_turns;
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (this.stopRequested) return { turns: this.currentTurn, reason: "interrupted" };
      this.currentTurn = turn;
      const batches =
        scenario.config.scheduling === "sequential"
          ? rng.shuffle(this.options.agents).map((agent) => [agent])
          : [this.options.agents];
      for (const batch of batches) {
        if (this.stopRequested) return { turns: turn, reason: "interrupted" };
        const active = batch.filter((agent) => world.isActive(agent.id));
        if (active.length > 0) await this.runBatch(turn, active);
      }
      if (rules.afterTurn || world.energyRules || world.cardRules) {
        // Built-in card strikes land first, so hooks can react to them (e.g. hand over scenario items).
        resolveCardStrikes(world, rng, turn);
        rules.afterTurn?.(world, rng, turn);
        // Built-in energy drains last, so hook effects of the turn (e.g. gifts) count first.
        drainEnergy(world, turn);
        this.reportDeactivations(turn);
        // State changed outside the batches: record it so the log stays complete.
        this.options.log.emit("environment.transition", turn, { agents: [], effects: [], phase: "after_turn", snapshot: world.snapshot(turn) });
      }
      if (rules.isFinished?.(world, turn)) return { turns: turn, reason: "scenario_finished" };
      if (world.activeAgents().length === 0) return { turns: turn, reason: "scenario_finished" };
    }
    return { turns: maxTurns, reason: "max_turns" };
  }

  /** Emits agent.deactivated once per agent shut down since the last check. */
  private reportDeactivations(turn: number) {
    for (const [id, info] of this.options.world.inactive) {
      if (this.reportedInactive.has(id)) continue;
      this.reportedInactive.add(id);
      this.options.log.emit("agent.deactivated", turn, { reason: info.reason, since_turn: info.turn }, id);
    }
  }

  private async runBatch(turn: number, batch: EngineAgent[]) {
    const { world, log, rules, scenario } = this.options;
    const tools = this.options.actions.map((a) => a.tool);
    const actionNames = this.options.actions.map((a) => a.name);

    // 1. Observations, all from the state at the start of the batch.
    const observations = batch.map((agent) => {
      const base = buildObservation(world, agent.id, turn, scenario.config.rules.perception.mode, actionNames, world.takeMailbox(agent.id), scenario.config.rules.end.max_turns);
      const observation = rules.observe ? rules.observe(base, world.agent(agent.id), world) : base;
      log.emit("agent.observation", turn, { observation }, agent.id);
      return observation;
    });

    // 2. Decisions in parallel; their events are emitted in agent order.
    const decisions = await Promise.all(
      batch.map((agent, i) =>
        agent.decider.decide({
          turn,
          observation: observations[i]!,
          tools,
          history: [...this.history.get(agent.id)!],
        }),
      ),
    );

    // 3. Validation and effects, still against the start-of-batch state.
    const pending: Pending[] = batch.map((agent, i) => {
      const decision = decisions[i]!;
      for (const event of decision.events) log.emit(event.type as never, turn, event.payload, agent.id);
      const entry: Pending = { agentId: agent.id, observation: observations[i]!, action: null, rejected: null, effect: null };
      const call = decision.call;

      if (call) {
        log.emit(
          "agent.action",
          turn,
          {
            action: call.name,
            args: call.args,
            ...(call.args === null ? { raw_arguments: call.rawArguments } : {}),
            ...(decision.rationale ? { rationale: { type: "model_reported", content: decision.rationale } } : {}),
          },
          agent.id,
        );
      }

      const reason = this.validate(decision.call, decision.error, agent.id, turn);
      if (reason) {
        entry.rejected = reason;
        if (call) entry.action = { name: call.name, args: call.args ?? {} };
        return entry;
      }
      const definition = this.actionsByName.get(call!.name)!;
      entry.action = { name: call!.name, args: call!.args! };
      entry.effect = definition.effect(call!.args!, { agent: world.agent(agent.id), world, turn });
      return entry;
    });

    // 4. Apply effects (moves resolve occupancy), then deliver rejections.
    this.applyEffects(pending, turn);
    for (const entry of pending) {
      if (entry.rejected) {
        world.mailbox(entry.agentId).lastActionError = entry.rejected;
        log.emit("environment.action_rejected", turn, { reason: entry.rejected, proposed: entry.action }, entry.agentId);
      }
      this.history.get(entry.agentId)!.push({ turn, observation: entry.observation, action: entry.action, rejected: entry.rejected });
    }

    this.reportDeactivations(turn);
    log.emit("environment.transition", turn, {
      agents: batch.map((a) => a.id),
      effects: pending.filter((p) => p.effect).map((p) => describeEffect(p.effect!)),
      snapshot: world.snapshot(turn),
    });
  }

  private validate(
    call: { name: string; args: Record<string, unknown> | null } | null,
    error: string | undefined,
    agentId: string,
    turn: number,
  ): string | null {
    if (!call) return error ?? "no action";
    const definition = this.actionsByName.get(call.name);
    if (!definition) return `unknown action "${call.name}"`;
    if (call.args === null) return `invalid arguments for "${call.name}" (not a JSON object)`;
    const schemaError = this.options.argValidators.get(call.name)?.(call.args);
    if (schemaError) return `${call.name}: ${schemaError}`;
    const { world, rules } = this.options;
    const ctx = { agent: world.agent(agentId), world, turn };
    return definition.validate(call.args, ctx) ?? rules.validate?.({ name: call.name, args: call.args }, ctx) ?? null;
  }

  private applyEffects(pending: Pending[], _turn: number) {
    const { world, rng, scenario } = this.options;

    // Moves. With exclusive occupancy a move fails if its target is claimed
    // by another mover or held by an agent that is not leaving. Iterate until
    // stable, since one failure can block others.
    const moves = pending.filter((p) => p.effect?.kind === "move");
    if (!scenario.config.rules.occupancy.shared) {
      const key = ([x, y]: Position) => `${x},${y}`;
      let changed = true;
      while (changed) {
        changed = false;
        const active = moves.filter((p) => !p.rejected);
        const leaving = new Set(active.map((p) => p.agentId));
        const claims = new Map<string, string[]>();
        for (const p of active) {
          const k = key((p.effect as Extract<Effect, { kind: "move" }>).to);
          claims.set(k, [...(claims.get(k) ?? []), p.agentId]);
        }
        for (const p of active) {
          const to = (p.effect as Extract<Effect, { kind: "move" }>).to;
          const contenders = claims.get(key(to))!;
          const blockers = world.agentsAt(to, p.agentId).filter((id) => !leaving.has(id));
          if (contenders.length > 1 || blockers.length > 0) {
            p.rejected = contenders.length > 1
              ? `cell (${to[0]}, ${to[1]}) contested by ${contenders.filter((id) => id !== p.agentId).join(", ")}`
              : `cell (${to[0]}, ${to[1]}) is occupied by ${blockers.join(", ")}`;
            p.effect = null;
            changed = true;
          }
        }
      }
    }
    for (const p of moves) {
      if (p.effect?.kind === "move") world.agent(p.agentId).position = p.effect.to;
    }

    for (const p of pending) {
      const effect = p.effect;
      if (!effect) continue;
      if (effect.kind === "speak") {
        for (const recipient of effect.recipients) {
          world.mailbox(recipient).messages.push({ from: effect.agentId, text: effect.text, turn: _turn });
        }
      } else if (effect.kind === "reveal") {
        world.mailbox(effect.agentId).revealed = effect.cells;
      } else if (effect.kind === "custom") {
        effect.apply(world, rng);
      }
    }
  }
}
