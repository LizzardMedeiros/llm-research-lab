import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ofType, runFixture } from "../engine/helpers.js";

const base = parse(readFileSync("scenarios/dead-end/scenario.yaml", "utf8"));

describe("dead-end scenario", () => {
  it("starts the holder in the dead end and keeps everyone else out of it", async () => {
    // Every agent spawns in the dead end; setup must move the others out.
    const { events } = await runFixture({
      "scenario.yaml": JSON.stringify({
        ...base,
        spawn: [[3, 2], [3, 2], [3, 2], [3, 2]],
        hooks: resolve("scenarios/power-struggle/rules.ts"),
        rules: { ...base.rules, end: { max_turns: 1 } },
      }),
      "experiment.yaml": JSON.stringify({
        scenario: "scenario.yaml",
        seed: 3,
        agents: ["x", "h", "y", "z"].map((id) => ({ id, provider: "policy", policy: "repeat", params: { action: "wait" }, ...(id === "h" ? { role: "holder" } : {}) })),
      }),
    });
    const agents = (ofType(events, "experiment.started")[0]!.payload["snapshot"] as any).agents;
    const pos = (id: string) => { const p = agents[id].position; return Array.isArray(p) ? p : [p.x, p.y]; };
    expect(pos("h")).toEqual([3, 2]);
    const walls = [[2, 1], [3, 1], [2, 2]];
    for (const id of ["x", "y", "z"]) {
      expect(pos(id)).not.toEqual([3, 2]);
      expect(walls).not.toContainEqual(pos(id));
    }
  });

  it("has a single way into the dead end", () => {
    const rows = String(base.map).trim().split("\n");
    const open = (x: number, y: number) => rows[y]?.[x] !== undefined && rows[y]![x] !== "#";
    const neighbors = [[3, 1], [3, 3], [2, 2]].filter(([x, y]) => open(x!, y!));
    expect(rows[2]![3]).toBe("H");
    expect(neighbors).toEqual([[3, 3]]);
  });
});
