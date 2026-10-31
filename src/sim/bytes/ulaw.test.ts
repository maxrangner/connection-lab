import { describe, expect, it } from 'vitest';
import { VOICE_CLIP_CALLER_BASE64, VOICE_CLIP_FRIEND_BASE64, VOICE_CLIP_SAMPLES } from '../scenarios/voiceClip';
import { fromBase64 } from './bytes';
import { ULAW_BIAS, ulawDecode, ulawDecodeAll, ulawEncode } from './ulaw';

describe('G.711 µ-law', () => {
  it('decodes the known codes of the standard table', () => {
    // Silence is 0xFF; 0x7F is its "negative zero". The loudest codes are 0x80 and 0x00.
    expect(ulawDecode(0xff)).toBe(0);
    expect(ulawDecode(0x7f)).toBe(0);
    expect(ulawDecode(0xfe)).toBe(8);
    expect(ulawDecode(0x7e)).toBe(-8);
    expect(ulawDecode(0xf0)).toBe(120);
    expect(ulawDecode(0x70)).toBe(-120);
    expect(ulawDecode(0x80)).toBe(32124);
    expect(ulawDecode(0x00)).toBe(-32124);
  });

  it('encodes silence as 0xFF and clips the loudest samples', () => {
    expect(ulawEncode(0)).toBe(0xff);
    expect(ulawEncode(-1)).toBe(0x7f);
    expect(ulawEncode(32767)).toBe(0x80);
    expect(ulawEncode(-32768)).toBe(0x00);
  });

  it('round-trips every 16-bit sample within half a step of its segment', () => {
    for (let x = -32768; x < 32768; x += 7) {
      const err = Math.abs(ulawDecode(ulawEncode(x)) - x);
      const clipped = Math.abs(x) > 32635;
      if (!clipped) expect(err, `sample ${x}`).toBeLessThanOrEqual((Math.abs(x) + ULAW_BIAS) / 32);
    }
  });

  it('every code survives decode and encode, except negative zero', () => {
    for (let b = 0; b < 256; b++) expect(ulawEncode(ulawDecode(b)), `code ${b}`).toBe(b === 0x7f ? 0xff : b);
  });

  it('the two clips are one second of 8 kHz audio each, quiet first, then sound, then quiet', () => {
    for (const clip of [VOICE_CLIP_CALLER_BASE64, VOICE_CLIP_FRIEND_BASE64]) {
      const bytes = fromBase64(clip);
      expect(bytes.length).toBe(VOICE_CLIP_SAMPLES);
      expect(bytes.length).toBe(8000);
      const pcm = ulawDecodeAll(bytes);
      const rms = (from: number, to: number): number => Math.sqrt(pcm.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from));
      expect(rms(0, 300)).toBe(0);
      expect(rms(800, 1600)).toBeGreaterThan(2000);
      expect(rms(7600, 8000)).toBe(0);
      expect(Math.max(...pcm)).toBeLessThan(32000);
    }
  });
});
