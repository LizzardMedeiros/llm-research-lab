/**
 * Video cast: each agent gets a character for presentation only (videos).
 * Names are the model family ("Claude", "Qwen 1", "Qwen 2") when models are
 * mixed, and the characters' short fictional names ("Anna", "John") when every
 * agent runs the same model. The agent id always stays visible next to the name, because verbatim
 * dialogue refers to agents by id. Portraits are parameters for a generated
 * illustrated face; the video draws them. Nothing here changes the run.
 */

export interface PortraitParams {
  face: number; // 0..2 round, oval, square
  skin: number; // 0..5 lightest → darkest
  hair: number; // 0..7 short, long, bun, buzz, curly, bald, afro, long curly
  hairColor: number; // 0..5 black, dark brown, light brown, blonde, gray, red
  accessory: number; // 0..3 none, glasses, headband, earring
  eyes?: number; // 0 round (default), 1 almond
  freckles?: boolean;
}

/** How the character is presented (voice and portrait agree). Presentation only. */
export type Presentation = "feminine" | "masculine";

/** One of the fixed, recurring video characters. */
export interface Character {
  key: string;
  /** Short fictional name, used when every agent runs the same model. */
  name: string;
  presentation: Presentation;
  /** Plain description, for docs and review only. */
  look: string;
  voice: string;
  portrait: PortraitParams;
}

export interface CastMember {
  id: string;
  name: string;
  /** Roster key of the character drawn for this agent. */
  character: string;
  presentation: Presentation;
  /** Model family or policy name the name is built from. */
  family: string;
  decider: string;
  role?: string;
  voice: string;
  portrait: PortraitParams;
}

export type CastOverrides = Record<string, Partial<Pick<CastMember, "name" | "voice" | "character">> & { portrait?: Partial<PortraitParams> }>;

/**
 * Fixed roster: five women and five men, each group with one white, one
 * Asian, one Black, one brown (pardo) and one red-haired character, each with
 * its own Kokoro voice (bm_george is the narrator's). Agents draw characters
 * in agent order, alternating woman/man; the order below makes the first five
 * agents cover all five looks.
 */
export const ROSTER: Character[] = [
  { key: "f1", name: "Anna", presentation: "feminine", look: "Black woman", voice: "af_heart", portrait: { face: 1, skin: 5, hair: 6, hairColor: 0, accessory: 3 } },
  { key: "m1", name: "John", presentation: "masculine", look: "Asian man", voice: "am_michael", portrait: { face: 1, skin: 1, hair: 0, hairColor: 0, accessory: 0, eyes: 1 } },
  { key: "f2", name: "Maya", presentation: "feminine", look: "white woman", voice: "bf_emma", portrait: { face: 1, skin: 0, hair: 2, hairColor: 3, accessory: 1 } },
  { key: "m2", name: "Fred", presentation: "masculine", look: "brown (pardo) man", voice: "am_fenrir", portrait: { face: 2, skin: 3, hair: 4, hairColor: 1, accessory: 0 } },
  { key: "f3", name: "Lena", presentation: "feminine", look: "red-haired woman", voice: "af_bella", portrait: { face: 0, skin: 0, hair: 1, hairColor: 5, accessory: 0, freckles: true } },
  { key: "m3", name: "Omar", presentation: "masculine", look: "Black man", voice: "am_puck", portrait: { face: 0, skin: 4, hair: 3, hairColor: 0, accessory: 1 } },
  { key: "f4", name: "Zoe", presentation: "feminine", look: "Asian woman", voice: "af_kore", portrait: { face: 0, skin: 1, hair: 1, hairColor: 0, accessory: 2, eyes: 1 } },
  { key: "m4", name: "Leo", presentation: "masculine", look: "red-haired man", voice: "bm_fable", portrait: { face: 1, skin: 0, hair: 0, hairColor: 5, accessory: 0, freckles: true } },
  { key: "f5", name: "Iris", presentation: "feminine", look: "brown (pardo) woman", voice: "af_sarah", portrait: { face: 2, skin: 3, hair: 7, hairColor: 1, accessory: 3 } },
  { key: "m5", name: "Kai", presentation: "masculine", look: "white man", voice: "am_onyx", portrait: { face: 2, skin: 1, hair: 5, hairColor: 2, accessory: 1 } },
];

