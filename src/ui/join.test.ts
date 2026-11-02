import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type Cut, type Job, type ManualFault } from '../sim';
import { buildStory, type Story, type Trip } from './story';
import { buildTimeline, crossings, joinAt, pageParts, seenSoFar, type Timeline } from './timeline';
import { buildSpeech } from './speech';

const JOBS: Job[] = ['page', 'photo', 'call', 'ping', 'trace'];
const CLEAN = { randomLoss: 0, manual: [] };
const OPTIONS = { page: {}, photo: { site: 'httpbin.org' }, call: { call: true }, ping: { probe: 'ping' }, trace: { probe: 'traceroute' } } as const;
const story = (a: Job, extra: object = {}, faults: object = CLEAN): Story => buildStory(runScenario(fetchWebPage({ ...OPTIONS[a], ...extra }), { seed: 1, faults: { ...CLEAN, ...faults }, maxTime: 1000 }));
const everyPacket = (t: Trip): Trip[] => (t.steps.some((s) => s.kind === 'flow') ? t.steps.flatMap((s) => (s.kind === 'flow' ? s.packets.flatMap(everyPacket) : [])) : [t]);

/** A run with a card dropped in at this share of the way through. */
function dropped(a: Job, b: Job, share: number, setup: object = {}): { before: Timeline; after: Timeline; s: Story; v: number; join: { job: Job; at: number } } {
  const before = buildTimeline(story(a, setup));
  const v = before.total * share;
  const join = { job: b, at: joinAt(before, v) };
  const s = story(a, { ...setup, joins: [join] });
  return { before, after: buildTimeline(s, new Map(), 0, new Map([[s.joiners[0]!, v]])), s, v, join };
}

const shownBy = (tl: Timeline, v: number): string[] =>
  crossings(tl)
    .filter((c) => c.t0 <= v)
    .map((c) => `${c.trip.packetId}@${c.link} ${c.t0.toFixed(6)} ${c.t1.toFixed(6)}`);

