import { ulawDecodeAll } from '../sim';

/** What one 20 ms voice packet sounds like, measured from its real samples. */
export interface Tone {
  hz: number;
  /** How high it sits, 0..1 over the range of a speaking voice. */
  pitch: number;
  /** How loud it is, 0..1. */
  loud: number;
}

const SAMPLE_RATE = 8000;
/** The pitches looked for. */
const LOW_HZ = 100;
const HIGH_HZ = 1000;
/** The range of a speaking voice, which a note's height spreads over. */
const VOICE_HIGH_HZ = 400;
/** Quieter than this (RMS of 16-bit samples) is a pause: no note. */
const SILENCE = 300;
/** RMS of the loudest note. */
const FULL = 12000;

/**
 * The pitch of some samples: the shortest lag at which they repeat themselves. A wave also repeats at twice its period,
 * so the shortest one that does nearly as well as the best is the pitch, not an octave below it.
 */
function pitchOf(s: Int16Array): number {
  const shortest = Math.floor(SAMPLE_RATE / HIGH_HZ);
  const longest = Math.min(Math.ceil(SAMPLE_RATE / LOW_HZ), Math.floor(s.length / 2));
  const scores: number[] = [];
  for (let lag = 0; lag <= longest; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < s.length; i++) sum += s[i]! * s[i + lag]!;
    scores.push(sum / (s.length - lag));
  }
  const best = Math.max(...scores.slice(shortest));
  // The first peak near the best: past the dip that follows lag 0.
  for (let lag = shortest; lag < longest; lag++) {
    if (scores[lag]! >= best * 0.9 && scores[lag]! >= scores[lag - 1]! && scores[lag]! >= scores[lag + 1]!) return SAMPLE_RATE / lag;
  }
  return SAMPLE_RATE / scores.lastIndexOf(best);
}

/** The tone of a packet's µ-law bytes, or null for a pause. */
export function toneOf(bytes: Uint8Array): Tone | null {
  const s = ulawDecodeAll(bytes);
  const rms = Math.sqrt(s.reduce((sum, x) => sum + x * x, 0) / (s.length || 1));
  if (rms < SILENCE) return null;
  const hz = pitchOf(s);
  return { hz, pitch: Math.min(1, Math.log(hz / LOW_HZ) / Math.log(VOICE_HIGH_HZ / LOW_HZ)), loud: Math.min(1, rms / FULL) };
}
