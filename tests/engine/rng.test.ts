import { describe, expect, it } from "vitest";
import { createRng } from "../../src/engine/rng.js";

describe("createRng", () => {
  it("is deterministic for a seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });

  it("forks independent, reproducible streams", () => {
    const x1 = createRng(42).fork("agent:a1").int(1_000_000);
    const x2 = createRng(42).fork("agent:a1").int(1_000_000);
    const y = createRng(42).fork("agent:a2").int(1_000_000);
    expect(x1).toBe(x2);
    expect(x1).not.toBe(y);
  });

  it("forks do not depend on how much the parent was consumed", () => {
    const parent = createRng(7);
    parent.next();
    parent.next();
    expect(parent.fork("env").next()).toBe(createRng(7).fork("env").next());
  });

  it("int, pick and shuffle stay in range", () => {
    const rng = createRng(1);
    for (let i = 0; i < 100; i++) expect(rng.int(3)).toBeLessThan(3);
    expect(["a", "b"]).toContain(rng.pick(["a", "b"]));
    expect(rng.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});
