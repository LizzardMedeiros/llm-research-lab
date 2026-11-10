/**
 * Seeded PRNG (mulberry32). All experiment randomness — environment and
 * policies — must come from here, never from Math.random().
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Independent stream derived from this seed and a label. */
  fork(label: string): Rng;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (maxExclusive) => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`int(${maxExclusive}): expected a positive integer`);
      return Math.floor(next() * maxExclusive);
    },
    pick: (items) => {
      if (items.length === 0) throw new Error("pick() on empty list");
      return items[rng.int(items.length)]!;
    },
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    fork: (label) => createRng(fnv1a(`${seed}:${label}`)),
  };
  return rng;
}
