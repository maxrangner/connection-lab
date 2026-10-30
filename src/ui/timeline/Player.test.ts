import { describe, expect, it } from 'vitest';
import { Player } from './Player';

/** Drives the player with a fake clock, 16 ms per frame. */
function make(): { p: Player; frames: (n: number) => void } {
  const p = new Player(() => {}, false);
  let t = 1000;
  return {
    p,
    frames: (n: number) => {
      for (let i = 0; i < n; i++) {
        t += 16;
        p.tick(t);
      }
    },
  };
}

describe('Player gates', () => {
  it('stops exactly at a gate and resumes on release', () => {
    const { p, frames } = make();
    p.duration = 10;
    p.gates = [1.0, 2.5];
    const seen: number[] = [];
    p.onGate((v) => seen.push(v));
    p.setPlaying(true);
    frames(200); // 3.2 s of playback
    expect(p.v).toBeCloseTo(1.0, 9);
    expect(p.playing).toBe(false);
    expect(p.blockedAt).toBe(1.0);
    expect(seen).toEqual([1.0]);
    p.release();
    expect(p.playing).toBe(true);
    frames(200);
    expect(p.v).toBeCloseTo(2.5, 9);
    expect(seen).toEqual([1.0, 2.5]);
  });

  it('seeking past a gate does not block, and play after a seek crosses later gates normally', () => {
    const { p, frames } = make();
    p.duration = 10;
    p.gates = [1.0, 5.0];
    p.seek(3);
    expect(p.blockedAt).toBeUndefined();
    p.setPlaying(true);
    frames(60);
    expect(p.v).toBeGreaterThan(3.5);
    expect(p.blockedAt).toBeUndefined();
    frames(200);
    expect(p.v).toBeCloseTo(5.0, 9);
  });

  it('playTo (stepping) obeys gates on the way', () => {
    const { p, frames } = make();
    p.duration = 10;
    p.gates = [0.5];
    p.playTo(2);
    frames(100);
    expect(p.v).toBeCloseTo(0.5, 9);
    p.release();
    frames(200);
    expect(p.v).toBeCloseTo(2, 2);
    expect(p.playing).toBe(false);
  });

  it('still stops when a frame lands a hair below the gate', () => {
    const p = new Player(() => {}, false);
    p.duration = 10;
    p.gates = [6.500000000000001];
    p.seek(6.3);
    p.setPlaying(true);
    // Frames of exactly 50 ms at 1x: 6.3 → 6.35 → … → 6.5 (floating point lands just below the gate).
    let t = 1000;
    p.tick(t);
    for (let i = 0; i < 4; i++) p.tick((t += 50));
    expect(p.v).toBeLessThan(6.500000000000001);
    expect(p.blockedAt).toBeUndefined();
    p.tick(t + 50);
    expect(p.blockedAt).toBe(6.500000000000001);
    expect(p.v).toBe(6.500000000000001);
  });

  it('pressing play while blocked releases the gate', () => {
    const { p, frames } = make();
    p.duration = 10;
    p.gates = [0.3];
    p.setPlaying(true);
    frames(40);
    expect(p.blockedAt).toBe(0.3);
    p.setPlaying(true);
    expect(p.blockedAt).toBeUndefined();
    frames(20);
    expect(p.v).toBeGreaterThan(0.3);
  });
});
