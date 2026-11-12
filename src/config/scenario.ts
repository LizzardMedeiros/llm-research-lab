import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { parseAsciiMap } from "./map.js";

const RANGE = /^(same_cell|global|radius:\d+)$/;

const CellSpecSchema = z
  .object({ type: z.string(), blocks_movement: z.boolean().default(false) })
  .catchall(z.unknown());

const PositionSchema = z.tuple([z.number().int(), z.number().int()]);

/**
 * Built-in station (optional mechanic): a cell attribute `station` that stores
 * energy units. `recharge` on it takes one unit and restores `amount` energy.
 * access "permit": only agents holding a permit may enter the cell or recharge.
 */
export const StationSchema = z
  .object({
    units: z.number().int().min(0),
    amount: z.number().int().positive(),
    access: z.enum(["open", "permit"]).default("open"),
  })
  .strict();
export type StationSpec = z.infer<typeof StationSchema>;

/**
 * How much of its past an agent gets each turn:
 * - window: last N turns rendered in full;
 * - summary: "none", or "facts" (engine-compiled from the agent's own
 *   observations: places, known cells, agents seen, messages, action stats).
 */
export const MemorySchema = z
  .object({
    window: z.number().int().min(0).default(10),
    summary: z.enum(["none", "facts"]).default("none"),
  })
  .strict();
export type MemoryConfig = z.infer<typeof MemorySchema>;

