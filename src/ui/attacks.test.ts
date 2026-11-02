import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, TCP_RST, type Attack, type Job, type SimResult } from '../sim';
import { buildStory, unrolled, type Story } from './story';
import { buildTimeline, crossings, joinAt, namedAcks, type Timeline } from './timeline';

const CLEAN = { randomLoss: 0, manual: [] };
const JOBS = { page: {}, photo: { site: 'connection-lab.rangner.com' }, call: { call: true }, ping: { probe: 'ping' }, trace: { probe: 'traceroute' } } as const;
const sim = (opts: object): SimResult => runScenario(fetchWebPage(opts), { seed: 1, faults: CLEAN, maxTime: 1000 });
const run = (opts: object): { s: Story; tl: Timeline } => {
  const s = buildStory(sim(opts));
  return { s, tl: buildTimeline(s) };
};
const printed = (tl: Timeline): string[] => tl.attackReadouts[0]!.readout.screens.at(-1)!.lines;

describe('the stranger by the Wi-Fi', () => {
  const listen = { from: 'phone', attacks: ['listen'] as Attack[] };

  it('reads a plain page right off the air', () => {
    expect(printed(run(listen).tl)).toEqual(expect.arrayContaining(['GET / HTTP/1.1', 'Host: example.com', 'HTTP/1.1 200 OK', '<title>Example Domain</title>']));
  });

  it('with HTTPS gets the name and scrambled bytes, and not the page', () => {
    const lines = printed(run({ ...listen, https: true }).tl);
    expect(lines.some((l) => l.startsWith('scrambled: '))).toBe(true);
    expect(lines).toContain('example.com');
    expect(lines.some((l) => /GET|title/.test(l))).toBe(false);
  });

  it('says what it makes of it', () => {
    expect(run(listen).tl.speech.filter((b) => b.device === 'stranger').map((b) => b.text)).toContain('I can read this!');
    expect(run({ ...listen, https: true }).tl.speech.filter((b) => b.device === 'stranger').map((b) => b.text)).toContain('The rest is scrambled');
  });

  it('hears nothing of a laptop on its cable', () => {
    expect(printed(run({ attacks: ['listen'] }).tl)).toEqual(['listening on open Wi-Fi', 'heard nothing']);
  });

  it('changes nothing: every frame goes as it would have', () => {
    const frames = (r: SimResult): string[] => r.events.filter((e) => e.type === 'tx').map((e) => `${e.t} ${e.packetId} ${e.linkId}`);
    expect(frames(sim(listen))).toEqual(frames(sim({ from: 'phone' })));
  });

  it('keeps the run step by step', () => {
    expect(run(listen).tl.segs.some((x) => x.trip.chapter === 'traffic')).toBe(false);
  });
});

describe('the scanner', () => {
  const scan = { attacks: ['scan'] as Attack[] };

  it('finds the open doors: a real SYN-ACK from those, a real reset from the rest', () => {
    const { s } = run(scan);
    const found = Object.fromEntries(s.scan!.ports.map((p) => [p.port, p.answer]));
    expect(found).toEqual({ 21: 'closed', 22: 'open', 23: 'closed', 25: 'closed', 80: 'open', 443: 'open', 3306: 'closed', 8080: 'closed' });
  });

  it('counts a door once, and owns up to the ports that never answered', () => {
    for (const seed of [1, 2, 3]) {
      for (const https of [false, true]) {
        const s = buildStory(runScenario(fetchWebPage({ attacks: ['flood', 'scan'], https }), { seed, faults: CLEAN, maxTime: 1000 }));
        const tl = buildTimeline(s);
        const lines = tl.attackReadouts.find((x) => x.device === 'scanner')!.readout.screens.at(-1)!.lines;
        const rows = lines.slice(1, -1);
        expect(rows).toHaveLength(8);
        expect(new Set(rows.map((l) => l.split(' ')[0])).size).toBe(8);
        expect(lines.at(-1)).toBe(`${rows.filter((l) => l.endsWith('open')).length} doors open`);
      }
    }
    const silent = run({ attacks: ['flood', 'scan'] });
    expect(silent.s.scan!.ports.some((p) => p.answer === null)).toBe(true);
    expect(printed({ ...silent.tl, attackReadouts: silent.tl.attackReadouts.filter((x) => x.device === 'scanner') })).toContain('25    no answer');
  });

  it('with its cable cut it heard nothing, and says so', () => {
    const r = runScenario(fetchWebPage({ attacks: ['scan'] }), { seed: 1, faults: { ...CLEAN, cuts: [{ link: 'scanner-link', from: 0 }] }, maxTime: 1000 });
    const s = buildStory(r);
    const lines = buildTimeline(s).attackReadouts[0]!.readout.screens.at(-1)!.lines;
    expect(lines.filter((l) => l.endsWith('no answer'))).toHaveLength(8);
    expect(lines.at(-1)).toBe('0 doors open');
  });

  it('prints each port and sums up', () => {
    const lines = printed(run(scan).tl);
    expect(lines).toContain('22    open');
    expect(lines).toContain('3306  closed');
    expect(lines.at(-1)).toBe('3 doors open');
  });

  it('never finishes a hello: it resets every door that opened, and the server lets go', () => {
    const r = sim(scan);
    const resets = [...r.packets.values()].filter((p) => p.origin === 'scanner' && p.tcp && p.tcp.flags & TCP_RST);
    expect(resets).toHaveLength(3);
    expect(r.events.filter((e) => e.type === 'tcp:retransmit' && e.deviceId === 'server')).toEqual([]);
    expect(r.events.filter((e) => e.type === 'tcp:state' && e.deviceId === 'server' && e.to === 'ESTABLISHED' && e.connId.includes('198.51.100.104'))).toEqual([]);
  });

  it('leaves the page alone', () => {
    const { s } = run(scan);
    expect(s.pageTitle).toBe('Example Domain');
  });

  it('knocks one after another and each answer comes after its knock', () => {
    const { tl } = run(scan);
    const blocks = tl.segs.find((x) => x.trip.chapter === 'traffic')!.flow!.filter((p) => p.trip.client === 'scanner');
    const knocks = blocks.filter((p) => p.trip.l4Label === 'SYN');
    expect(knocks).toHaveLength(8);
    expect(blocks.find((p) => p.trip.origin === 'server')!.t0).toBeGreaterThan(knocks[0]!.t0);
    expect(tl.speech.some((b) => b.device === 'scanner' && b.text === 'Anyone home?')).toBe(true);
  });
});

