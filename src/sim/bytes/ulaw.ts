/**
 * G.711 µ-law (ITU-T G.711, the North American and Japanese telephone codec): one byte per 8 kHz sample, 64 kbit/s.
 * A byte is sign (1) · segment (3) · mantissa (4), all bits inverted on the wire so that silence is 0xFF rather than
 * 0x00. The segment is a floating-point style exponent: quiet sounds get fine steps, loud ones coarse. The 0x84 bias
 * centres each step, and 32635 is the loudest magnitude the code can hold. Same arithmetic as Sun's g711.c.
 */
export const ULAW_BIAS = 0x84;
export const ULAW_CLIP = 32635;

/** A 16-bit signed sample → its µ-law byte. */
export function ulawEncode(sample: number): number {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > ULAW_CLIP) s = ULAW_CLIP;
  s += ULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** A µ-law byte → the 16-bit signed sample it stands for (0xFF → 0, 0x80 → 32124, 0x00 → −32124). */
export function ulawDecode(byte: number): number {
  const u = ~byte & 0xff;
  const magnitude = (((u & 0x0f) << 3) + ULAW_BIAS) << ((u >> 4) & 0x07);
  return u & 0x80 ? ULAW_BIAS - magnitude : magnitude - ULAW_BIAS;
}

/** A whole clip of µ-law bytes → 16-bit samples, for playing or drawing. */
export function ulawDecodeAll(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ulawDecode(bytes[i] ?? 0xff);
  return out;
}
