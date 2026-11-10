import { describe, expect, it } from "vitest";
import { parseAsciiMap } from "../src/config/map.js";

describe("parseAsciiMap", () => {
  it("parses a rectangular map", () => {
    const grid = parseAsciiMap(".....\n.#...\n.....\n");
    expect(grid.width).toBe(5);
    expect(grid.height).toBe(3);
    expect(grid.rows[1]![1]).toBe("#");
  });

  it("rejects ragged rows", () => {
    expect(() => parseAsciiMap("...\n..")).toThrow(/row 1/);
  });
});