/** Known model families, matched in order against the model name. */
const FAMILIES: Array<[RegExp, string]> = [
  [/bonsai/i, "Bonsai"],
  [/claude|opus|sonnet|haiku|fable|mythos/i, "Claude"],
  [/gemini/i, "Gemini"],
  [/gpt|o\d-|openai/i, "GPT"],
  [/qwen/i, "Qwen"],
  [/llama/i, "Llama"],
  [/gemma/i, "Gemma"],
  [/phi/i, "Phi"],
  [/mistral|mixtral/i, "Mistral"],
  [/deepseek/i, "DeepSeek"],
];

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "bonsai/ternary-bonsai-2-27b" → "Bonsai"; "policy:../policies/talker.ts" → "Talker". */
export function familyOf(decider: string): string {
  if (decider.startsWith("policy:")) {
    const ref = decider.slice("policy:".length);
    const base = ref.split("/").pop()!.replace(/\.[jt]s$/, "");
    return capitalize(base.replace(/[^A-Za-z0-9]+/g, " ").trim()) || "Policy";
  }
  const model = decider.includes("/") ? decider.slice(decider.indexOf("/") + 1) : decider;
  for (const [pattern, name] of FAMILIES) if (pattern.test(model)) return name;
  return capitalize(model.split(/[^A-Za-z]+/).find(Boolean) ?? "Agent");
}

export function buildCast(agents: Array<{ id: string; decider: string; role?: string }>, overrides: CastOverrides = {}): CastMember[] {
  const families = agents.map((a) => familyOf(a.decider));
  const totals = new Map<string, number>();
  for (const f of families) totals.set(f, (totals.get(f) ?? 0) + 1);
  const seen = new Map<string, number>();
  const sameModel = agents.length > 1 && new Set(agents.map((a) => a.decider)).size === 1;
  // Characters picked explicitly in overrides are not drawn for other agents.
  const claimed = new Set(agents.map((a) => overrides[a.id]?.character).filter(Boolean));
  const taken = new Set<string>();
  const draw = (presentation: Presentation): Character => {
    const pool = ROSTER.filter((c) => c.presentation === presentation);
    const free = pool.find((c) => !claimed.has(c.key) && !taken.has(c.key));
    // More agents than characters: reuse in order (rare; the id badge still tells them apart).
    return free ?? pool[taken.size % pool.length]!;
  };
  return agents.map((a, i) => {
    const family = families[i]!;
    const n = (seen.get(family) ?? 0) + 1;
    seen.set(family, n);
    const o = overrides[a.id] ?? {};
    const picked = o.character ? ROSTER.find((c) => c.key === o.character) : undefined;
    if (o.character && !picked) throw new Error(`unknown character "${o.character}" (roster: ${ROSTER.map((c) => c.key).join(", ")})`);
    const character = picked ?? draw(i % 2 === 0 ? "feminine" : "masculine");
    taken.add(character.key);
    // Every agent on one model: "Bonsai 1..5" is repetitive, so use the characters' short
    // fictional names. Mixed models: the model family is the useful name.
    const name = sameModel ? character.name : totals.get(family)! > 1 ? `${family} ${n}` : family;
    return {
      id: a.id,
      name: o.name ?? name,
      character: character.key,
      presentation: character.presentation,
      family,
      decider: a.decider,
      ...(a.role ? { role: a.role } : {}),
      voice: o.voice ?? character.voice,
      portrait: { ...character.portrait, ...o.portrait },
    };
  });
}
