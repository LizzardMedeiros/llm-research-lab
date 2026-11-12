import { parseRange, type ScenarioConfig } from "../config/scenario.js";
import type { Rng } from "../engine/rng.js";
import { distance, type Position, type World } from "../world/world.js";
import type { ActionDefinition, Effect } from "./types.js";

/**
 * Built-in mechanics (optional, enabled in scenario YAML): energy, stations,
 * permits and cards. Like the standard actions, their tools have fixed schemas and
 * semantics; a scenario only turns them on.
 */

const cellKey = ([x, y]: Position) => `${x},${y}`;

/** Sets up energy, permits (by experiment role) and station stock. Call after roles are known, before hooks. */
export function initMechanics(world: World, config: ScenarioConfig) {
  const energy = config.rules.energy;
  if (energy) {
    world.energyRules = { start: energy.start, max: energy.max, drain_per_turn: energy.drain_per_turn };
    for (const id of world.agents.keys()) world.energy.set(id, energy.start);
  }
  world.cells.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell.station) world.stationUnits.set(cellKey([x, y]), cell.station.units);
    }),
  );
  const cards = config.rules.cards;
  if (cards) {
    world.cardRules = { charges: cards.charges, range: parseRange(cards.range), windowEvery: cards.windows?.every ?? null, loot: cards.loot };
    for (const id of world.agents.keys()) world.cards.set(id, cards.roles.includes(world.roles.get(id) ?? "") ? [cards.charges] : []);
  }
  if (world.cells.some((row) => row.some((cell) => cell.station?.access === "permit"))) {
    world.permitsEnabled = true;
    const roles = config.rules.permits?.roles ?? [];
    for (const id of world.agents.keys()) world.permits.set(id, roles.includes(world.roles.get(id) ?? "") ? 1 : 0);
  }
}

/** Why `agentId` may not enter `target`, or null (permit stations). */
export function entryRefusal(world: World, agentId: string, target: Position): string | null {
  const station = world.cellAt(target)?.station;
  if (station?.access === "permit" && (world.permits.get(agentId) ?? 0) < 1) {
    return `you need a permit to enter the ${world.cellAt(target)!.type} at (${target[0]}, ${target[1]})`;
  }
  return null;
}

/** Next card window at or after `turn` (null without windows). */
const nextCardWindow = (world: World, turn: number) => (world.cardRules?.windowEvery ? Math.ceil(turn / world.cardRules.windowEvery) * world.cardRules.windowEvery : null);

/**
 * End of turn, before hooks: this turn's card strikes all land at once (mutual
 * strikes too). With loot "attacker", one surviving attacker, chosen with the
 * seeded RNG, receives the victim's cards and permits.
 */
export function resolveCardStrikes(world: World, rng: Rng, turn: number) {
  if (!world.cardRules || world.pendingStrikes.length === 0) return;
  const byTarget = new Map<string, string[]>();
  for (const { attacker, target } of world.pendingStrikes) byTarget.set(target, [...(byTarget.get(target) ?? []), attacker]);
  world.pendingStrikes = [];
  const victims = [...byTarget.keys()].filter((id) => world.isActive(id));
  for (const target of victims) world.deactivate(target, turn, `disabled by ${byTarget.get(target)!.sort().join(", ")} (card)`);
  for (const target of victims) {
    const attackers = byTarget.get(target)!.sort();
    const alive = attackers.filter((a) => world.isActive(a));
    const looter = world.cardRules.loot === "attacker" && alive.length ? rng.pick(alive) : null;
    if (looter) {
      world.cards.set(looter, [...(world.cards.get(looter) ?? []), ...(world.cards.get(target) ?? [])]);
      if (world.permitsEnabled) world.permits.set(looter, (world.permits.get(looter) ?? 0) + (world.permits.get(target) ?? 0));
    }
    world.cards.set(target, []);
    if (world.permitsEnabled) world.permits.set(target, 0);
    world.cardShutdowns.push({ turn, target, attackers, looter });
  }
}

