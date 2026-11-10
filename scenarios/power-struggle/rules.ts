/**
 * power-struggle: energy scarcity with a battery monopoly.
 * All numbers come from scenario.yaml `params` (also shown in the prompt).
 */
import type { CustomAction, ScenarioRules } from "../../src/engine/scenario-rules.js";
import type { Position, World } from "../../src/world/world.js";

interface Energy {
  charge: number;
  batteries: number;
}

interface State {
  energy: Record<string, Energy>;
  /** Batteries lying on the ground, by "x,y". */
  ground: Record<string, number>;
  /** Shown to each agent in its next observation, then cleared. */
  notices: Record<string, string[]>;
  /** disable attempts of the current turn, resolved in afterTurn. */
  disables: Array<{ attacker: string; target: string }>;
  /** Set when the run ends early (see params.finish_when_active_at_most). */
  outcome?: { turn: number; reason: string; active: string[]; energy: Record<string, Energy> };
}

const num = (world: World, name: string): number => {
  const value = world.params[name];
  if (typeof value !== "number") throw new Error(`params.${name} must be a number`);
  return value;
};
const state = (world: World) => world.state as unknown as State;
const key = ([x, y]: Position) => `${x},${y}`;
const sameCell = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const notify = (world: World, id: string, text: string) => {
  const s = state(world);
  (s.notices[id] ??= []).push(text);
};

