import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type Job } from '../sim';
import { buildStory, type Story, type Trip } from './story';
import { buildTimeline, crossings, joinAt, type Timeline } from './timeline';
import { buildSpeech } from './speech';

const JOBS: Job[] = ['page', 'photo', 'call', 'ping', 'trace'];
const CLEAN = { randomLoss: 0, manual: [] };
const OPTIONS = { page: {}, photo: { site: 'httpbin.org' }, call: { call: true }, ping: { probe: 'ping' }, trace: { probe: 'traceroute' } } as const;
const story = (a: Job, extra: object = {}): Story => buildStory(runScenario(fetchWebPage({ ...OPTIONS[a], ...extra }), { seed: 1, faults: CLEAN, maxTime: 1000 }));
const everyPacket = (t: Trip): Trip[] => (t.steps.some((s) => s.kind === 'flow') ? t.steps.flatMap((s) => (s.kind === 'flow' ? s.packets.flatMap(everyPacket) : [])) : [t]);

/** A run with a card dropped in at this share of the way through. */
function dropped(a: Job, b: Job, share: number): { before: Timeline; after: Timeline; s: Story; v: number } {
  const before = buildTimeline(story(a));
  const v = before.total * share;
  const s = story(a, { join: { job: b, at: joinAt(before, v) } });
  return { before, after: buildTimeline(s, new Map(), 0, v), s, v };
}

describe('a card dropped in during a run', () => {
  for (const a of JOBS) {
    for (const b of JOBS) {
      for (const share of [0.02, 0.2, 0.5, 0.8]) {
        it(`${b} into ${a} ${share * 100}% of the way: what was shown stays and no packet goes missing`, () => {
          const { before, after, s, v } = dropped(a, b, share);
          // Everything that had started by then is as it was.
          const shown = (tl: Timeline): string[] =>
            crossings(tl)
              .filter((c) => c.t0 <= v)
              .map((c) => `${c.trip.packetId}@${c.link} ${c.t0.toFixed(6)} ${c.t1.toFixed(6)}`);
          expect(shown(after)).toEqual(shown(before));
          // Every frame on a cable is drawn once.
          const onCables = s.trips.flatMap(everyPacket).flatMap((t) => t.steps.flatMap((x) => (x.kind === 'travel' || x.kind === 'lost' ? [`${t.packetId}@${x.link} ${x.at}`] : [])));
          expect(crossings(after).map((c) => `${c.trip.packetId}@${c.link} ${c.at}`).sort()).toEqual(onCables.sort());
          expect(after.total).toBeGreaterThan(v);
          expect(after.segs.every((x) => x.t1 >= x.t0)).toBe(true);
        });
      }
    }
  }

  it('runs the two jobs side by side, not one after the other', () => {
    const { after, s } = dropped('page', 'page', 0.1);
    const traffic = after.segs.find((x) => x.trip.chapter === 'traffic')!;
    const blocks = traffic.flow!;
    const spans = s.clients.map((c) => blocks.filter((p) => p.trip.client === c));
    expect(spans.every((x) => x.length > 0)).toBe(true);
    const [one, other] = spans.map((x) => [Math.min(...x.map((p) => p.t0)), Math.max(...x.map((p) => p.t1))] as const);
    expect(Math.max(one![0], other![0])).toBeLessThan(Math.min(one![1], other![1]));
  });

  it('the page that joined shows up on its device, with a reaction', () => {
    const { after } = dropped('ping', 'page', 0.2);
    expect(after.pages.has('phone')).toBe(true);
    expect(after.reactions.some((r) => r.device === 'phone' && r.face === 'love' && r.t === after.pages.get('phone'))).toBe(true);
  });

  it('says what the packets of both jobs do, each in its own voice', () => {
    const { after, s } = dropped('page', 'photo', 0.1);
    const said = buildSpeech(s, after.segs).filter((b) => b.device === 'phone').map((b) => b.text);
    expect(said).toContain('Please send the photo');
    expect(said).toContain('Hi, can we talk?');
  });

  it('a ping or trace dropped in prints its own results, on its own terminal', () => {
    const ping = dropped('page', 'ping', 0.2).after.joinReadout.screens.at(-1)!.lines;
    expect(ping).toContain('4 sent, 4 received, 12 ms');
    const both = dropped('ping', 'trace', 0.2).after;
    expect(both.readout.screens.at(-1)!.lines[0]).toBe('ping example.com');
    expect(both.joinReadout.screens.at(-1)!.lines[0]).toBe('traceroute example.com');
    expect(both.joinReadout.screens.at(-1)!.lines.at(-1)).toBe('reached in 3 hops');
  });

  it('does not touch a run nobody dropped anything into', () => {
    for (const a of JOBS) expect(buildTimeline(story(a)).segs.some((x) => x.trip.chapter === 'traffic')).toBe(false);
  });
});