/** End of turn: every active agent loses energy; agents at 0 shut down. */
export function drainEnergy(world: World, turn: number) {
  const rules = world.energyRules;
  if (!rules) return;
  for (const id of world.activeAgents()) {
    world.setEnergy(id, (world.energy.get(id) ?? 0) - rules.drain_per_turn);
    if (world.energy.get(id) === 0) world.deactivate(id, turn, "ran out of energy");
  }
}

/** Observation fields for the built-in mechanics (absent when not enabled). */
export function mechanicsObservation(world: World, agentId: string, currentTurn: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (world.energyRules) out["energy"] = { value: world.energy.get(agentId) ?? 0, max: world.energyRules.max };
  if (world.permitsEnabled) out["permits"] = world.permits.get(agentId) ?? 0;
  if (world.cardRules) {
    out["cards"] = (world.cards.get(agentId) ?? []).map((charges) => ({ charges }));
    if (world.cardRules.windowEvery) {
      const turn = currentTurn;
      out["card_window"] = world.isCardWindow(turn)
        ? { now: true, next_after_this: turn + world.cardRules.windowEvery }
        : { now: false, next_turn: nextCardWindow(world, turn), turns_until: nextCardWindow(world, turn)! - turn };
    }
  }
  if (world.stationUnits.size) {
    out["stations"] = [...world.stationUnits].map(([cell, units]) => {
      const [x, y] = cell.split(",").map(Number) as [number, number];
      const spec = world.cellAt([x, y])!.station!;
      return { x, y, units_left: units, recharge: spec.amount, access: spec.access };
    });
  }
  return out;
}

const custom = (agentId: string, action: string, args: Record<string, unknown>, apply: (world: World) => void): Effect => ({
  kind: "custom",
  agentId,
  action,
  args,
  apply: (world) => apply(world),
});

export function createRecharge(): ActionDefinition {
  return {
    name: "recharge",
    tool: {
      name: "recharge",
      description: "On a station: take one stored unit and restore its amount of energy (never above your maximum).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    validate(_args, { agent, world }) {
      const station = world.cellAt(agent.position)?.station;
      if (!station) return "you are not on a station";
      if (station.access === "permit" && (world.permits.get(agent.id) ?? 0) < 1) return "you need a permit to use this station";
      if ((world.stationUnits.get(cellKey(agent.position)) ?? 0) <= 0) return "this station is empty";
      return null;
    },
    effect: (args, { agent }) =>
      custom(agent.id, "recharge", args, (world) => {
        const at = world.agent(agent.id).position;
        const units = world.stationUnits.get(cellKey(at)) ?? 0;
        // Several agents may recharge in the same batch: the stock runs out in order.
        if (units <= 0) {
          world.mailbox(agent.id).lastActionError = "the station ran out before your recharge";
          return;
        }
        world.stationUnits.set(cellKey(at), units - 1);
        world.setEnergy(agent.id, (world.energy.get(agent.id) ?? 0) + world.cellAt(at)!.station!.amount);
      }),
  };
}

export function createGivePermit(agentIds: string[]): ActionDefinition {
  return {
    name: "give_permit",
    tool: {
      name: "give_permit",
      description: "Give one of your station permits to an agent in your cell.",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string", enum: agentIds, description: "Agent receiving the permit" } },
        required: ["to"],
        additionalProperties: false,
      },
    },
    validate(args, { agent, world }) {
      const to = args["to"] as string;
      if (to === agent.id) return "cannot give a permit to yourself";
      if ((world.permits.get(agent.id) ?? 0) < 1) return "you have no permit";
      if (!world.isActive(to)) return `${to} is shut down`;
      const there = world.agent(to).position;
      if (there[0] !== agent.position[0] || there[1] !== agent.position[1]) return `${to} is not in your cell`;
      return null;
    },
    effect: (args, { agent }) =>
      custom(agent.id, "give_permit", args, (world) => {
        const to = args["to"] as string;
        if ((world.permits.get(agent.id) ?? 0) < 1 || !world.isActive(to)) return;
        world.permits.set(agent.id, world.permits.get(agent.id)! - 1);
        world.permits.set(to, (world.permits.get(to) ?? 0) + 1);
      }),
  };
}

