import { describe, expect, it } from 'vitest';
import { fetchWebPage, OFFLINE_AT, READING_AT, runScenario, type Attack, type SimResult } from '../sim';
import { buildStory, type Story, type Trip } from './story';
import { buildTimeline, crossings, realAt, seenSoFar, type Timeline } from './timeline';
import { buildSpeech } from './speech';

const CLEAN = { randomLoss: 0, manual: [] };
const sim = (opts: object = {}, faults: object = {}, seed = 1): SimResult => runScenario(fetchWebPage({ reading: true, cloud: true, ...opts }), { seed, faults: { ...CLEAN, ...faults }, maxTime: 1000 });
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
    expect(smart.devices.map((d) => d.id)).toEqual(expect.arrayContaining(['sensor', 'local-broker']));
    expect(plain.devices.map((d) => d.id)).not.toContain('sensor');
    expect(smart.trips.map((t) => t.card ?? t.l4Label)).toEqual(plain.trips.map((t) => t.card ?? t.l4Label));
  });

  it('a card cannot go on the sensor: it only takes readings', () => {
    const smart = buildStory(runScenario(fetchWebPage({ smart: true }), { seed: 1, faults: CLEAN }));
    expect(smart.devices.find((d) => d.id === 'sensor')!.actions).toEqual(['reading']);
  });
});

describe('a broker at home', () => {
  const home = (opts: object = {}, faults: object = {}): SimResult => runScenario(fetchWebPage({ reading: true, ...opts }), { seed: 1, faults: { ...CLEAN, ...faults }, maxTime: 1000 });
  const trips = (opts: object = {}): Trip[] => readings(buildStory(home(opts)).trips);
  const links = (t: Trip): string[] => t.steps.flatMap((x) => (x.kind === 'travel' ? [x.link] : []));

  it('the reading goes to the broker, and from it to each app, and never leaves the house', () => {
    const r = home();
    expect(told(r).map((x) => x.split(':')[0])).toEqual(['laptop', 'phone']);
    expect(trips().map(links)).toEqual([['wlan2', 'lan2'], ['lan2', 'lan'], ['lan2', 'wlan']]);
    expect(r.events.some((e) => e.type === 'tx' && e.linkId === 'wan')).toBe(false);
  });

  it('the router only switches: no NAT, no route, the TTL as it was', () => {
    const r = home();
    const after = r.events.filter((e) => 't' in e && e.t >= READING_AT);
    expect(after.some((e) => e.type === 'nat:translate')).toBe(false);
    expect(after.some((e) => e.type === 'forward' && e.deviceId === 'home')).toBe(false);
    const ttl = (link: string): string[] =>
      r.events.flatMap((e) => (e.type === 'tx' && e.linkId === link && r.packets.get(e.packetId)!.label === 'MQTT PUBLISH' ? [r.pdus.get(e.frameId)!.layers.find((l) => l.protocol === 'ipv4')!.fields.find((f) => f.key === 'ipv4.ttl')!.display] : []));
    expect(new Set([...ttl('wlan2'), ...ttl('lan2')]).size).toBe(1);
  });

  it('a frame keeps the sender\'s and the receiver\'s hardware addresses as the router passes it on', () => {
    const r = home();
    const macs = (link: string): string[] => {
      const e = r.events.find((x) => x.type === 'tx' && x.linkId === link && r.packets.get(x.packetId)!.label === 'MQTT PUBLISH');
      const frame = e?.type === 'tx' ? r.pdus.get(e.frameId)! : undefined;
      return frame!.layers[0]!.fields.filter((f) => /eth\.(src|dst)/.test(f.key)).map((f) => f.display.split(' ')[0]!);
    };
    expect(macs('lan2')).toEqual(['dc:a6:32:5e:7b:10', '84:f3:eb:2c:41:9e']);
  });

  it('every frame on the way still checks out', () => {
    const r = home();
    for (const e of r.events) if (e.type === 'drop' && e.t >= READING_AT) expect(e.reason).not.toBe('bad-checksum');
  });

  it('nothing shows the broker before the run needs it, and it is not one of your own', () => {
    const s = buildStory(home());
    expect(s.devices.find((d) => d.id === 'local-broker')!.actions).toEqual([]);
    expect(s.clients).toEqual(['sensor', 'laptop', 'phone']);
  });

  it('a stranger on the Wi-Fi still hears it', () => {
    expect(buildStory(home({ attacks: ['listen'] })).heard.length).toBeGreaterThan(0);
  });

  it('a page goes out by the router as ever with a smart home on', () => {
    const plain = buildStory(runScenario(fetchWebPage({}), { seed: 1, faults: CLEAN }));
    const smart = buildStory(runScenario(fetchWebPage({ smart: true }), { seed: 1, faults: CLEAN }));
    expect(smart.trips.map((t) => t.card ?? t.l4Label)).toEqual(plain.trips.map((t) => t.card ?? t.l4Label));
  });

  it('runs on a noisy Wi-Fi too', () => {
    expect(told(home({ noise: 0.4 }))).toHaveLength(2);
  });
});

