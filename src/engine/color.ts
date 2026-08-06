// srgb colour helpers matching osu-framework's color4extensions: plain
// per-channel multiplies, no linear-light conversion

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgba(r: number, g: number, b: number, a = 1): Rgba {
  return { r, g, b, a };
}

export function fromBytes([r, g, b, a]: [number, number, number, number]): Rgba {
  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

export function fromHex(hex: string, a = 1): Rgba {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255, a };
}

/** color4extensions.cs:113,120-129 -- darken multiplies by 1/(1+amount), clamps to 1, keeps alpha */
export function darken(c: Rgba, amount: number): Rgba {
  const s = 1 / (1 + amount);
  return { r: Math.min(1, c.r * s), g: Math.min(1, c.g * s), b: Math.min(1, c.b * s), a: c.a };
}

/** color4extensions.cs:50 -- opacity replaces alpha only, rgb untouched */
export function withAlpha(c: Rgba, a: number): Rgba {
  return { ...c, a };
}

export function toNumber(c: Rgba): number {
  return (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255);
}

export function toCss(c: Rgba): string {
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
}
