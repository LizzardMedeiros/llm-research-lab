import { describe, expect, it } from "vitest";
import { buildCast, familyOf } from "../../src/story/cast.js";

describe("familyOf", () => {
  it("names models by family and policies by their name", () => {
    expect(familyOf("bonsai/ternary-bonsai-2-27b")).toBe("Bonsai");
    expect(familyOf("ollama/qwen3:4b-instruct")).toBe("Qwen");
    expect(familyOf("claude/claude-opus-5-5")).toBe("Claude");
    expect(familyOf("gemini/gemini-2.5-flash")).toBe("Gemini");
    expect(familyOf("ollama/llama3.2:3b")).toBe("Llama");
    expect(familyOf("policy:random")).toBe("Random");
    expect(familyOf("policy:../policies/talker.ts")).toBe("Talker");
    expect(familyOf("local/zeta-7b")).toBe("Zeta");
  });
});

describe("buildCast", () => {
  const agents = [
    { id: "q1", decider: "ollama/qwen3:4b-instruct" },
    { id: "q2", decider: "ollama/qwen3:4b-instruct" },
    { id: "p1", decider: "policy:random", role: "holder" },
    { id: "p2", decider: "policy:../policies/talker.ts" },
    { id: "p3", decider: "policy:random" },
  ];

  it("numbers agents of the same family, in agent order, and keeps ids and roles", () => {
    const cast = buildCast(agents);
    expect(cast.map((c) => [c.id, c.name])).toEqual([
      ["q1", "Qwen 1"],
      ["q2", "Qwen 2"],
      ["p1", "Random 1"],
      ["p2", "Talker"],
      ["p3", "Random 2"],
    ]);
    expect(cast[2]!.role).toBe("holder");
    expect(new Set(cast.map((c) => c.voice)).size).toBe(5);
  });

  it("keeps voice and face consistent with an alternating presentation", () => {
    const cast = buildCast([...agents, { id: "z", decider: "policy:random" }]);
    expect(cast.map((c) => c.presentation)).toEqual(["feminine", "masculine", "feminine", "masculine", "feminine", "masculine"]);
    for (const c of cast) {
      expect(c.voice).toMatch(c.presentation === "feminine" ? /^[ab]f_/ : /^[ab]m_/);
      if (c.presentation === "masculine") {
        expect([1, 2]).not.toContain(c.portrait.hair); // no long hair or bun
        expect([2, 3]).not.toContain(c.portrait.accessory); // no headband or earrings
      }
    }
    expect(cast.every((c) => c.voice !== "bm_george")).toBe(true); // reserved for the narrator
    const masculineHair = cast.filter((c) => c.presentation === "masculine").map((c) => c.portrait.hair);
    expect(new Set(masculineHair).size).toBe(masculineHair.length); // no repeated hair style
    const flipped = buildCast(agents, { q1: { presentation: "masculine" } });
    expect(flipped[0]).toMatchObject({ presentation: "masculine", voice: expect.stringMatching(/^am_/) });
  });

  it("is deterministic and gives agents different faces", () => {
    expect(buildCast(agents)).toEqual(buildCast(agents));
    const faces = buildCast(agents).map((c) => JSON.stringify(c.portrait));
    expect(new Set(faces).size).toBe(5);
  });

  it("applies overrides", () => {
    const cast = buildCast(agents, { q1: { name: "Vega", voice: "bf_emma", portrait: { hair: 2 } } });
    expect(cast[0]).toMatchObject({ name: "Vega", voice: "bf_emma", portrait: { hair: 2 } });
    expect(cast[1]!.name).toBe("Qwen 2");
  });
});