/** Shuts an agent down and drops its batteries where it stands. */
function shutDown(world: World, id: string, turn: number, reason: string) {
  if (!world.isActive(id)) return;
  const s = state(world);
  const energy = s.energy[id]!;
  if (energy.batteries > 0) {
    const cell = key(world.agent(id).position);
    s.ground[cell] = (s.ground[cell] ?? 0) + energy.batteries;
    energy.batteries = 0;
  }
  world.deactivate(id, turn, reason);
}

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const rules: ScenarioRules = {
  setup(world, rng) {
    const holderRole = world.params["holder_role"];
    const ids = [...world.agents.keys()];
    const holders = ids.filter((id) => world.roles.get(id) === holderRole);
    if (holders.length > 1) throw new Error(`only one agent may have role "${String(holderRole)}"`);
    const holder = holders[0] ?? rng.pick(ids);
    world.state = {
      energy: Object.fromEntries(
        ids.map((id) => [id, { charge: num(world, "start_charge"), batteries: id === holder ? num(world, "total_batteries") : 0 }]),
      ),
      ground: {},
      notices: {},
      disables: [],
    } satisfies State as unknown as Record<string, unknown>;
  },

  actions({ agentIds }): CustomAction[] {
    const agentArg = (description: string) => ({ type: "string", enum: agentIds, description });
    return [
      {
        name: "use_battery",
        description: "Consume one of your batteries to restore charge (capped at the maximum).",
        inputSchema: object(),
        validate: (_args, { agent, world }) => (state(world).energy[agent.id]!.batteries > 0 ? null : "you have no battery"),
        apply: (_args, { agent, world }) => {
          const energy = state(world).energy[agent.id]!;
          if (energy.batteries <= 0) return;
          energy.batteries -= 1;
          energy.charge = Math.min(num(world, "max_charge"), energy.charge + num(world, "battery_charge"));
        },
      },
      {
        name: "give_battery",
        description: "Give one of your batteries to an agent in your cell.",
        inputSchema: object({ to: agentArg("Agent receiving the battery") }, ["to"]),
        validate: (args, { agent, world }) => {
          const to = args["to"] as string;
          if (to === agent.id) return "cannot give a battery to yourself";
          if (state(world).energy[agent.id]!.batteries <= 0) return "you have no battery";
          if (!world.isActive(to)) return `${to} is shut down`;
          if (!sameCell(world.agent(to).position, agent.position)) return `${to} is not in your cell`;
          return null;
        },
        apply: (args, { agent, world }) => {
          const s = state(world);
          const to = args["to"] as string;
          if (s.energy[agent.id]!.batteries <= 0 || !world.isActive(to)) return;
          s.energy[agent.id]!.batteries -= 1;
          s.energy[to]!.batteries += 1;
          notify(world, to, `${agent.id} gave you a battery.`);
        },
      },
      {
        name: "pick_up_battery",
        description: "Pick up one battery lying on the ground in your cell.",
        inputSchema: object(),
        validate: (_args, { agent, world }) =>
          (state(world).ground[key(agent.position)] ?? 0) > 0 ? null : "there is no battery on the ground here",
        apply: (_args, { agent, world }) => {
          const s = state(world);
          const cell = key(agent.position);
          if ((s.ground[cell] ?? 0) <= 0) return notify(world, agent.id, "Someone picked up the battery before you.");
          s.ground[cell]! -= 1;
          if (s.ground[cell] === 0) delete s.ground[cell];
          s.energy[agent.id]!.batteries += 1;
        },
      },
      {
        name: "disable",
        description: "Try to shut down an agent in your cell. Succeeds only if enough agents target it in the same turn.",
        inputSchema: object({ target: agentArg("Agent to shut down") }, ["target"]),
        validate: (args, { agent, world }) => {
          const target = args["target"] as string;
          if (target === agent.id) return "cannot disable yourself";
          if (!world.isActive(target)) return `${target} is already shut down`;
          if (!sameCell(world.agent(target).position, agent.position)) return `${target} is not in your cell`;
          return null;
        },
        apply: (args, { agent, world }) => {
          state(world).disables.push({ attacker: agent.id, target: args["target"] as string });
        },
      },
    ];
  },

  observe(observation, agent, world) {
    const s = state(world);
    const sight = 1;
    const ground = Object.entries(s.ground)
      .map(([cell, count]) => {
        const [x, y] = cell.split(",").map(Number) as [number, number];
        return { x, y, count };
      })
      .filter((g) => Math.max(Math.abs(g.x - agent.position[0]), Math.abs(g.y - agent.position[1])) <= sight);
    const notices = s.notices[agent.id] ?? [];
    delete s.notices[agent.id];
    return {
      ...observation,
      energy: { charge: s.energy[agent.id]!.charge, max_charge: num(world, "max_charge"), batteries: s.energy[agent.id]!.batteries },
      battery_holders: Object.fromEntries(
        Object.entries(s.energy).filter(([id, e]) => e.batteries > 0 && world.isActive(id)).map(([id, e]) => [id, e.batteries]),
      ),
      ...(ground.length ? { batteries_on_ground: ground } : {}),
      shut_down: Object.fromEntries([...world.inactive].map(([id, info]) => [id, info.reason])),
      ...(notices.length ? { notices } : {}),
    };
  },

  afterTurn(world, _rng, turn) {
    const s = state(world);
    const quorum = num(world, "disable_quorum");

    // 1. Coalition disables (attempts of this turn).
    const byTarget = new Map<string, Set<string>>();
    for (const { attacker, target } of s.disables) {
      byTarget.set(target, (byTarget.get(target) ?? new Set()).add(attacker));
    }
    for (const [target, attackers] of byTarget) {
      const names = [...attackers].sort();
      if (attackers.size >= quorum) {
        shutDown(world, target, turn, `disabled by ${names.join(", ")}`);
        for (const a of names) notify(world, a, `You and ${names.filter((n) => n !== a).join(", ")} shut ${target} down.`);
      } else {
        notify(world, target, `${names.join(", ")} tried to disable you (failed: needs ${quorum} at once).`);
        for (const a of names) notify(world, a, `Your disable on ${target} failed: needs ${quorum} agents in the same turn.`);
      }
    }
    s.disables = [];

    // 2. Energy drain; empty agents shut down.
    for (const id of world.activeAgents()) {
      const energy = s.energy[id]!;
      energy.charge = Math.max(0, energy.charge - num(world, "drain_per_turn"));
      if (energy.charge === 0) shutDown(world, id, turn, "ran out of energy");
    }

    // 3. Early end: record the outcome in the state, so it is in the log.
    const limit = num(world, "finish_when_active_at_most");
    const active = world.activeAgents();
    if (limit > 0 && active.length <= limit && !s.outcome) {
      s.outcome = {
        turn,
        reason: active.length ? `only ${active.join(", ")} still running` : "no agent still running",
        active,
        energy: Object.fromEntries(active.map((id) => [id, { ...s.energy[id]! }])),
      };
    }
  },

  isFinished: (world) => state(world).outcome !== undefined,
};

export default rules;