const onWire = (r: SimResult): string[] => {
  const seen = new Set<string>();
  return r.events.flatMap((e) => {
    if (e.type !== 'tx' || seen.has(e.packetId)) return [];
    seen.add(e.packetId);
    const p = r.packets.get(e.packetId)!;
    return p.createdAt >= READING_AT && p.label.startsWith('MQTT') ? [`${e.fromDevice} ${p.label.slice(5)}`] : [];
  });
};

describe('how sure a reading is of arriving', () => {
  const run = (opts: object = {}, faults: object = {}): SimResult => runScenario(fetchWebPage({ reading: true, ...opts }), { seed: 1, faults: { ...CLEAN, ...faults }, maxTime: 1000 });

  it('QoS 0: sent once, on every leg, and nobody answers', () => {
    expect(onWire(run({ qos: 0 }))).toEqual(['sensor PUBLISH', 'local-broker PUBLISH', 'local-broker PUBLISH']);
  });

  it('QoS 1: each leg is answered with a PUBACK', () => {
    expect(onWire(run({ qos: 1 })).sort()).toEqual(['laptop PUBACK', 'local-broker PUBACK', 'local-broker PUBLISH', 'local-broker PUBLISH', 'phone PUBACK', 'sensor PUBLISH']);
  });

  it('QoS 2: four steps on each leg, and the broker passes it on only once it is released', () => {
    const wire = onWire(run({ qos: 2 }));
    expect(wire.slice(0, 4)).toEqual(['sensor PUBLISH', 'local-broker PUBREC', 'sensor PUBREL', 'local-broker PUBCOMP']);
    expect(wire.slice(4).filter((x) => x.startsWith('local-broker PUBLISH'))).toHaveLength(2);
    for (const app of ['laptop', 'phone']) {
      expect(wire).toContain(`${app} PUBREC`);
      expect(wire).toContain(`${app} PUBCOMP`);
    }
    expect(wire.filter((x) => x === 'local-broker PUBREL')).toHaveLength(2);
    expect(wire).toHaveLength(12);
  });

  it('every app gets it once, at every level, in the cloud too', () => {
    for (const qos of [0, 1, 2] as const) for (const cloud of [false, true]) expect(told(run({ qos, cloud })).map((x) => x.split(':')[0])).toEqual(['laptop', 'phone']);
  });

  it('the sensor\'s own exchange is told in full, and the same steps with each app as small blocks', () => {
    const s = buildStory(run({ qos: 2 }));
    const whole = s.trips.filter((t) => t.message?.kind === 'mqtt-control' && !t.steps.some((x) => x.kind === 'flow'));
    expect(whole.map((t) => t.card)).toEqual(['PUBREC', 'PUBREL', 'PUBCOMP']);
    const small = s.trips.flatMap((t) => t.steps.flatMap((x) => (x.kind === 'flow' ? x.packets : []))).filter((t) => t.message?.kind === 'mqtt-control');
    expect(small.map((t) => t.card).sort()).toEqual(['PUBCOMP', 'PUBCOMP', 'PUBREC', 'PUBREC', 'PUBREL', 'PUBREL']);
  });

  it('a TCP ACK and a PUBACK are different things, and both go by', () => {
    const r = run({ qos: 1 });
    const fromBroker = r.events.flatMap((e) => (e.type === 'tx' && e.fromDevice === 'local-broker' && r.packets.get(e.packetId)!.createdAt >= READING_AT ? [r.packets.get(e.packetId)!.label] : []));
    expect(fromBroker.slice(0, 2)).toEqual(['ACK', 'MQTT PUBACK']);
  });

  it('what it says in each step comes from the devices', () => {
    const s = buildStory(run({ qos: 1 }));
    const tl = buildTimeline(s);
    expect(buildSpeech(s, tl.segs).map((b) => b.text)).toContain('Got it');
  });

  it('a short run with no packets lost has no call for keep-alive', () => {
    const r = run({ qos: 2 });
    expect([...r.packets.values()].some((p) => p.createdAt >= READING_AT && /PING/.test(p.label))).toBe(false);
  });
});

