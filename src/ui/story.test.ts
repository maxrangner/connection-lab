import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type ManualFault } from '../sim';
import { buildStory, cardLabel, dnsCardLabel, type Trip } from './story';
import { buildTimeline, packetPose, seenSoFar, trayAngle } from './timeline';

const run = (manual: ManualFault[] = []) => buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual } }));
const story = run();
const kinds = (t: Trip): string[] => t.steps.map((s) => (s.kind === 'wrap' || s.kind === 'unwrap' ? `${s.kind}:${s.layer}` : s.kind));
const get = (card: string | null, label?: string): Trip => story.trips.find((t) => t.card === card && (!label || t.l4Label === label))!;

describe('network story', () => {
  it('tells three chapters: find the address, say hello, get the page', () => {
    expect(story.trips.map((t) => [t.chapter, t.card ?? t.l4Label])).toEqual([
      ['dns', 'example.com?'],
      ['dns', '104.20.23.154'],
      ['hello', 'SYN'],
      ['hello', 'SYN-ACK'],
      ['hello', 'ACK'],
      ['page', 'GET /'],
      ['page', '200 OK'],
    ]);
  });

  it('packs the request at the laptop, re-sleeves it at routers and unpacks it at the server', () => {
    expect(kinds(get('GET /'))).toEqual([
      'appear', 'wrap:l4', 'wrap:ip', 'wrap:eth', 'travel',
      'unwrap:eth', 'nat', 'wrap:eth', 'travel',
      'unwrap:eth', 'wrap:eth', 'travel',
      'unwrap:eth', 'unwrap:ip', 'unwrap:l4', 'read',
    ]);
    // An empty segment has no card to show or read.
    expect(kinds(get(null, 'SYN'))[0]).toBe('wrap:l4');
    expect(kinds(get(null, 'SYN'))).not.toContain('read');
  });

  it('sends the DNS question over UDP to the resolver and back', () => {
    const q = story.trips[0]!;
    expect(q.l4).toBe('udp');
    expect(q.header.l4).toBe(8);
    expect(q.steps.filter((s) => s.kind === 'travel').map((s) => s.kind === 'travel' && s.to)).toEqual(['home', 'isp', 'resolver']);
    expect(story.dnsAnswer).toBe('104.20.23.154');
  });

  it('uses real header sizes and addresses', () => {
    const get1 = get('GET /');
    expect(get1.header).toEqual({ eth: 14, ip: 20, l4: 32 });
    expect(get1.trailer).toBe(4);
    expect(get1.from).toBe('192.168.1.23');
    expect(get1.steps.find((s) => s.kind === 'nat')).toMatchObject({ device: 'home', which: 'from', after: '203.0.113.7' });
    expect(get('200 OK').steps.find((s) => s.kind === 'nat')).toMatchObject({ device: 'home', which: 'to', after: '192.168.1.23' });
    expect(story.pageTitle).toBe('Example Domain');
  });

  it('turns summaries into card labels', () => {
    expect(cardLabel('HTTP GET / HTTP/1.1')).toBe('GET /');
    expect(cardLabel('HTTP HTTP/1.1 200 OK')).toBe('200 OK');
    expect(dnsCardLabel('DNS query 0x85bb: example.com A?')).toBe('example.com?');
    expect(dnsCardLabel('DNS response 0x85bb: example.com A 104.20.23.154, 172.66.147.243')).toBe('104.20.23.154');
  });
});

