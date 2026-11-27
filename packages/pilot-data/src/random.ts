/** Small seeded generator (mulberry32). Deterministic across platforms; never `Math.random`. */
export interface Random {
  /** Uniform in [0, 1). */
  next(): number;
  pick<T>(list: readonly T[]): T;
}

export function seeded(seed: number): Random {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('seed must be an integer from 0 to 4294967295');
  }
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick<T>(list: readonly T[]): T {
      const item = list[Math.floor(next() * list.length)];
      if (item === undefined) throw new RangeError('cannot pick from an empty list');
      return item;
    },
  };
}
