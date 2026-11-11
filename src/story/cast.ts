/**
 * Video cast: each agent gets a character for presentation only (videos).
 * Names are tied to the model (e.g. five Bonsai agents → "Bonsai 1".."Bonsai 5")
 * and the agent id always stays visible next to the name, because verbatim
 * dialogue refers to agents by id. Portraits are parameters for a generated
 * illustrated face; the video draws them. Nothing here changes the run.
 */

export interface PortraitParams {
  face: number; // 0..2 round, oval, square
  skin: number; // 0..5
  hair: number; // 0..5 short, long, bun, buzz, curly, bald
  hairColor: number; // 0..5
  accessory: number; // 0..3 none, glasses, headband, earring
}

/** How the character is presented (voice and portrait agree). Presentation only. */
export type Presentation = "feminine" | "masculine";

export interface CastMember {
  id: string;
  name: string;
  presentation: Presentation;
  /** Model family or policy name the name is built from. */
  family: string;
  decider: string;
  role?: string;
  voice: string;
  portrait: PortraitParams;
}

export type CastOverrides = Record<string, Partial<Pick<CastMember, "name" | "voice" | "presentation">> & { portrait?: Partial<PortraitParams> }>;

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

/**
 * Kokoro English voices by presentation (af_/bf_ feminine, am_/bm_ masculine).
 * bm_george is the narrator, so only two masculine voices remain for characters.
 */
export const VOICES: Record<Presentation, string[]> = {
  feminine: ["af_nova", "bf_emma", "af_sky", "bf_isabella", "af_heart"],
  masculine: ["am_adam", "am_michael"],
};

/** Hair styles and accessories that read clearly for each presentation. */
const HAIR_STYLES: Record<Presentation, number[]> = { feminine: [1, 2, 4], masculine: [0, 3, 5, 4] }; // 0 short, 1 long, 2 bun, 3 buzz, 4 curly, 5 bald
const ACCESSORIES: Record<Presentation, number[]> = { feminine: [0, 1, 2, 3], masculine: [0, 1, 0, 1] }; // 0 none, 1 glasses, 2 headband, 3 earring

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

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Deterministic, varied portrait parameters, consistent with the presentation.
 * `slot` is the character's position among its presentation (plus a per-cast
 * offset), so characters of the same presentation get different hair styles.
 */
function portraitFor(id: string, decider: string, presentation: Presentation, slot: number): PortraitParams {
  const h = hash(`${id}|${decider}`);
  const hairs = HAIR_STYLES[presentation];
  const accessories = ACCESSORIES[presentation];
  return {
    face: (h >>> 0) % 3,
    skin: (h >>> 3) % 6,
    hair: hairs[slot % hairs.length]!,
    hairColor: (h >>> 11) % 6,
    accessory: accessories[(h >>> 15) % accessories.length]!,
  };
}

export function buildCast(agents: Array<{ id: string; decider: string; role?: string }>, overrides: CastOverrides = {}): CastMember[] {
  const families = agents.map((a) => familyOf(a.decider));
  const totals = new Map<string, number>();
  for (const f of families) totals.set(f, (totals.get(f) ?? 0) + 1);
  const seen = new Map<string, number>();
  const used: Record<Presentation, number> = { feminine: 0, masculine: 0 };
  const offset = hash(agents.map((a) => a.id).join("|"));
  return agents.map((a, i) => {
    const family = families[i]!;
    const n = (seen.get(family) ?? 0) + 1;
    seen.set(family, n);
    const o = overrides[a.id] ?? {};
    // Alternate presentations in agent order (balanced cast); voice and face follow it.
    const presentation: Presentation = o.presentation ?? (i % 2 === 0 ? "feminine" : "masculine");
    const pool = VOICES[presentation];
    const k = used[presentation]++;
    const voice = o.voice ?? pool[k % pool.length]!;
    return {
      id: a.id,
      name: o.name ?? (totals.get(family)! > 1 ? `${family} ${n}` : family),
      presentation,
      family,
      decider: a.decider,
      ...(a.role ? { role: a.role } : {}),
      voice,
      portrait: { ...portraitFor(a.id, a.decider, presentation, k + offset), ...o.portrait },
    };
  });
}