describe('the botnet', () => {
  const flood = { attacks: ['flood'] as Attack[] };

  it('fills the server\'s line until the port throws packets away, the first device\'s too', () => {
    const r = sim(flood);
    const dropped = r.events.filter((e) => e.type === 'drop' && e.reason === 'queue-full' && 'packetId' in e).map((e) => r.packets.get((e as { packetId: string }).packetId)!);
    expect(dropped.filter((p) => p.kind === 'flood').length).toBeGreaterThan(30);
    expect(dropped.some((p) => p.job === 0)).toBe(true);
  });

  it('holds the page up for seconds, and it still comes when the flood is over', () => {
    const s = buildStory(sim(flood));
    const quiet = buildStory(sim({}));
    const got = (x: SimResult): number => x.events.find((e) => e.type === 'app' && e.action === 'http-response-received')!.t;
    expect(s.pageTitle).toBe(quiet.pageTitle);
    expect(got(sim({}))).toBeLessThan(0.1);
    expect(got(sim(flood))).toBeGreaterThan(1);
  });

  it('draws every bot packet in the bots\' name, and the first device\'s as its own', () => {
    const { s, tl } = run(flood);
    const blocks = tl.segs.find((x) => x.trip.chapter === 'traffic')!.flow!;
    expect(blocks.filter((p) => p.trip.card === 'junk')).toHaveLength(108);
    expect(blocks.filter((p) => p.trip.card === 'junk').every((p) => s.attackers.includes(p.trip.client))).toBe(true);
    expect(blocks.some((p) => p.trip.client === 'laptop')).toBe(true);
    expect(tl.speech.filter((b) => b.text === 'Flood it!')).toHaveLength(3);
  });

  it('stays on the table in order: a run does not take forever', () => {
    expect(run(flood).tl.total).toBeLessThan(120);
  });
});

describe('a connection the other side has forgotten', () => {
  /** The cable to the ISP dies after the hello's first two packets, stays dead until the server has given up, and is mended. */
  const forgotten = (): SimResult => {
    const clear = sim({});
    const synAck = [...clear.packets.values()].find((p) => p.label.includes('SYN-ACK') || (p.tcp && (p.tcp.flags & 0x12) === 0x12))!;
    const back = clear.events.find((e) => e.type === 'rx' && e.packetId === synAck.id && e.deviceId === 'laptop')!;
    return runScenario(fetchWebPage({}), { seed: 1, faults: { ...CLEAN, cuts: [{ link: 'wan', from: back.t, to: 100 }] }, maxTime: 1000 });
  };

  it('resets the client when it speaks up again, and the browser hears why', () => {
    const r = forgotten();
    expect(r.events.some((e) => e.type === 'app' && e.action === 'error' && e.deviceId === 'laptop' && e.info?.reason === 'connection reset')).toBe(true);
  });

  it('the run ends with a reason: the reset is told, and the device gives up', () => {
    const s = buildStory(forgotten());
    const tl = buildTimeline(s);
    expect(s.trips.some((t) => t.l4Label.includes('RST') && t.origin === 'server')).toBe(true);
    expect(tl.segs.some((x) => x.step.kind === 'wait' && x.step.giveUp && x.step.device === 'laptop')).toBe(true);
    expect(s.pageTitle).toBeNull();
  });
});

