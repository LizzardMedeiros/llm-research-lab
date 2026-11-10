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
      })
      .strict(),
    rules: z
      .object({
        perception: z.object({ mode: z.string().regex(RANGE).default("same_cell") }).strict().default({ mode: "same_cell" }),
        occupancy: z.object({ shared: z.boolean().default(true) }).strict().default({ shared: true }),
        end: z.object({ max_turns: z.number().int().positive() }).strict(),
      })
      .strict(),
    memory: MemorySchema.default({ window: 10, summary: "none" }),
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
      const { type, blocks_movement, ...attrs } = spec;
      return { symbol, type, blocksMovement: blocks_movement, attrs };
    }),
  );

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

  const hooksPath = config.hooks ? resolve(dirname(path), config.hooks) : undefined;
  return { config, path, hooksPath, width: grid.width, height: grid.height, cells };
}

export async function loadScenario(path: string): Promise<LoadedScenario> {
  const absolute = resolve(path);
  const result = ScenarioSchema.safeParse(parse(await readFile(absolute, "utf8")));
  if (!result.success) throw new ConfigError(`Invalid scenario ${path}:\n${z.prettifyError(result.error)}`);
  return resolveScenario(result.data, absolute);
}
