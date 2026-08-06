// raw .osr button bitfield (legacyreplayframe.cs); k1/k2 are the keyboard
// bits, m1/m2 the mouse bits, and stable sets m alongside k historically

export const M1 = 1;
export const M2 = 2;
export const K1 = 4;
export const K2 = 8;
export const SMOKE = 16;

/** legacyreplayframe.cs -- mouseleft is m1 or k1: one gameplay action */
export function isLeft(raw: number): boolean {
  return (raw & (M1 | K1)) !== 0;
}

export function isRight(raw: number): boolean {
  return (raw & (M2 | K2)) !== 0;
}

export function isSmoke(raw: number): boolean {
  return (raw & SMOKE) !== 0;
}