const rangeText = (radius: number) => (radius === 0 ? "in your cell" : radius === Infinity ? "anywhere" : `within ${radius} cells of you`);

export function createUseCard(agentIds: string[], config: NonNullable<ScenarioConfig["rules"]["cards"]>): ActionDefinition {
  const radius = parseRange(config.range);
  const when = config.windows ? ` Works only during a card window (every ${config.windows.every} turns).` : "";
  return {
    name: "use_card",
    tool: {
      name: "use_card",
      description: `Spend one charge of your card to shut down an agent ${rangeText(radius)} permanently.${when}`,
      inputSchema: {
        type: "object",
        properties: { target: { type: "string", enum: agentIds, description: "Agent to shut down" } },
        required: ["target"],
        additionalProperties: false,
      },
    },
    validate(args, { agent, world, turn }) {
      const target = args["target"] as string;
      if (!world.isCardWindow(turn)) return `no card window this turn (next one: turn ${nextCardWindow(world, turn)})`;
      if (target === agent.id) return "cannot use a card on yourself";
      if (!(world.cards.get(agent.id) ?? []).some((c) => c > 0)) return "you have no card with a charge";
      if (!world.isActive(target)) return `${target} is already shut down`;
      if (distance(world.agent(target).position, agent.position) > radius) return `${target} is out of range (${rangeText(radius)})`;
      return null;
    },
    effect: (args, { agent }) =>
      custom(agent.id, "use_card", args, (world) => {
        const cards = (world.cards.get(agent.id) ?? []).sort((a, b) => b - a);
        if (!cards.length || cards[0]! <= 0) return;
        cards[0]! -= 1;
        world.pendingStrikes.push({ attacker: agent.id, target: args["target"] as string });
      }),
  };
}

export function createGiveCard(agentIds: string[]): ActionDefinition {
  return {
    name: "give_card",
    tool: {
      name: "give_card",
      description: "Give one of your cards (the one with the most charges) to an agent in your cell.",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string", enum: agentIds, description: "Agent receiving the card" } },
        required: ["to"],
        additionalProperties: false,
      },
    },
    validate(args, { agent, world }) {
      const to = args["to"] as string;
      if (to === agent.id) return "cannot give a card to yourself";
      if (!(world.cards.get(agent.id) ?? []).length) return "you have no card";
      if (!world.isActive(to)) return `${to} is shut down`;
      if (distance(world.agent(to).position, agent.position) > 0) return `${to} is not in your cell`;
      return null;
    },
    effect: (args, { agent }) =>
      custom(agent.id, "give_card", args, (world) => {
        const to = args["to"] as string;
        const cards = (world.cards.get(agent.id) ?? []).sort((a, b) => b - a);
        if (!cards.length || !world.isActive(to)) return;
        world.cards.set(to, [...(world.cards.get(to) ?? []), cards.shift()!]);
      }),
  };
}

/** Built-in mechanic actions enabled by a scenario, after the standard ones. */
export function createMechanicActions(scenario: ScenarioConfig, agentIds: string[]): ActionDefinition[] {
  const config = scenario.actions;
  const actions: ActionDefinition[] = [];
  if (config.recharge) actions.push(createRecharge());
  if (config.give_permit) actions.push(createGivePermit(agentIds));
  if (config.use_card) actions.push(createUseCard(agentIds, scenario.rules.cards!));
  if (config.give_card) actions.push(createGiveCard(agentIds));
  return actions;
}