describe('knocking a packet off a cable', () => {
  const getTrip = get('GET /');
  const knocked = run([{ packetId: getTrip.packetId, linkId: 'wan' }]);

  it('ends that trip with a fall on that cable, and the laptop sends a new GET', () => {
    const lost = knocked.trips.find((t) => t.packetId === getTrip.packetId)!;
    expect(lost.lost).toBe(true);
    expect(lost.steps[lost.steps.length - 1]).toMatchObject({ kind: 'lost', from: 'home', to: 'isp' });
    const retry = knocked.trips[knocked.trips.indexOf(lost) + 1]!;
    expect(retry).toMatchObject({ card: 'GET /', retry: true, origin: 'laptop' });
    expect(retry.start - lost.start).toBeGreaterThanOrEqual(1); // RFC 6298: at least 1 s
    expect(knocked.pageTitle).toBe('Example Domain');
  });

  it('waits for the timer at the resender, then tries again', () => {
    const tl = buildTimeline(knocked, new Map([[`${getTrip.packetId}@wan`, 0.5]]));
    const wait = tl.segs.find((s) => s.step.kind === 'wait')!;
    expect(wait.step).toMatchObject({ device: 'laptop', giveUp: false });
    expect(tl.cues.some((c) => c.sound === 'bonk')).toBe(true);
  });

  it('does not change anything that happened before the knock', () => {
    const plain = buildTimeline(story);
    const tl = buildTimeline(knocked, new Map([[`${getTrip.packetId}@wan`, 0.5]]));
    const lostAt = tl.segs.findIndex((s) => s.step.kind === 'lost');
    expect(tl.segs.slice(0, lostAt).map((s) => [s.step.kind, s.t0, s.t1])).toEqual(plain.segs.slice(0, lostAt).map((s) => [s.step.kind, s.t0, s.t1]));
    expect(tl.segs[lostAt]!.t0).toBe(plain.segs[lostAt]!.t0);
  });

  it('a lost DNS question is asked again after 5 s', () => {
    const q = story.trips[0]!;
    const s = run([{ packetId: q.packetId, linkId: 'lan' }]);
    const retry = s.trips[1]!;
    expect(retry).toMatchObject({ card: 'example.com?', retry: true });
    expect(retry.start - s.trips[0]!.start).toBeCloseTo(5, 3);
  });
});