describe('a card dropped in during a run', () => {
  for (const a of JOBS) {
    for (const b of JOBS) {
      for (const share of [0.02, 0.2, 0.5, 0.8]) {
        it(`${b} into ${a} ${share * 100}% of the way: what was shown stays and no packet goes missing`, () => {
          const { before, after, s, v } = dropped(a, b, share);
          // Everything that had started by then is as it was.
          expect(shownBy(after, v)).toEqual(shownBy(before, v));
          // Every frame on a cable is drawn once.
          const onCables = s.trips.flatMap(everyPacket).flatMap((t) => t.steps.flatMap((x) => (x.kind === 'travel' || x.kind === 'lost' ? [`${t.packetId}@${x.link} ${x.at}`] : [])));
          expect(crossings(after).map((c) => `${c.trip.packetId}@${c.link} ${c.at}`).sort()).toEqual(onCables.sort());
          expect(after.total).toBeGreaterThan(v);
          expect(after.segs.every((x) => x.t1 >= x.t0)).toBe(true);
        });
      }
    }
  }

  it('whatever the moment and the setup, nothing shown changes and every packet is in the right hands', () => {
    const setups = [{}, { https: true }, { cold: true }, { thin: true }, { noise: 0.3 }, { dhcp: true }];
    for (const setup of setups) {
      for (const a of JOBS) {
        for (const b of JOBS) {
          for (let share = 0.01; share < 1; share += 0.12) {
            const { before, after, s, v } = dropped(a, b, share, setup);
            const what = `${b} into ${a} at ${share} with ${JSON.stringify(setup)}`;
            expect(shownBy(after, v), what).toEqual(shownBy(before, v));
            for (const t of s.trips.flatMap(everyPacket).filter((x) => x.steps.some((y) => y.kind === 'travel'))) {
              const hops = t.steps.flatMap((x) => (x.kind === 'travel' ? [x] : []));
              const ends = [hops[0]!.from, hops.at(-1)!.to].filter((d) => s.clients.includes(d));
              expect(ends.every((d) => d === t.client), `${what}: ${t.card} from ${t.origin}`).toBe(true);
            }
          }
        }
      }
    }
  }, 120_000);

  it('blocks take turns on a cable, each way on its own, and each still crosses the cables in order', () => {
    for (const a of JOBS) {
      for (const b of JOBS) {
        const { after } = dropped(a, b, 0.1);
        const blocks = after.segs.find((x) => x.trip.chapter === 'traffic')?.flow ?? [];
        const ways = new Map<string, number[]>();
        for (const p of blocks) {
          for (const [i, h] of p.hops.entries()) {
            ways.set(`${h.link}|${h.from}`, [...(ways.get(`${h.link}|${h.from}`) ?? []), h.t0]);
            if (i) expect(h.t0).toBeGreaterThanOrEqual(p.hops[i - 1]!.t1);
          }
        }
        for (const [way, times] of ways) {
          const sorted = [...times].sort((x, y) => x - y);
          sorted.slice(1).forEach((t, i) => expect(t - sorted[i]!, `${b} into ${a} on ${way}`).toBeGreaterThan(0.25));
        }
      }
    }
  });

  it('a block that waits its turn is never overtaken by the same sender', () => {
    const { after } = dropped('photo', 'photo', 0.1);
    const blocks = after.segs.find((x) => x.trip.chapter === 'traffic')!.flow!;
    for (const client of ['laptop', 'phone']) {
      const server = blocks.filter((p) => p.trip.client === client && p.trip.origin === 'server').map((p) => p.t0);
      expect(server).toEqual([...server].sort((x, y) => x - y));
    }
  });

  it('a question never comes back answered before it set off', () => {
    const { after, s } = dropped('page', 'trace', 0.2);
    const blocks = after.segs.find((x) => x.trip.chapter === 'traffic')!.flow!.filter((p) => p.trip.client === 'phone');
    const first = blocks.find((p) => p.trip.probeTtl !== undefined)!;
    const answers = blocks.filter((p) => p.trip.chapter === 'trace' && p.trip.probeTtl === undefined);
    expect(answers.length).toBe(9);
    expect(Math.min(...answers.map((p) => p.t0))).toBeGreaterThanOrEqual(first.t1);
    expect(s.trips.flatMap(everyPacket).filter((t) => t.origin === 'home' || t.origin === 'isp').every((t) => t.client === 'phone')).toBe(true);
  });

  it('a dropped-in trace flags the hops it finds', () => {
    expect(dropped('page', 'trace', 0.2).after.joinReadouts[0]!.readout.flags.map((f) => f.device)).toEqual(['home', 'isp', 'server']);
  });

  it('a ping dropped into a ping at the last moment leaves the first as it was', () => {
    for (let share = 0.9; share < 1; share += 0.005) {
      const { before, after, v } = dropped('ping', 'ping', share);
      expect(shownBy(after, v)).toEqual(shownBy(before, v));
    }
  });

  it('a dropped-in call does not put its voice on the page sheet', () => {
    expect(pageParts(dropped('page', 'call', 0.2).after)).toBeNull();
    const photo = pageParts(dropped('photo', 'call', 0.2).after)!;
    expect(photo.complete).toBeLessThan(Infinity);
    expect(photo.of).toBe(25);
  });

  it('each device shows what it asked for', () => {
    const photoOnPhone = dropped('page', 'photo', 0.2).s.screens;
    expect(photoOnPhone.laptop!.pageTitle).toBe('Example Domain');
    expect(photoOnPhone.laptop!.image).toBeNull();
    expect(photoOnPhone.phone!.pageTitle).toBe('photo');
    expect(photoOnPhone.phone!.image).toMatch(/^data:image\/jpeg/);
    expect(photoOnPhone.phone!.site).toBe('httpbin.org');

    const pageOnPhone = dropped('photo', 'page', 0.2).s.screens;
    expect(pageOnPhone.laptop!.image).toMatch(/^data:image\/jpeg/);
    expect(pageOnPhone.phone!.pageTitle).toBe('Example Domain');
    expect(pageOnPhone.phone!.image).toBeNull();

    for (const first of ['ping', 'trace', 'call'] as const) {
      const screens = dropped(first, 'page', 0.2).s.screens;
      expect(screens.phone!.pageTitle).toBe('Example Domain');
      expect(screens.laptop!.browsing).toBe(false);
    }
    expect(dropped('page', 'call', 0.2).s.screens.phone).toMatchObject({ site: 'sam.example', browsing: false, pageTitle: null });
  });

  it("a device's address reaches its screen when the answer lands in the traffic", () => {
    const { after } = dropped('page', 'ping', 0.05);
    expect(after.answers.has('phone')).toBe(true);
  });

  it('a page in parts carries on from the parts already read', () => {
    const big = { site: 'info.cern.ch' };
    const whole = buildTimeline(story('page', big));
    const firstPart = whole.segs.find((x) => x.step.kind === 'read' && x.trip.part?.n === 1)!;
    const { after } = dropped('page', 'ping', (firstPart.t1 + 0.1) / whole.total, big);
    expect(after.reactions.filter((r) => r.device === 'laptop' && r.t > firstPart.t1).map((r) => r.face)).toEqual(['love']);
    expect(pageParts(after)!.complete).toBeLessThan(Infinity);
  });

  it("the first device's photo stays a photo whoever the server answers first", () => {
    for (const setup of [{ https: true }, { cold: true }]) {
      const s = story('photo', { ...setup, joins: [{ job: 'page', at: 0.002 }] });
      expect(s.image).toMatch(/^data:image\/jpeg/);
    }
  });

  it("the resolver's walk for the other device is no resend", () => {
    for (const at of [0.008, 0.015, 0.03]) {
      const s = story('page', { cold: true, joins: [{ job: 'page', at }] });
      expect(s.trips.flatMap(everyPacket).filter((t) => t.chapter === 'dns' && t.timedOut)).toEqual([]);
    }
  });

  it('teardown stays hidden when the other job sends more', () => {
    const acks = (s: Story): number => s.trips.flatMap(everyPacket).filter((t) => t.client === 'laptop' && t.l4Label === 'ACK').length;
    expect(acks(dropped('page', 'photo', 0.02).s)).toBe(acks(story('page')));
  });

  it('a cable cut during the traffic leaves what was on screen as it was', () => {
    for (const a of JOBS) {
      for (const b of JOBS) {
        for (const line of ['wan', 'bb2', 'bb6', 'lan', 'wlan']) {
          for (const share of [0.15, 0.4, 0.65, 0.9]) {
            const { after, join, v: dropV } = dropped(a, b, 0.1);
            const v = dropV + (after.total - dropV) * share;
            const seen = seenSoFar(after, v, line);
            const faults: { decided: Record<string, boolean>; cuts: Cut[]; manual: ManualFault[] } = { decided: seen.decided, cuts: [{ link: line, from: seen.now }], manual: [] };
            const cut = buildTimeline(story(a, { joins: [join] }, faults), new Map(), 0, new Map([['phone', dropV]]));
            // A packet that will never hear its reply may set off sooner, but nothing that was there goes or moves.
            expect(shownBy(cut, v), `${b} into ${a}, ${line} cut at ${share}`).toEqual(expect.arrayContaining(shownBy(after, v)));
          }
        }
      }
    }
  }, 120_000);

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
    expect(said).toContain('Got the address! Hi, can we talk?');
  });

  it('a ping or trace dropped in prints its own results, on its own terminal', () => {
    const ping = dropped('page', 'ping', 0.2).after.joinReadouts[0]!.readout.screens.at(-1)!.lines;
    expect(ping).toContain('4 sent, 4 replies, average 12 ms');
    const both = dropped('ping', 'trace', 0.2).after;
    expect(both.readout.screens.at(-1)!.lines[0]).toBe('ping example.com');
    expect(both.joinReadouts[0]!.readout.screens.at(-1)!.lines[0]).toBe('traceroute example.com');
    expect(both.joinReadouts[0]!.readout.screens.at(-1)!.lines.at(-1)).toBe('reached in 3 hops');
  });

  it('a device shows up the moment anything crosses to or from it, in the order a packet reaches them', () => {
    const tl = buildTimeline(story('page'));
    const order = [...tl.reveals].sort((a, b) => a[1].t0 - b[1].t0).map(([d]) => d);
    expect(order.indexOf('home')).toBeLessThan(order.indexOf('isp'));
    expect(order.indexOf('isp')).toBeLessThan(order.indexOf('server'));
    expect(tl.reveals.has('phone')).toBe(false);
    expect(tl.reveals.has('friend')).toBe(false);
    for (const a of JOBS) {
      for (const b of JOBS) {
        const { after, s } = dropped(a, b, 0.3);
        for (const seg of after.segs) {
          for (const h of (seg.flow ?? []).flatMap((p) => p.hops)) {
            // A dropped-in job sets off at once, so its cables can only start with it.
            for (const d of [h.from, h.to]) expect(after.reveals.get(d)!.t0).toBeLessThanOrEqual(h.t0 + 1.31);
            expect(after.laid.get(h.link)!.t0).toBeLessThanOrEqual(h.t0);
          }
        }
        expect([...after.reveals.keys()].every((d) => s.devices.some((x) => x.id === d))).toBe(true);
      }
    }
  });

  it('has each cable laid and the device at its end up before the first packet sets off over it', () => {
    const tl = buildTimeline(story('page'));
    const trips = tl.segs.flatMap((s) => (s.step.kind === 'travel' ? [{ s, step: s.step }] : []));
    for (const [link, at] of tl.laid) {
      const first = trips.find((x) => x.step.link === link)!;
      expect(at.from).toBe(first.step.from);
      expect(at.t1).toBeLessThan(first.s.t0);
    }
    for (const device of ['home', 'isp', 'resolver', 'server']) {
      const first = trips.find((x) => x.step.to === device)!;
      const at = tl.reveals.get(device)!;
      expect(at.t1).toBeLessThan(first.s.t0);
      // The cable is nearly there first, or the device would stand there alone.
      expect(at.t0).toBeGreaterThan(tl.laid.get(first.step.link)!.t0);
    }
  });

  it('does not touch a run nobody dropped anything into', () => {
    for (const a of JOBS) expect(buildTimeline(story(a)).segs.some((x) => x.trip.chapter === 'traffic')).toBe(false);
  });
});
