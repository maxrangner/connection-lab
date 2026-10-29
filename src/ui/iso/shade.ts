/** Color helpers: one base color per layer → three face shades. */

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

const cache = new Map<string, string>();

/** Returns the color with its lightness multiplied by `k` (clamped), as an hsl() string. */
export function shade(hex: string, k: number): string {
  const key = `${hex}|${k}`;
  let out = cache.get(key);
  if (!out) {
    const [h, s, l] = rgbToHsl(...hexToRgb(hex));
    out = `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(Math.min(1, l * k) * 100).toFixed(1)}%)`;
    cache.set(key, out);
  }
  return out;
}

export const FACE: { top: number; left: number; right: number } = { top: 1.0, left: 0.8, right: 0.62 };