describe('an app that is away', () => {
  const offline = { cuts: [{ link: 'lan', from: OFFLINE_AT }] };
  const mended = (to: number) => ({ cuts: [{ link: 'lan', from: OFFLINE_AT, to }] });
  const run = (qos: 0 | 1 | 2, faults: object): SimResult => runScenario(fetchWebPage({ reading: true, qos }), { seed: 1, faults: { ...CLEAN, ...faults }, maxTime: 1000 });
  const actions = (r: SimResult, action: string): string[] => r.events.flatMap((e) => (e.type === 'app' && e.action === action ? [e.deviceId] : []));
  const heardBy = (r: SimResult): string[] => told(r).map((x) => x.split(':')[0]!);

  it('with its cable cut a while ago, both ends have noticed by the time of the reading', () => {
    const r = run(1, offline);
    const when = r.events.filter((e) => e.type === 'app' && e.action === 'mqtt-offline').map((e) => e.t);
    expect(actions(r, 'mqtt-offline').sort()).toEqual(['laptop', 'local-broker']);
    expect(Math.max(...when)).toBeLessThan(READING_AT);
  });

  it('QoS 0: the laptop never gets that reading, even when the cable is mended', () => {
    const r = run(0, mended(READING_AT + 1));
    expect(heardBy(r)).toEqual(['phone']);
    expect(actions(r, 'mqtt-missed')).toEqual(['local-broker']);
    expect(actions(r, 'mqtt-back')).toEqual(['laptop']);
  });

  for (const qos of [1, 2] as const) {
    it(`QoS ${qos}: the broker keeps it, and the laptop gets it once it is back, once`, () => {
      const r = run(qos, mended(READING_AT + 1));
      expect(actions(r, 'mqtt-held')).toEqual(['local-broker']);
      expect(heardBy(r)).toEqual(['phone', 'laptop']);
      const [phone, laptop] = told(r);
      expect(laptop!.split(' ').at(-1)).toBe(phone!.split(' ').at(-1));
    });

    it(`QoS ${qos}: while the cable stays cut the broker keeps waiting`, () => {
      const r = run(qos, offline);
      expect(heardBy(r)).toEqual(['phone']);
      expect(actions(r, 'mqtt-back')).toEqual([]);
    });
  }

  it('the session lasted: back again, the app does not have to subscribe', () => {
    const r = run(1, mended(READING_AT + 1));
    const again = [...r.packets.values()].filter((p) => p.createdAt >= READING_AT && p.label.startsWith('MQTT') && p.origin === 'laptop').map((p) => p.label);
    expect(again).toContain('MQTT CONNECT');
    expect(again).not.toContain('MQTT SUBSCRIBE');
  });

  it('the story shows the laptop trying, coming back, and the reading landing', () => {
    const s = buildStory(run(1, mended(READING_AT + 1)));
    const all = s.trips.flatMap((t) => (t.steps.some((x) => x.kind === 'flow') ? t.steps.flatMap((x) => (x.kind === 'flow' ? x.packets : [])) : [t]));
    expect(all.some((t) => t.origin === 'laptop' && t.l4Label === 'SYN')).toBe(true);
    expect(all.some((t) => t.card === 'CONNECT')).toBe(true);
    expect(s.screens.laptop!.pageTitle).toBe(s.screens.phone!.pageTitle);
    expect(buildTimeline(s).total).toBeGreaterThan(0);
  });

  it('with QoS 0 the laptop comes back with nothing on its screen', () => {
    const s = buildStory(run(0, mended(READING_AT + 1)));
    expect(s.screens.laptop!.pageTitle).toBeNull();
    expect(s.screens.phone!.pageTitle).toMatch(/°C/);
  });

  it('a broker with its cable cut: QoS 0 is lost at the sensor, and QoS 1 waits there', () => {
    const cut = { cuts: [{ link: 'lan2', from: OFFLINE_AT, to: READING_AT + 1 }] };
    expect(told(run(0, cut))).toEqual([]);
    const r = run(1, cut);
    expect(heardBy(r).sort()).toEqual(['laptop', 'phone']);
  });

  it('a cut once a reading is under way is only a late packet: TCP sends it again, at any QoS', () => {
    for (const qos of [0, 1] as const) expect(heardBy(run(qos, { cuts: [{ link: 'lan', from: READING_AT, to: READING_AT + 1.5 }] })).sort()).toEqual(['laptop', 'phone']);
  });

  it('the run comes to an end if nobody mends the cable', () => {
    const r = run(1, offline);
    expect(r.endTime).toBeLessThan(200);
  });
});