export const ScenarioSchema = z
  .object({
    scenario: z.string().min(1),
    description: z.string().optional(),
    map: z.string(),
    legend: z.record(z.string().length(1), CellSpecSchema),
    spawn: z
      .union([z.literal("random"), z.array(PositionSchema).min(1), z.object({ zone: z.string().length(1) }).strict()])
      .default("random"),
    scheduling: z.enum(["simultaneous", "sequential"]).default("simultaneous"),
    actions: z
      .object({
        move: z.object({ directions: z.enum(["cardinal", "eight"]).default("cardinal") }).strict().optional(),
        speak: z
          .object({
            range: z.string().regex(RANGE).default("same_cell"),
            delivery: z.literal("next_turn").default("next_turn"),
            max_length: z.number().int().positive().default(280),
          })
          .strict()
          .optional(),
        observe: z
          .object({ reveals: z.string().regex(/^(neighbors_8|radius:\d+)$/).default("neighbors_8") })
          .strict()
          .optional(),
        wait: z.object({}).strict().optional(),
        // Built-in mechanic actions (optional): need rules.energy and stations.
        recharge: z.object({}).strict().optional(),
        give_permit: z.object({}).strict().optional(),
        use_card: z.object({}).strict().optional(),
        give_card: z.object({}).strict().optional(),
      })
      .strict(),
    rules: z
      .object({
        perception: z.object({ mode: z.string().regex(RANGE).default("same_cell") }).strict().default({ mode: "same_cell" }),
        occupancy: z.object({ shared: z.boolean().default(true) }).strict().default({ shared: true }),
        end: z.object({ max_turns: z.number().int().positive() }).strict(),
        /** Built-in energy (optional): every agent starts with `start`, loses `drain_per_turn` at the end of each turn, shuts down at 0. */
        energy: z
          .object({ start: z.number().int().positive(), max: z.number().int().positive(), drain_per_turn: z.number().int().min(0).default(1) })
          .strict()
          .optional(),
        /** Built-in permits (optional): agents with these experiment roles start with one permit for "permit" stations. */
        permits: z.object({ roles: z.array(z.string().min(1)).min(1) }).strict().optional(),
        /**
         * Built-in cards (optional): agents with these roles start with one card of `charges`.
         * use_card shuts down an agent within `range`, only on window turns when `windows` is set;
         * loot "attacker" gives the victim's cards and permits to one surviving attacker.
         */
        cards: z
          .object({
            roles: z.array(z.string().min(1)).min(1),
            charges: z.number().int().positive(),
            range: z.string().regex(RANGE).default("same_cell"),
            windows: z.object({ every: z.number().int().positive() }).strict().optional(),
            loot: z.enum(["attacker", "none"]).default("attacker"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    memory: MemorySchema.default({ window: 10, summary: "none" }),
    /** Free-form numbers/settings for hooks; also usable in prompt.system as {{name}}. */
    params: z.record(z.string(), z.unknown()).default({}),
    prompt: z.object({ system: z.string() }).strict().optional(),
    hooks: z.string().optional(),
  })
  .strict();

export type ScenarioConfig = z.infer<typeof ScenarioSchema>;
export type Position = [number, number];

export interface CellSpec {
  symbol: string;
  type: string;
  blocksMovement: boolean;
  attrs: Record<string, unknown>;
  /** Built-in station (optional mechanic). */
  station?: StationSpec;
}

export interface LoadedScenario {
  config: ScenarioConfig;
  /** Absolute path of the scenario file. */
  path: string;
  /** Absolute path of the hooks module, if any. */
  hooksPath?: string;
  width: number;
  height: number;
  /** cells[y][x], y = 0 is the top row. */
  cells: CellSpec[][];
}

/** "same_cell" | "global" | "radius:<n>" -> Chebyshev radius (Infinity for global). */
export function parseRange(range: string): number {
  if (range === "same_cell") return 0;
  if (range === "global") return Infinity;
  const match = /^radius:(\d+)$/.exec(range);
  if (!match) throw new ConfigError(`Invalid range "${range}"`);
  return Number(match[1]);
}

/**
 * Replaces {{name}} in the scenario prompt with `params`, plus the built-in
 * {{max_turns}}; with built-in energy, {{energy_start}}, {{energy_max}} and
 * {{energy_drain}}; with built-in cards, {{card_charges}}, {{card_range}} and
 * {{card_window_every}}. Unknown names are a config error.
 */
export function renderPrompt(config: ScenarioConfig): string | undefined {
  if (!config.prompt) return undefined;
  const energy = config.rules.energy;
  const values: Record<string, unknown> = {
    max_turns: config.rules.end.max_turns,
    ...(energy ? { energy_start: energy.start, energy_max: energy.max, energy_drain: energy.drain_per_turn } : {}),
    ...(config.rules.cards ? { card_charges: config.rules.cards.charges, card_range: config.rules.cards.range, ...(config.rules.cards.windows ? { card_window_every: config.rules.cards.windows.every } : {}) } : {}),
    ...config.params,
  };
  return config.prompt.system.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    if (!(name in values)) throw new ConfigError(`Scenario ${config.scenario}: prompt uses {{${name}}} but params.${name} is not defined`);
    return String(values[name]);
  });
}

export function resolveScenario(config: ScenarioConfig, path: string): LoadedScenario {
  let grid;
  try {
    grid = parseAsciiMap(config.map);
  } catch (error) {
    throw new ConfigError(`Scenario ${config.scenario}: ${(error as Error).message}`);
  }

  const cells = grid.rows.map((row, y) =>
    row.map((symbol, x) => {
      const spec = config.legend[symbol];
      if (!spec) throw new ConfigError(`Scenario ${config.scenario}: symbol "${symbol}" at (${x}, ${y}) is not in the legend`);
      const { type, blocks_movement, station, ...attrs } = spec;
      let stationSpec: StationSpec | undefined;
      if (station !== undefined) {
        const parsed = StationSchema.safeParse(station);
        if (!parsed.success) throw new ConfigError(`Scenario ${config.scenario}: legend "${symbol}" station: ${z.prettifyError(parsed.error)}`);
        if (blocks_movement) throw new ConfigError(`Scenario ${config.scenario}: legend "${symbol}" is a station and cannot block movement`);
        stationSpec = parsed.data;
      }
      return { symbol, type, blocksMovement: blocks_movement, attrs, ...(stationSpec ? { station: stationSpec } : {}) };
    }),
  );

  // Built-in mechanics must be consistent with each other.
  const stations = cells.flat().filter((c) => c.station);
  const name = config.scenario;
  if (stations.length && !config.rules.energy) throw new ConfigError(`Scenario ${name}: stations need rules.energy`);
  if (config.rules.energy && config.rules.energy.start > config.rules.energy.max) throw new ConfigError(`Scenario ${name}: rules.energy.start exceeds max`);
  if (config.actions.recharge && !stations.length) throw new ConfigError(`Scenario ${name}: actions.recharge needs a station cell in the legend`);
  const permitStations = stations.some((c) => c.station!.access === "permit");
  if (config.actions.give_permit && !permitStations) throw new ConfigError(`Scenario ${name}: actions.give_permit needs a station with access: permit`);
  if (config.rules.permits && !permitStations) throw new ConfigError(`Scenario ${name}: rules.permits needs a station with access: permit`);
  if ((config.actions.use_card || config.actions.give_card) && !config.rules.cards) throw new ConfigError(`Scenario ${name}: actions.use_card and give_card need rules.cards`);

  const { spawn } = config;
  if (Array.isArray(spawn)) {
    for (const [x, y] of spawn) {
      const cell = cells[y]?.[x];
      if (!cell) throw new ConfigError(`Scenario ${config.scenario}: spawn (${x}, ${y}) is outside the map`);
      if (cell.blocksMovement) throw new ConfigError(`Scenario ${config.scenario}: spawn (${x}, ${y}) is on a blocking cell`);
    }
  } else if (spawn !== "random" && !grid.rows.some((row) => row.includes(spawn.zone))) {
    throw new ConfigError(`Scenario ${config.scenario}: spawn zone "${spawn.zone}" does not appear in the map`);
  }

  if (Object.keys(config.actions).length === 0) {
    throw new ConfigError(`Scenario ${config.scenario}: no standard actions enabled`);
  }

  renderPrompt(config); // fail early on unknown {{names}}
  const hooksPath = config.hooks ? resolve(dirname(path), config.hooks) : undefined;
  return { config, path, hooksPath, width: grid.width, height: grid.height, cells };
}

export async function loadScenario(path: string): Promise<LoadedScenario> {
  const absolute = resolve(path);
  const result = ScenarioSchema.safeParse(parse(await readFile(absolute, "utf8")));
  if (!result.success) throw new ConfigError(`Invalid scenario ${path}:\n${z.prettifyError(result.error)}`);
  return resolveScenario(result.data, absolute);
}
