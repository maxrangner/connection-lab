import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../../sim';
import { buildSchedule } from './schedule';

describe('buildSchedule', () => {
  const cases: { mss: number; loss: number; seed: number }[] = [];
  for (const mss of [1460, 536]) for (const loss of [0, 0.15, 0.3]) for (let seed = 1; seed <= 12; seed++) cases.push({ mss, loss, seed });

  it.each(cases)('is well-formed for mss=$mss loss=$loss seed=$seed', ({ mss, loss, seed }) => {
    const r = runScenario(fetchWebPage({ mss }), { seed, faults: { randomLoss: loss, manual: [] } });
    const s = buildSchedule(r);
    expect(Number.isFinite(s.duration)).toBe(true);
    // Every event has a finite, non-decreasing visual time.
    let prev = -Infinity;
    for (const e of r.events) {
      const v = s.eventV[e.seq]!;
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    for (const f of s.flights) {
      expect(f.v1).toBeGreaterThan(f.v0);
      expect(r.pdus.has(f.frameId)).toBe(true);
      if (f.lostAt !== undefined) expect(f.lostAt).toBeGreaterThan(f.v0);
    }
    for (const t of s.tracks) {
      expect(t.kfs.length).toBeGreaterThan(0);
      for (const k of t.kfs) {
        expect(k.v1).toBeGreaterThanOrEqual(k.v0);
        expect(r.pdus.has(k.pduId)).toBe(true);
        if (k.fromPduId) expect(r.pdus.has(k.fromPduId)).toBe(true);
      }
      expect(t.end).toBeGreaterThanOrEqual(t.kfs[0]!.v0);
    }
    for (let i = 1; i < s.beats.length; i++) expect(s.beats[i]!.v).toBeGreaterThanOrEqual(s.beats[i - 1]!.v);
    expect(s.beats.every((b) => b.caption.length > 0 && !b.caption.includes('undefined'))).toBe(true);
    expect(s.badges.every((b) => !b.text.includes('undefined'))).toBe(true);
  });

  it('maps visual time back to simulated time monotonically', () => {
    const r = runScenario(fetchWebPage(), { seed: 1 });
    const s = buildSchedule(r);
    let last = -1;
    for (let v = 0; v <= s.duration; v += s.duration / 500) {
      const t = s.simTimeAt(v);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  it('keeps the visual timeline identical before a manual fault', () => {
    const base = buildSchedule(runScenario(fetchWebPage(), { seed: 3 }));
    const target = base.flights.find((f) => base.result.packets.get(f.packetId)?.label.startsWith('HTTP 200') && f.linkId === 'wan')!;
    const lost = buildSchedule(
      runScenario(fetchWebPage(), { seed: 3, faults: { randomLoss: 0, manual: [{ packetId: target.packetId, linkId: 'wan' }] } }),
    );
    const again = lost.flights.find((f) => f.packetId === target.packetId && f.linkId === 'wan')!;
    expect(again.v0).toBeCloseTo(target.v0, 9);
    expect(again.lostAt).toBeDefined();
  });
});
