import { describe, expect, it } from 'vitest';
import { fetchWebPage, READING_AT, runScenario, type Attack, type SimResult } from '../sim';
import { buildStory, type Story, type Trip } from './story';
import { buildTimeline, crossings, realAt, seenSoFar, type Timeline } from './timeline';
import { buildSpeech } from './speech';

const CLEAN = { randomLoss: 0, manual: [] };
const sim = (opts: object = {}, faults: object = {}, seed = 1): SimResult => runScenario(fetchWebPage({ reading: true, ...opts }), { seed, faults: { ...CLEAN, ...faults }, maxTime: 1000 });
const run = (opts: object = {}, faults: object = {}): { s: Story; tl: Timeline } => {
  const s = buildStory(sim(opts, faults));
  return { s, tl: buildTimeline(s) };
};
const readings = (t: Trip[]): Trip[] => t.filter((x) => x.message?.kind === 'reading');
const told = (r: SimResult): string[] => r.events.flatMap((e) => (e.type === 'app' && e.action === 'mqtt-received' ? [`${e.deviceId}: ${e.info?.topic} ${e.info?.value}`] : []));

describe('the sensor takes a reading', () => {
  it('goes to the broker, and the broker sends each app its own copy', () => {
    const { s } = run();
    expect(readings(s.trips).map((t) => `${t.origin} → ${t.to === '203.0.113.7' ? 'home' : 'broker'}`)).toEqual(['sensor → broker', 'broker → home', 'broker → home']);
    const reads = readings(s.trips).flatMap((t) => t.steps.flatMap((x) => (x.kind === 'read' ? [x.device] : [])));
    expect(reads).toEqual(['broker', 'laptop', 'phone']);
  });

  it('every app got the same reading, in real bytes', () => {
    const r = sim();
    const value = /([\d.]+)$/.exec(told(r)[0]!)![1];
    expect(told(r)).toEqual([`laptop: home/livingroom/temperature ${value}`, `phone: home/livingroom/temperature ${value}`]);
    expect(Number(value)).toBeGreaterThanOrEqual(18);
    expect(Number(value)).toBeLessThan(24);
    const sent = [...r.pdus.values()].filter((p) => p.layers.some((l) => l.protocol === 'mqtt' && l.summary.startsWith('MQTT PUBLISH')) && p.layers[0]!.protocol === 'wifi');
    expect(sent.length).toBeGreaterThan(0);
    expect(new TextDecoder('latin1').decode(sent[0]!.bytes)).toContain(`home/livingroom/temperature${value}`);
  });

  it('is the same every time with the same seed, and another run reads something else', () => {
    expect(told(sim())).toEqual(told(sim()));
    const values = new Set([1, 2, 3, 4, 5, 6].map((seed) => told(sim({}, {}, seed))[0]));
    expect(values.size).toBeGreaterThan(1);
  });

  it('shows on both screens, and the card says what it is', () => {
    const { s } = run();
    const value = readings(s.trips)[0]!.card!;
    expect(value).toMatch(/^\d\d\.\d °C$/);
    expect(s.screens.laptop!.pageTitle).toBe(value);
    expect(s.screens.phone!.pageTitle).toBe(value);
    expect(s.screens.laptop!.browsing).toBe(false);
  });

  it('tells only what came after the button: everyone was connected already', () => {
    const { s } = run();
    const first = s.trips.flatMap((t) => [t, ...t.steps.flatMap((x) => (x.kind === 'flow' ? x.packets : []))]);
    expect(first.every((t) => t.start >= READING_AT)).toBe(true);
    expect(first.some((t) => t.chapter === 'dns' || t.l4Label === 'SYN')).toBe(false);
  });

  it('that connecting really happened first, for all three, ending subscribed', () => {
    const r = sim();
    for (const device of ['sensor', 'laptop', 'phone']) expect(r.events.some((e) => e.type === 'tcp:state' && e.deviceId === device)).toBe(true);
    const subscribed = r.events.flatMap((e) => (e.type === 'app' && e.action === 'mqtt-subscribed' ? [e] : []));
    expect(subscribed.map((e) => e.deviceId).sort()).toEqual(['laptop', 'phone']);
    expect(Math.max(...subscribed.map((e) => e.t))).toBeLessThan(READING_AT);
  });

  it('also when the connecting is slow: over a satellite, on the longest cable, on a noisy Wi-Fi', () => {
    for (const opts of [{ slow: true }, { wanDelay: 0.042 }, { noise: 0.4 }, { thin: true }]) expect(told(sim(opts))).toHaveLength(2);
  });

  it('comes back in through the NAT the apps opened themselves', () => {
    const { s } = run();
    const down = readings(s.trips).filter((t) => t.origin === 'broker');
    for (const t of down) expect(t.steps.some((x) => x.kind === 'nat' && x.which === 'to')).toBe(true);
  });

  it('the clock starts at the button', () => {
    const { tl } = run();
    expect(realAt(tl, tl.total)).toBeLessThan(1);
  });

  it('the devices say what is happening', () => {
    const { s, tl } = run();
    const lines = buildSpeech(s, tl.segs).map((b) => `${b.device}: ${b.text}`);
    expect(lines).toContain(`sensor: It's ${readings(s.trips)[0]!.card}`);
    expect(lines.filter((l) => l === 'broker: A copy for everyone listening')).toHaveLength(1);
  });

  it('a face shows up on each app as its copy lands', () => {
    const faces = run().tl.reactions.filter((r) => r.face === 'love').map((r) => r.device);
    expect(faces).toEqual(['laptop', 'phone']);
  });

  it('a spy on the line can read it, and so can a stranger on the Wi-Fi', () => {
    const { s, tl } = run({ attacks: ['listen'] as Attack[] });
    const up = crossings(tl).find((c) => c.link === 'wan' && c.trip.message?.kind === 'reading');
    expect(up?.seen?.lines).toEqual(['home/livingroom/temperature', readings(s.trips)[0]!.card]);
    expect(s.heard.some((h) => h.seen.lines.includes(readings(s.trips)[0]!.card!))).toBe(true);
  });

  it('a cut line stops a copy, and TCP sends it again when it can', () => {
    const r = sim({}, { cuts: [{ link: 'lan', from: READING_AT }] });
    expect(told(r).map((x) => x.split(':')[0])).toEqual(['phone']);
    const { s } = run({}, { cuts: [{ link: 'lan', from: READING_AT }] });
    expect(s.trips.some((t) => t.lost)).toBe(true);
  });

  it('a cut before anything has left comes after everyone connected, not before', () => {
    const { tl } = run();
    const from = seenSoFar(tl, 0, 'wan').now;
    expect(from).toBeGreaterThanOrEqual(READING_AT);
    const cut = run({}, { cuts: [{ link: 'wan', from }] });
    expect(cut.s.trips.length).toBeGreaterThan(0);
    expect(cut.tl.total).toBeGreaterThan(0);
  });

  it('a cut on the way to the broker leaves both apps with nothing', () => {
    expect(told(sim({}, { cuts: [{ link: 'wan', from: READING_AT }] }))).toEqual([]);
  });

  it('goes on beside attackers', () => {
    for (const attack of ['flood', 'scan'] as Attack[]) {
      const { s, tl } = run({ attacks: [attack] });
      expect(s.attackers.length).toBeGreaterThan(0);
      expect(tl.total).toBeGreaterThan(0);
      expect(Object.values(s.screens).some((x) => x.pageTitle)).toBe(true);
    }
  });
});

describe('a smart home with nothing to report', () => {
  it('has the sensor and the broker on the table, and a page runs as ever', () => {
    const plain = buildStory(runScenario(fetchWebPage({}), { seed: 1, faults: CLEAN }));
    const smart = buildStory(runScenario(fetchWebPage({ smart: true }), { seed: 1, faults: CLEAN }));
    expect(smart.devices.map((d) => d.id)).toEqual(expect.arrayContaining(['sensor', 'broker']));
    expect(plain.devices.map((d) => d.id)).not.toContain('sensor');
    expect(smart.trips.map((t) => t.card ?? t.l4Label)).toEqual(plain.trips.map((t) => t.card ?? t.l4Label));
  });

  it('a card cannot go on the sensor: it only takes readings', () => {
    const smart = buildStory(runScenario(fetchWebPage({ smart: true }), { seed: 1, faults: CLEAN }));
    expect(smart.devices.find((d) => d.id === 'sensor')!.actions).toEqual(['reading']);
  });
});
