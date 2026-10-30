/**
 * 2:1 isometric projection. World units are tiles; z is height in tiles.
 * +x runs right-and-down on screen, +y runs left-and-down, +z straight up.
 * The viewer looks from the +x+y side, so a thing with a larger x + y is nearer (drawn later).
 */
export const U = 28;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Pt {
  sx: number;
  sy: number;
}

export function iso(x: number, y: number, z = 0): Pt {
  return { sx: (x - y) * U, sy: ((x + y) * U) / 2 - z * U };
}

export function isoV(p: Vec3): Pt {
  return iso(p.x, p.y, p.z);
}

/** Inverse of `iso` for a known height: screen → world. */
export function unproject(sx: number, sy: number, z = 0): { x: number; y: number } {
  const a = sx / U; // x - y
  const b = (2 * (sy + z * U)) / U; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Painter's key: larger is nearer the viewer. */
export function depth(x: number, y: number): number {
  return x + y;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Partial<Vec3>): Vec3 => ({ x: a.x + (b.x ?? 0), y: a.y + (b.y ?? 0), z: a.z + (b.z ?? 0) });
export const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeIn = (t: number): number => t * t * t;
export const easeOutBounce = (t: number): number => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
/** Overshoots to ~1.1 then settles; the "click" of a part snapping home. */
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
