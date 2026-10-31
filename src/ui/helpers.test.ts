import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../sim';
import { stepRead } from './spyCard';
import { buildStory } from './story';
import { buildTimeline, chapterAt, crossings, frameAt, realAt, ridingOn, segAt, stepTarget, trayOpacity, wrapsBefore, type Seg } from './timeline';

const story = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
const tl = buildTimeline(story);
const wifi = buildTimeline(buildStory(runScenario(fetchWebPage({ from: 'phone' }), { seed: 1, faults: { randomLoss: 0, manual: [] } })));
const travelOn = (t: typeof tl, link: string): Seg => t.segs.find((s) => s.step.kind === 'travel' && s.step.link === link)!;

describe('the small pure helpers of the timeline', () => {
  it('names the chapter at any moment: none before the start, the last one after the end', () => {
    expect(chapterAt(tl, -1)).toBeNull();
    expect(chapterAt(tl, 0)).toBe('dns');
    expect(chapterAt(tl, tl.total + 100)).toBe('page');
    const hello = tl.segs.find((s) => s.trip.chapter === 'hello')!;
    expect(chapterAt(tl, hello.t0)).toBe('hello');
  });

  it('finds the segment under v with its progress, and nothing outside the run', () => {
    const second = tl.segs[1]!;
    const hit = segAt(tl, (second.t0 + second.t1) / 2)!;
    expect(hit.seg).toBe(second);
    expect(hit.k).toBeCloseTo(0.5);
    expect(segAt(tl, -0.1)).toBeNull();
    expect(segAt(tl, tl.total)).toBeNull();
  });

  it('knows which frame is around the packet: Wi-Fi from the phone, Ethernet past the home router', () => {
    expect(frameAt(travelOn(tl, 'lan'))?.l2).toBe('ethernet');
    expect(frameAt(travelOn(wifi, 'wlan'))).toMatchObject({ l2: 'wifi', head: 32 });
    expect(frameAt(travelOn(wifi, 'wan'))).toMatchObject({ l2: 'ethernet', head: 14, tail: 4 });
    // Unwrapping at the home router takes off the frame it arrived in.
    const unwrap = wifi.segs.find((s) => s.step.kind === 'unwrap' && s.step.layer === 'eth' && s.step.device === 'home')!;
    expect(frameAt(unwrap)?.l2).toBe('wifi');
  });

  it('steps one action at a time, and back goes to the one before when the start is near', () => {
    const t0 = tl.segs[0]!.t0;
    const t1 = tl.segs[1]!.t0;
    const t2 = tl.segs[2]!.t0;
    expect(stepTarget(tl, t0, 1)).toBe(t1);
    expect(stepTarget(tl, t1 + 0.05, -1, 0.2)).toBe(t0);
    expect(stepTarget(tl, t1 + 0.5, -1, 0.2)).toBe(t1);
    expect(stepTarget(tl, t2 - 0.1, 1)).toBe(t2);
    expect(stepTarget(tl, tl.total, 1)).toBe(tl.total);
    expect(stepTarget(tl, 0, -1)).toBe(0);
  });

  it('reads the real clock between its points, and zero when there are none', () => {
    expect(realAt({ real: [] }, 5)).toBe(0);
    expect(realAt({ real: [{ v: 2, sim: 0.1 }, { v: 4, sim: 0.3 }] }, 3)).toBeCloseTo(0.2);
    expect(realAt({ real: [{ v: 2, sim: 0.1 }] }, 9)).toBe(0.1);
    expect(realAt(tl, tl.total)).toBeGreaterThan(0.01);
  });

  it('tells what is on a line to catch: not what is still dropping in, not what is nearly across', () => {
    const seg = travelOn(tl, 'wan');
    const mid = ridingOn(tl, (seg.t0 + seg.t1) / 2, 'wan');
    expect(mid).toEqual([{ packetId: seg.trip.packetId, k: 0.5 }]);
    expect(ridingOn(tl, seg.t0 + (seg.t1 - seg.t0) * 0.02, 'wan')[0]?.k).toBe(0.12);
    expect(ridingOn(tl, seg.t0 + (seg.t1 - seg.t0) * 0.95, 'wan')).toEqual([]);
    expect(ridingOn(tl, (seg.t0 + seg.t1) / 2, 'lan')).toEqual([]);
  });

  it('lists the cable crossings once per timeline', () => {
    expect(crossings(tl)).toBe(crossings(tl));
    expect(crossings(tl).length).toBeGreaterThan(0);
  });

  it('knows which wraps are on before a step, and shows trays only while a device works', () => {
    const trip = story.trips.find((t) => t.card === 'GET /')!;
    const ipWrap = tl.segs.find((s) => s.trip === trip && s.step.kind === 'wrap' && s.step.layer === 'ip')!;
    expect([...wrapsBefore(ipWrap)]).toEqual(['l4']);
    const onWire = travelOn(tl, 'wan');
    expect(trayOpacity(tl, 'laptop', onWire.t0 + 0.5 * (onWire.t1 - onWire.t0))).toBe(0);
    expect(trayOpacity(tl, 'laptop', ipWrap.t0 + 0.5 * (ipWrap.t1 - ipWrap.t0))).toBe(1);
  });
});

describe('stepping through the spyglass reads', () => {
  it('goes back through older reads and returns to following the newest', () => {
    expect(stepRead(null, 5, -1)).toBe(3);
    expect(stepRead(3, 5, -1)).toBe(2);
    expect(stepRead(0, 5, -1)).toBe(0);
    expect(stepRead(2, 5, 1)).toBe(3);
    expect(stepRead(3, 5, 1)).toBeNull();
    expect(stepRead(null, 1, -1)).toBe(0);
  });
});
