import { describe, expect, it } from 'vitest';
import { crossingKey, fetchWebPage, runScenario, type Cut, type FaultPlan, type ManualFault } from '../sim';
import { THIN_QUEUE, type FetchWebPageOptions } from '../sim/scenarios/fetchWebPage';
import { buildStory, type Step, type Story, type Trip } from './story';
import { NO_PAST, pastAt, buildTimeline, crossings, laneShare, ridingOn, seenSoFar, spyLog, stepTarget, type FlowPacket, type Seg, type Timeline } from './timeline';
import { easeInOut } from './project';

const CLEAN: FaultPlan = { randomLoss: 0, manual: [] };
const photo = (opts: FetchWebPageOptions = {}, faults: FaultPlan = CLEAN) =>
  buildStory(runScenario(fetchWebPage({ site: 'httpbin.org', ...opts }), { seed: 1, faults, maxTime: 1000 }));
const packets = (s: Story): Trip[] => s.trips.flatMap((t) => t.steps.flatMap((x) => (x.kind === 'flow' && x.packets.length > 1 ? x.packets : [])));
/** The stream, not one of the small ACKs on their own. */
const stream = (tl: Timeline): Seg => tl.segs.find((s) => (s.flow?.length ?? 0) > 1)!;
const flowOf = (tl: Timeline): FlowPacket[] => stream(tl)?.flow ?? [];
const parts = (s: Story): number[] => [...new Set(packets(s).flatMap((t) => (t.part ? [t.part.n] : [])))];
const faces = (tl: Timeline): string[] => tl.reactions.map((r) => r.face);

