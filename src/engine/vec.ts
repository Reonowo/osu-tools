// f32 helpers mirroring engine::math's .net float semantics

export const f32 = Math.fround;

/** f32 euclidean distance, matching osutk vector2.distance */
export function dist32(x0: number, y0: number, x1: number, y1: number): number {
  const dx = f32(x1 - x0);
  const dy = f32(y1 - y0);
  return f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
}
