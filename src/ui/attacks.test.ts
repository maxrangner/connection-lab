import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, TCP_RST, type Attack, type Job, type SimResult } from '../sim';
import { buildStory, type Story, type Trip } from './story';
import { buildTimeline, crossings, joinAt, type Timeline } from './timeline';

const CLEAN = { randomLoss: 0, manual: [] };
const JOBS = { page: {}, photo: { site: 'httpbin.org' }, call: { call: true }, ping: { probe: 'ping' }, trace: { probe: 'traceroute' } } as const;
const sim = (opts: object): SimResult => runScenario(fetchWebPage(opts), { seed: 1, faults: CLEAN, maxTime: 1000 });
const everyPacket = (t: Trip): Trip[] => (t.steps.some((s) => s.kind === 'flow') ? t.steps.flatMap((s) => (s.kind === 'flow' ? s.packets.flatMap(everyPacket) : [])) : [t]);
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
    const found = Object.fromEntries(s.scan!.ports.map((p) => [p.port, p.open]));
    expect(found).toEqual({ 21: false, 22: true, 23: false, 25: false, 80: true, 443: true, 3306: false, 8080: false });
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

describe('attackers together', () => {
  it('any mix of them, with any job, runs without losing a packet', () => {
    const sets: Attack[][] = [['listen'], ['flood'], ['scan'], ['listen', 'flood'], ['listen', 'scan'], ['flood', 'scan'], ['listen', 'flood', 'scan']];
    for (const attacks of sets) {
      for (const job of Object.keys(JOBS) as Job[]) {
        for (const setup of [{}, { https: true }, { from: 'phone' }]) {
          const { s, tl } = run({ ...JOBS[job], ...setup, attacks });
          const onCables = s.trips.flatMap(everyPacket).flatMap((t) => t.steps.flatMap((x) => (x.kind === 'travel' || x.kind === 'lost' ? [`${t.packetId}@${x.link} ${x.at}`] : [])));
          expect(crossings(tl).map((c) => `${c.trip.packetId}@${c.link} ${c.at}`).sort()).toEqual(onCables.sort());
          expect(tl.segs.every((x) => x.t1 >= x.t0)).toBe(true);
        }
      }
    }
  }, 120_000);

  it('a card dropped in during an attack gets its own colour and job', () => {
    const before = run({ attacks: ['scan'] });
    const v = before.tl.total * 0.2;
    const s = buildStory(sim({ attacks: ['scan'], join: { job: 'ping', at: joinAt(before.tl, v) } }));
    expect(s.joiner).toBe('phone');
    expect(s.clients).toEqual(['laptop', 'scanner', 'phone']);
    expect(s.joinProbe?.kind).toBe('ping');
    expect(s.trips.flatMap(everyPacket).filter((t) => t.chapter === 'ping').every((t) => t.client === 'phone')).toBe(true);
  });

  it('nothing changes without them', () => {
    const plain = run({});
    expect(plain.s.attackers).toEqual([]);
    expect(plain.tl.attackReadouts).toEqual([]);
    expect(plain.s.devices.some((d) => ['stranger', 'bot', 'scanner'].includes(d.kind))).toBe(false);
  });
});
