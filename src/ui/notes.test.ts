import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, ulawEncode, type FaultPlan } from '../sim';
import { toneOf } from './notes';
import { buildStory, type Trip } from './story';
import { buildTimeline, type Note } from './timeline';

const sine = (hz: number, amp: number): Uint8Array => Uint8Array.from({ length: 160 }, (_, i) => ulawEncode(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 8000))));
const run = (faults: Partial<FaultPlan> = {}) => {
  const story = buildStory(runScenario(fetchWebPage({ call: true }), { seed: 1, faults: { randomLoss: 0, manual: [], ...faults }, maxTime: 1000 }));
  return { story, tl: buildTimeline(story) };
};
const packets = (trips: Trip[]): Trip[] => trips.flatMap((t) => t.steps.flatMap((s) => (s.kind === 'flow' && s.packets.length > 1 ? s.packets : [])));

describe('the tone of a voice packet', () => {
  it('finds the real pitch, and a higher one sits higher', () => {
    const low = toneOf(sine(200, 8000))!;
    const high = toneOf(sine(600, 8000))!;
    expect(low.hz).toBeGreaterThan(190);
    expect(low.hz).toBeLessThan(212);
    expect(high.hz).toBeGreaterThan(570);
    expect(high.hz).toBeLessThan(630);
    expect(high.pitch).toBeGreaterThan(low.pitch);
  });

  it('a louder packet is a bigger note, and a pause is no note', () => {
    expect(toneOf(sine(300, 12000))!.loud).toBeGreaterThan(toneOf(sine(300, 2000))!.loud);
    expect(toneOf(sine(300, 40))).toBeNull();
    expect(toneOf(new Uint8Array(160).fill(0xff))).toBeNull();
  });
});

describe('the notes of a call', () => {
  const clean = run();
  const flow = packets(clean.story.trips);
  const phones = (n: Note[]): string[] => [...new Set(n.map((x) => x.device))].sort();

  it('a note rises from the phone that hears it, for every packet that is not a pause, and none breaks', () => {
    const audible = flow.filter((t) => toneOf(t.audio!)).length;
    expect(audible).toBeGreaterThan(20);
    expect(clean.tl.notes).toHaveLength(audible);
    expect(clean.tl.notes.some((n) => n.broken)).toBe(false);
    expect(phones(clean.tl.notes)).toEqual(['friend', 'laptop']);
    expect(clean.tl.notes.every((n) => (n.device === 'laptop') === (n.heardBy === 'caller'))).toBe(true);
    expect(new Set(clean.tl.notes.map((n) => n.pitch.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('a call has no faces and no sheet of parts landing', () => {
    expect(clean.tl.reactions.filter((r) => r.device === 'friend' || r.t > clean.tl.notes[0]!.t)).toEqual([]);
    expect(clean.tl.segs.flatMap((s) => s.flow ?? []).every((p) => p.landed === null)).toBe(true);
  });

  it('every note is gone before the run ends', () => {
    expect(Math.max(...clean.tl.notes.map((n) => n.t))).toBeLessThanOrEqual(clean.tl.total - 2.4);
  });

  it('the listener finds a loss when the next packet comes: one note breaks then, at that phone, with a sound', () => {
    const third = flow.find((t) => t.origin === 'friend' && t.part?.n === 3)!;
    const fourth = flow.find((t) => t.origin === 'friend' && t.part?.n === 4)!;
    const x = run({ manual: [{ packetId: third.packetId, linkId: 'bb6' }] });
    const broken = x.tl.notes.filter((n) => n.broken);
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ device: 'laptop', heardBy: 'caller' });
    const flowed = x.tl.segs.flatMap((s) => s.flow ?? []);
    const next = flowed.find((p) => p.trip.packetId === fourth.packetId)!;
    expect(broken[0]!.t).toBeCloseTo(next.hops.at(-1)!.t1, 6);
    expect(x.tl.cues.filter((c) => c.sound === 'break')).toHaveLength(1);
    expect(x.tl.reactions.filter((r) => r.t > x.tl.notes[0]!.t)).toEqual([]);
    expect(x.story.trips.flatMap((t) => (t.steps[0]?.kind === 'flow' ? t.steps[0].packets : [])).some((t) => t.retry)).toBe(false);
  });

  it('a long gap breaks two notes and is then just silence', () => {
    const x = run({ cuts: [{ link: 'bb6', from: 0.1, to: 0.5 }] });
    const each = (d: string) => x.tl.notes.filter((n) => n.broken && n.device === d).length;
    expect(each('laptop')).toBe(2);
    expect(each('friend')).toBe(2);
    expect(x.tl.cues.filter((c) => c.sound === 'break')).toHaveLength(4);
  });
});