describe('a photo: many packets at once', () => {
  const s = photo();
  const tl = buildTimeline(s);
  const flow = flowOf(tl);

  it('the reply is one step, after the server has found the file', () => {
    const big = s.trips.filter((x) => x.steps.some((y) => y.kind === 'flow' && y.packets.length > 1));
    expect(big).toHaveLength(1);
    expect(big[0]!.steps.map((x) => x.kind)).toEqual(['lookup', 'flow']);
  });

  it('every band of the picture gets its packet, with ACKs coming back', () => {
    const data = packets(s).filter((t) => t.part);
    expect(data.length).toBe(data[0]!.part!.of);
    expect(data[0]!.part!.of).toBe(25);
    expect(parts(s)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(packets(s).filter((t) => t.l4Label === 'ACK').length).toBeGreaterThan(10);
  });

  it('moves a block into its lane while it moves along, never after it has all but stopped', () => {
    for (let k = 0; k <= 1; k += 0.01) {
      const came = easeInOut(k);
      if (Math.min(came, 1 - came) < 0.02) expect(laneShare(k)).toBeLessThan(0.03);
    }
    expect(laneShare(0)).toBe(0);
    expect(laneShare(1)).toBe(0);
    expect(laneShare(0.5)).toBe(1);
  });

  it('shows the real JPEG', () => {
    expect(s.image?.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);
    expect(atob(s.image!.split(',')[1]!).length).toBe(35588);
    expect(s.pageTitle).toBe('photo');
  });

  it('TCP sends ten packets, then waits for ACKs', () => {
    const data = flow.filter((p) => p.trip.part);
    const firstAck = flow.find((p) => !p.trip.part)!;
    const arrival = firstAck.hops[firstAck.hops.length - 1]!.t1;
    expect(data.filter((p) => p.t0 < arrival)).toHaveLength(10);
    expect(data[10]!.t0).toBeGreaterThanOrEqual(arrival);
  });

  it('the window grows: an ACK lets out more than one new packet', () => {
    const data = flow.filter((p) => p.trip.part);
    const window = (from: number, to: number): number => data.filter((p) => p.t0 >= from && p.t0 < to).length;
    const firstAck = flow.find((p) => !p.trip.part)!;
    const arrival = firstAck.hops[firstAck.hops.length - 1]!.t1;
    expect(window(arrival, arrival + 2.6)).toBeGreaterThan(5);
  });

  it('packets of one sender never start together, so each can be seen', () => {
    for (const origin of ['server', 'laptop']) {
      const starts = flow.filter((p) => p.trip.origin === origin).map((p) => p.t0);
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThan(0.2);
    }
  });

  it('several are on their way at once', () => {
    const at = flow[6]!.t0;
    expect(flow.filter((p) => p.t0 <= at && at < p.t1).length).toBeGreaterThan(3);
  });

  it('ends in love, and fits the seconds of one sitting', () => {
    expect(faces(tl)).toContain('love');
    expect(faces(tl)).not.toContain('confused');
    const seg = stream(tl);
    expect(seg.t1 - seg.t0).toBeLessThan(30);
  });

  it('what was seen includes the stream, so a cut mid-way keeps it', () => {
    const seg = stream(tl);
    const seen = seenSoFar(tl, seg.t0 + 6);
    const first = flow[0]!;
    expect(seen.decided[`${first.trip.packetId}@${first.hops[0]!.link}`]).toBe(false);
    expect(seen.now).toBeGreaterThan(0);
  });
});

describe('a photo over every setup', () => {
  const setups: FetchWebPageOptions[] = [{ https: true }, { vpn: true }, { slow: true }, { from: 'phone' }, { https: true, vpn: true }, { revisit: true }];
  for (const opts of setups) {
    it(`arrives whole with ${JSON.stringify(opts)}`, () => {
      const s = photo(opts);
      const tl = buildTimeline(s);
      expect(s.image).not.toBeNull();
      expect(parts(s).length).toBe(packets(s).find((t) => t.part)!.part!.of);
      expect(faces(tl)).toContain('love');
    });
  }
});

describe('a packet of a photo gets lost', () => {
  const clean = photo();
  const third = packets(clean).find((t) => t.part?.n === 3)!;
  const s = photo({}, { randomLoss: 0, manual: [{ packetId: third.packetId, linkId: 'wan' }] });
  const tl = buildTimeline(s);
  const flow = flowOf(tl);

  it('it falls off, the later ones get through, and a resend fills the gap', () => {
    const three = flow.filter((p) => p.trip.part?.n === 3);
    expect(three.map((p) => p.landed === null)).toEqual([true, false]);
    expect(three[1]!.trip.retry).toBe(true);
    expect(three[1]!.landed!).toBeGreaterThan(flow.find((p) => p.trip.part?.n === 4)!.landed!);
  });

  it('the receiver is puzzled once, then delighted', () => {
    expect(faces(tl).filter((f) => f === 'confused')).toHaveLength(1);
    expect(faces(tl).at(-1)).toBe('love');
  });

  it('nothing before the loss moves', () => {
    const before = flowOf(buildTimeline(clean));
    const lostAt = flow.findIndex((p) => p.landed === null && p.trip.part);
    for (let i = 0; i <= lostAt; i++) expect(flow[i]!.t0).toBeCloseTo(before[i]!.t0, 6);
  });
});

describe('a photo down a thin pipe: the first loss with no cut', () => {
  const s = photo({ thin: true });
  const tl = buildTimeline(s);
  const flow = flowOf(tl);
  const travelOn = (t: Trip, link: string) => t.steps.find((x): x is Extract<Step, { kind: 'travel' }> => x.kind === 'travel' && x.link === link);

  it('the story knows, and each part carries how long it waited at the ISP’s port', () => {
    expect(s.thin).toBe(true);
    expect(photo().thin).toBe(false);
    expect(s.links.find((l) => l.id === 'wan')?.queue).toBe(THIN_QUEUE);
    expect(photo().links.find((l) => l.id === 'wan')?.queue).toBeUndefined();
    const waits = packets(s).filter((t) => t.part && !t.retry && !t.lost).map((t) => travelOn(t, 'wan')?.queued ?? 0);
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBeGreaterThan(0);
    expect(waits[2]).toBeGreaterThan(waits[1]!);
    expect(packets(photo()).every((t) => travelOn(t, 'wan')?.queued === undefined)).toBe(true);
  });

  it('one part falls off the full tray at the ISP router, never reaching the cable, and its resend fills the gap', () => {
    const dropped = packets(s).filter((t) => t.droppedAtQueue);
    expect(dropped).toHaveLength(1);
    const d = dropped[0]!;
    expect(d.lost).toBe(true);
    expect(d.part?.n).toBe(THIN_QUEUE + 2);
    expect(d.steps.map((x) => x.kind)).toEqual(['appear', 'wrap', 'wrap', 'wrap', 'travel', 'unwrap', 'wrap', 'lost']);
    expect(d.steps.at(-2)).toMatchObject({ kind: 'wrap', device: 'isp', layer: 'eth' });
    const last = d.steps.at(-1)!;
    expect(last).toMatchObject({ kind: 'lost', from: 'isp', to: 'home', link: 'wan' });
    if (last.kind !== 'lost') throw new Error('not lost');
    expect(last.seen).toBeUndefined();
    expect(last.at).toBeGreaterThan(travelOn(d, 'bb2')!.at);
    const again = flow.filter((p) => p.trip.part?.n === d.part!.n);
    expect(again.map((p) => p.landed === null)).toEqual([true, false]);
    expect(again[1]!.trip).toMatchObject({ retry: true, retransmitOf: d.packetId });
    expect(again[1]!.trip.timedOut).toBeFalsy();
    expect(s.pageTitle).toBe('photo');
    expect(faces(tl).at(-1)).toBe('love');
    expect(stream(tl).waits).toEqual([]);
  });

  it('the spyglass on the line never reads what never got there', () => {
    const wan = crossings(tl).filter((c) => c.link === 'wan');
    const fallen = wan.filter((c) => c.lost);
    expect(fallen).toHaveLength(1);
    expect(fallen[0]!.trip.droppedAtQueue).toBe(true);
    expect(spyLog(tl, 'wan', tl.total)).toHaveLength(wan.length - 1);
  });
});

describe('a photo whose cable is cut', () => {
  it('stays a stream with its bands, so the sheet keeps its shape', () => {
    const clean = photo();
    const third = packets(clean).find((t) => t.part?.n === 3)!;
    const at = third.steps.find((x) => x.kind === 'travel')!;
    if (at.kind !== 'travel') throw new Error('no travel');
    const s = photo({}, { randomLoss: 0, manual: [], cuts: [{ link: 'bb2', from: at.at + 1e-6 }] });
    const data = packets(s).filter((t) => t.part);
    expect(data[0]!.part!.of).toBe(25);
    expect(s.pageTitle).toBeNull();
    expect(faces(buildTimeline(s))).not.toContain('love');
  });

  it('with no packet through at all, nothing breaks', () => {
    const s = photo({}, { randomLoss: 0, manual: [], cuts: [{ link: 'bb2', from: 0 }] });
    expect(() => buildTimeline(s)).not.toThrow();
    expect(s.trips.some((t) => t.l4Label === 'ACK' && t.chapter === 'page')).toBe(false);
  });
});

/** A run as main.ts changes it: at each moment, what is seen stays and the tool works from there on. */
class Run {
  faults: ManualFault[] = [];
  knocks = new Map<string, number>();
  decided: Record<string, boolean> = {};
  cuts: Cut[] = [];
  past = NO_PAST;
  s: Story;
  tl: Timeline;
  constructor(readonly opts: FetchWebPageOptions = {}) {
    this.s = photo(opts);
    this.tl = buildTimeline(this.s);
  }
  private again(): void {
    this.s = photo(this.opts, { randomLoss: 0, decided: this.decided, cuts: this.cuts, manual: this.faults });
    this.tl = buildTimeline(this.s, this.knocks, 0, new Map(), this.past);
  }
  cut(line: string, v: number): void {
    for (const r of ridingOn(this.tl, v, line)) {
      this.faults.push({ packetId: r.packetId, linkId: line, crossing: r.crossing });
      this.knocks.set(crossingKey(r.packetId, line, r.crossing), r.k);
    }
    const seen = seenSoFar(this.tl, v, line);
    this.decided = { ...this.decided, ...seen.decided };
    this.past = pastAt(this.tl, v, this.past);
    this.cuts = [...this.cuts, { link: line, from: seen.now }];
    this.again();
  }
  mend(line: string, v: number): void {
    const seen = seenSoFar(this.tl, v, line);
    this.decided = { ...this.decided, ...seen.decided };
    this.past = pastAt(this.tl, v, this.past);
    this.cuts = this.cuts.map((c) => (c.link === line && c.to === undefined ? { ...c, to: seen.now } : c));
    this.again();
  }
}
const started = (tl: Timeline, v: number): string[] =>
  crossings(tl)
    .filter((c) => c.t0 <= v)
    .map((c) => `${c.trip.packetId}@${c.link}@${c.t0.toFixed(6)}`)
    .sort();

describe('cutting a cable under a stream', () => {
  const start = (r: Run): number => stream(r.tl).t0;

  it('what is on the cable falls in, all of it, from where it was', () => {
    const r = new Run();
    const v = start(r) + 1.5;
    const riding = ridingOn(r.tl, v, 'bb2');
    expect(riding.length).toBeGreaterThan(1);
    r.cut('bb2', v);
    const after = flowOf(r.tl);
    for (const { packetId, k } of riding) {
      const hop = after.find((p) => p.trip.packetId === packetId)!.hops.find((h) => h.link === 'bb2')!;
      expect(hop).toMatchObject({ lost: true, fall: k });
    }
  });

  it('nothing crosses it afterwards', () => {
    for (const offset of [1.5, 4, 9, 14]) {
      const r = new Run();
      const v = start(r) + offset;
      r.cut('bb2', v);
      const late = crossings(r.tl).filter((c) => c.link === 'bb2' && c.t0 > v);
      expect(late.length).toBeGreaterThan(0);
      expect(late.filter((c) => !c.lost)).toEqual([]);
    }
  });

  it('never changes what has been seen, wherever and however it happens', { timeout: 60_000 }, () => {
    for (const opts of [{}, { https: true }, { slow: true }, { from: 'phone' as const }, { vpn: true }, { from: 'phone' as const, noise: 0.4 }]) {
      const clean = new Run(opts);
      const end = stream(clean.tl).t1;
      // Cutting noisy air itself makes new failed tries that take turns on the cable, which can move a frame just seen.
      for (const line of clean.s.links.map((l) => l.id).filter((l) => !opts.noise || l !== 'wlan')) {
        for (let v = start(clean) + 0.4; v < end; v += 3.7) {
          const cut = new Run(opts);
          cut.cut(line, v);
          // A radio's retry of a frame the cut changed may come in beside these; none of them goes or moves.
          if (opts.noise) expect(started(cut.tl, v), `cut ${line} at ${v}`).toEqual(expect.arrayContaining(started(clean.tl, v)));
          else expect(started(cut.tl, v), `cut ${line} at ${v}`).toEqual(started(clean.tl, v));
        }
      }
    }
  });

  it('a mended cable carries what comes after, and the picture still arrives', () => {
    const r = new Run();
    const v = start(r) + 4;
    r.cut('bb2', v);
    r.mend('bb2', v + 3);
    expect(crossings(r.tl).some((c) => c.link === 'bb2' && c.t0 > v + 3 && !c.lost)).toBe(true);
    expect(r.s.pageTitle).toBe('photo');
    expect(faces(r.tl).at(-1)).toBe('love');
  });

  it('the sender waits with a ring, angrier each time, and gives up in tears', () => {
    const r = new Run();
    r.cut('bb2', start(r) + 4);
    const waits = stream(r.tl).waits!;
    const moods = waits.map((w) => w.step.mood);
    expect(moods[0]).toBe('surprise');
    expect(moods.slice(1, -1).every((m) => m === 'angry')).toBe(true);
    expect(moods.at(-1)).toBe('cry');
    expect(waits.at(-1)!.step.giveUp).toBe(true);
    expect(waits.every((w) => w.step.device === 'server')).toBe(true);
    expect(waits.slice(0, -1).map((w) => Math.round(w.step.seconds)).slice(0, 3)).toEqual([1, 2, 4]);
    const seg = stream(r.tl);
    expect(seg.t1).toBeGreaterThanOrEqual(waits.at(-1)!.t1);
  });
});

describe('the tools see into a stream', () => {
  const s = photo();
  const tl = buildTimeline(s);
  const flow = flowOf(tl);

  it('the spyglass can read every frame of it, the plain reply and the ACKs', () => {
    const wan = crossings(tl).filter((c) => c.link === 'wan' && flow.some((p) => p.trip === c.trip));
    expect(wan.length).toBe(flow.length);
    expect(wan.every((c) => c.seen)).toBe(true);
    expect(wan.some((c) => c.seen!.lines.some((l) => l.startsWith('HTTP/1.1 200')))).toBe(true);
    expect(wan.some((c) => c.seen!.kind === 'empty')).toBe(true);
  });

  it('the spyglass keeps every read so far, oldest first', () => {
    const on = crossings(tl).filter((c) => c.link === 'wan');
    const all = spyLog(tl, 'wan', tl.total);
    expect(all).toHaveLength(on.length);
    const first = on.reduce((a, b) => (b.t0 < a.t0 ? b : a));
    expect(spyLog(tl, 'wan', first.t0)).toEqual([]);
    expect(spyLog(tl, 'wan', first.t1)[0]).toBe(first.seen);
    const part = spyLog(tl, 'wan', tl.total / 2);
    expect(part.length).toBeLessThan(all.length);
    expect(all.slice(0, part.length)).toEqual(part);
  });

  it('the spyglass only reads what passes after it was put there', () => {
    const all = spyLog(tl, 'wan', tl.total);
    const from = tl.total / 2;
    const later = spyLog(tl, 'wan', tl.total, from);
    expect(later.length).toBeGreaterThan(0);
    expect(later.length).toBeLessThan(all.length);
    expect(all.slice(-later.length)).toEqual(later);
    expect(spyLog(tl, 'wan', from - 1, from)).toEqual([]);
  });

  it('under HTTPS it reads only scrambled bytes', () => {
    const tl = buildTimeline(photo({ https: true }));
    const data = crossings(tl).filter((c) => flowOf(tl).some((p) => p.trip === c.trip) && c.trip.dataBytes > 0);
    expect(data.every((c) => c.seen?.kind === 'scrambled')).toBe(true);
  });

  it('the step buttons go through it one packet at a time', () => {
    const at = flow[6]!.t0;
    expect(stepTarget(tl, at, 1)).toBe(Math.min(...flow.filter((p) => p.t0 > at + 0.01).map((p) => p.t0)));
    expect(stepTarget(tl, at + 0.25, -1)).toBeGreaterThanOrEqual(at);
  });
});

describe('the end of a stream', () => {
  it('leaves out the ACK of the teardown', () => {
    for (const opts of [{}, { https: true }]) {
      const r = runScenario(fetchWebPage({ site: 'httpbin.org', ...opts }), { seed: 1, faults: CLEAN, maxTime: 1000 });
      const flow = packets(buildStory(r));
      const reach = Math.max(...flow.filter((t) => t.part).map((t) => (r.packets.get(t.packetId)?.tcp?.relSeq ?? 0) + t.dataBytes));
      const acks = flow.filter((t) => !t.part).map((t) => r.packets.get(t.packetId)?.tcp?.relAck ?? 0);
      expect(Math.max(...acks)).toBe(reach);
    }
  });
});

describe('small replies stay as they were', () => {
  it('the first website is two whole packets, with no stream', () => {
    const s = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: CLEAN }));
    expect(packets(s)).toHaveLength(0);
    expect(s.image).toBeNull();
    expect(s.trips.filter((t) => t.part).map((t) => t.card)).toEqual(['200 OK 1/2', '2/2']);
  });
});