describe('attackers together', () => {
  it('any mix of them, with any job, runs without losing a packet', () => {
    const sets: Attack[][] = [['listen'], ['flood'], ['scan'], ['listen', 'flood'], ['listen', 'scan'], ['flood', 'scan'], ['listen', 'flood', 'scan']];
    for (const attacks of sets) {
      for (const job of Object.keys(JOBS) as Job[]) {
        for (const setup of [{}, { https: true }, { from: 'phone' }]) {
          const { s, tl } = run({ ...JOBS[job], ...setup, attacks });
          const onCables = s.trips.flatMap(unrolled).flatMap((t) => t.steps.flatMap((x) => (x.kind === 'travel' || x.kind === 'lost' ? [`${t.packetId}@${x.link} ${x.at}`] : [])));
          expect(crossings(tl).map((c) => `${c.trip.packetId}@${c.link} ${c.at}`).sort()).toEqual(onCables.sort());
          expect(tl.segs.every((x) => x.t1 >= x.t0)).toBe(true);
        }
      }
    }
  }, 120_000);

  it('calls only an ACK an ACK: a SYN, a SYN-ACK or a reset has no data either', () => {
    for (const opts of [{ attacks: ['scan'] }, { attacks: ['flood'] }, { joins: [{ job: 'page', at: 0.001 }] }, { site: 'connection-lab.rangner.com' }]) {
      const flows = run(opts).tl.segs.flatMap((x) => (x.flow ? [x.flow] : []));
      expect(flows.flatMap(namedAcks).length).toBeGreaterThan(0);
      for (const flow of flows) {
        const acks = flow.filter((p) => p.trip.l4Label === 'ACK');
        expect(namedAcks(flow)).toEqual(acks.slice(0, 3));
      }
    }
  });

  it('a card dropped in during an attack gets its own colour and job', () => {
    const before = run({ attacks: ['scan'] });
    const v = before.tl.total * 0.2;
    const s = buildStory(sim({ attacks: ['scan'], joins: [{ job: 'ping', at: joinAt(before.tl, v) }] }));
    expect(s.joiners).toEqual(['phone']);
    expect(s.clients).toEqual(['laptop', 'scanner', 'phone']);
    expect(s.joinProbes[0]?.probe.kind).toBe('ping');
    expect(s.trips.flatMap(unrolled).filter((t) => t.chapter === 'ping').every((t) => t.client === 'phone')).toBe(true);
  });

  it('a card dropped in during an attack starts then, and what was on screen stays', () => {
    const shown = (tl: Timeline, v: number): string[] => crossings(tl).filter((c) => c.t0 < v).map((c) => `${c.trip.packetId}@${c.link} ${c.t0.toFixed(6)} ${c.t1.toFixed(6)}`);
    for (const attacks of [['flood'], ['scan'], ['flood', 'scan']] as Attack[][]) {
      for (const job of Object.keys(JOBS) as Job[]) {
        for (const share of [0.1, 0.4, 0.8]) {
          const before = run({ attacks }).tl;
          const v = before.total * share;
          const s = buildStory(sim({ attacks, joins: [{ job, at: joinAt(before, v) }] }));
          const after = buildTimeline(s, new Map(), 0, new Map([[s.joiners[0]!, v]]));
          const blocks = after.segs.find((x) => x.trip.chapter === 'traffic')!.flow!;
          const what = `${job} into ${attacks} at ${share}`;
          expect(Math.min(...blocks.filter((p) => p.trip.client === 'phone').map((p) => p.t0)), what).toBeGreaterThanOrEqual(v);
          expect(shown(after, v), what).toEqual(shown(before, v));
        }
      }
    }
  }, 120_000);

  it('a stranger with noisy Wi-Fi hears a frame the first time it goes by', () => {
    const { s, tl } = run({ from: 'phone', noise: 0.4, attacks: ['listen'] });
    const first = new Map<string, number>();
    for (const c of crossings(tl)) if (c.link === 'wlan' && !first.has(c.trip.packetId)) first.set(c.trip.packetId, c.t0);
    const times = tl.attackReadouts[0]!.readout.screens.slice(1).map((x) => x.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const earliest = Math.min(...s.heard.filter((h) => h.seen.kind !== 'empty' && first.has(h.packetId)).map((h) => first.get(h.packetId)!));
    expect(times[0]! - earliest).toBeLessThan(2);
  });

  it('nothing changes without them', () => {
    const plain = run({});
    expect(plain.s.attackers).toEqual([]);
    expect(plain.tl.attackReadouts).toEqual([]);
    expect(plain.s.devices.some((d) => ['stranger', 'bot', 'scanner'].includes(d.kind))).toBe(false);
  });
});