describe('stickers', () => {
  it('bigger page: the first website comes back in numbered parts', () => {
    const s = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    expect(s.site).toBe('info.cern.ch');
    expect(s.trips.find((t) => t.chapter === 'page')?.card).toBe('GET …/TheProject.html');
    const parts = s.trips.filter((t) => t.part);
    expect(parts.map((t) => t.card)).toEqual(['200 OK 1/2', '2/2']);
    expect(s.pageTitle).toBe('The World Wide Web project');
  });

  it('visit again: no address lookup, the laptop remembers it', () => {
    const s = buildStory(runScenario(fetchWebPage({ revisit: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    expect(s.trips.some((t) => t.chapter === 'dns')).toBe(false);
    expect(s.remembered).toBe('104.20.23.154');
    expect(s.trips[0]!.l4Label).toBe('SYN');
  });

  it('stormy: losses only on the internet side, each followed by a retry or a give-up', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = buildStory(runScenario(fetchWebPage(), { seed, faults: { randomLoss: 0.15, lossyLinks: ['wan', 'bb1', 'bb2'], manual: [] } }));
      for (const t of s.trips.filter((x) => x.lost)) {
        const last = t.steps[t.steps.length - 1]!;
        expect(last.kind === 'lost' && ['wan', 'bb1', 'bb2'].includes(last.link)).toBe(true);
      }
      const tl = buildTimeline(s);
      expect(tl.segs.filter((x) => x.step.kind === 'wait')).toHaveLength(s.trips.filter((x) => x.lost).length);
    }
  });
});

describe('packet facing', () => {
  const tl = buildTimeline(story);
  const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

  it('never jumps within a trip, and lies along the stations inside every device', () => {
    for (const trip of story.trips) {
      const segs = tl.segs.filter((s) => s.trip === trip && s.step.kind !== 'wait');
      let prev: number | null = null;
      for (const seg of segs) {
        for (let i = 0; i <= 400; i++) {
          const { angle } = packetPose(tl, seg, i / 400);
          if (prev !== null) expect(angleDiff(angle, prev)).toBeLessThan(0.05);
          prev = angle;
          if (seg.step.kind !== 'travel' && seg.step.kind !== 'lost') expect(angleDiff(angle, trayAngle(trip))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('turns only on the cable that branches off to the resolver', () => {
    const turned = new Set<string>();
    for (const seg of tl.segs) {
      if (seg.step.kind !== 'travel') continue;
      const mid = packetPose(tl, seg, 0.5).angle;
      if (angleDiff(mid, trayAngle(seg.trip)) > 0.1) turned.add(seg.step.link);
    }
    expect([...turned]).toEqual(['bb1']);
  });
});

describe('emoji statuses', () => {
  it('thumbs up for replies and the final ACK, love when the page is in', () => {
    const tl = buildTimeline(story);
    expect(tl.reactions.map((r) => `${r.device}:${r.face}`)).toEqual(['laptop:thumbs', 'laptop:thumbs', 'server:thumbs', 'laptop:love']);
  });

  it('confused when part 2 arrives before part 1, love once the gap is filled', () => {
    const plain = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const first = plain.trips.find((t) => t.part?.n === 1)!;
    const s = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: first.packetId, linkId: 'bb2' }] } }));
    const faces = buildTimeline(s).reactions.filter((r) => r.device === 'laptop').map((r) => r.face);
    expect(faces.slice(-2)).toEqual(['confused', 'love']);
  });

  it('angry when the resend is lost too, crying when it gives up', () => {
    const q = story.trips[0]!;
    const once = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: q.packetId, linkId: 'lan' }] } }));
    const retry = once.trips[1]!;
    const twice = buildStory(
      runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: q.packetId, linkId: 'lan' }, { packetId: retry.packetId, linkId: 'lan' }] } }),
    );
    const moods = buildTimeline(twice).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step.mood] : []));
    expect(moods).toEqual(['surprise', 'cry']);
    const get = story.trips.find((t) => t.card === 'GET /')!;
    const s1 = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: get.packetId, linkId: 'wan' }] } }));
    const get2 = s1.trips.find((t) => t.card === 'GET /' && t.retry)!;
    const s2 = buildStory(
      runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: get.packetId, linkId: 'wan' }, { packetId: get2.packetId, linkId: 'wan' }] } }),
    );
    expect(buildTimeline(s2).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step.mood] : []))).toEqual(['surprise', 'angry']);
  });
});

describe('switching the storm on and off mid-run', () => {
  const STORM = ['wan', 'bb1', 'bb2'];
  const run = (seed: number, windows: { from: number; to?: number }[], decided: Record<string, boolean>) =>
    buildTimeline(buildStory(runScenario(fetchWebPage(), { seed, faults: { randomLoss: 0.3, lossyLinks: STORM, lossWindows: windows, decided, manual: [] } })));
  const same = (a: ReturnType<typeof run>, b: ReturnType<typeof run>, v: number) => {
    const pick = (tl: ReturnType<typeof run>) => tl.segs.filter((s) => s.t0 <= v).map((s) => [s.step.kind, s.trip.packetId, s.t0, s.t1]);
    expect(pick(b)).toEqual(pick(a));
  };

  it('never changes what was already seen, turning it on or off', () => {
    let changed = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const calm = run(seed, [], {});
      const stormy = run(seed, [{ from: 0 }], {});
      for (const frac of [0.15, 0.4, 0.7]) {
        // Calm → stormy at v.
        const v = calm.total * frac;
        const a = seenSoFar(calm, v);
        const on = run(seed, [{ from: a.now }], a.decided);
        same(calm, on, v);
        if (on.segs.some((s) => s.step.kind === 'lost')) changed++;
        // Stormy → calm at v.
        const w = stormy.total * frac;
        const b = seenSoFar(stormy, w);
        same(stormy, run(seed, [{ from: 0, to: b.now }], b.decided), w);
      }
    }
    // And the storm really does something after it starts.
    expect(changed).toBeGreaterThan(0);
  });
});
