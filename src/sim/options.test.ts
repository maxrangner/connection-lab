import { describe, expect, it } from 'vitest';
import { fromBase64, toAscii } from './bytes/bytes';
import type { EventOf, SimEventType } from './events/SimEvent';
import type { FaultPlan } from './faults';
import { runScenario, type SimResult } from './run';
import { ADDR, fetchWebPage, type FetchWebPageOptions } from './scenarios/fetchWebPage';
import { parseWifi } from './proto/wifi';
import { CERN_HTTP_RESPONSE_BASE64, CERN_IP } from './scenarios/infoCernCapture';

const run = (opts: FetchWebPageOptions, faults: FaultPlan = { randomLoss: 0, manual: [] }, seed = 1): SimResult =>
  runScenario(fetchWebPage(opts), { seed, faults });

const of = <T extends SimEventType>(r: SimResult, type: T): EventOf<T>[] => r.events.filter((e) => e.type === type) as EventOf<T>[];

describe('the first website (info.cern.ch)', () => {
  const r = run({ site: 'info.cern.ch' });

  it('looks up info.cern.ch and fetches the exact captured page', () => {
    expect(of(r, 'app').find((e) => e.action === 'dns-answer')?.info?.addresses).toEqual([CERN_IP]);
    const got = of(r, 'app').find((e) => e.action === 'http-response-received')!;
    expect(toAscii(r.pdus.get(got.pduId!)!.bytes)).toBe(toAscii(fromBase64(CERN_HTTP_RESPONSE_BASE64)));
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
  });

  it('needs more than one packet for the reply', () => {
    const fromServer = [...r.packets.values()].filter((p) => p.origin === 'server' && p.tcp && p.tcp.len > 0);
    expect(fromServer.length).toBeGreaterThanOrEqual(2);
    expect(fromServer.every((p) => p.tcp!.len <= 1460)).toBe(true);
  });
});

describe('visiting again', () => {
  const r = run({ revisit: true });

  it('skips the DNS lookup and ARP: the address and MACs are still cached', () => {
    const actions = of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions).toContain('laptop:dns-cache-hit');
    expect(actions).not.toContain('laptop:dns-lookup');
    expect([...r.packets.values()].filter((p) => p.kind === 'arp' || p.kind === 'dns')).toHaveLength(0);
    expect(actions).toContain('laptop:done');
  });
});

describe('random loss limited to some links', () => {
  it('never drops on links outside the lossy set', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = run({}, { randomLoss: 0.3, manual: [], lossyLinks: ['wan', 'bb1', 'bb2'] }, seed);
      for (const d of of(r, 'drop')) if (d.reason === 'fault') expect(['wan', 'bb1', 'bb2']).toContain(d.linkId);
    }
  });
});

describe('satellite line', () => {
  const r = run({ slow: true });

  it('still loads the page, with no resends despite the long delay', () => {
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
    expect(of(r, 'tcp:retransmit')).toHaveLength(0);
  });

  it('takes about 280 ms each way across the satellite hop', () => {
    const tx = of(r, 'tx').find((e) => e.linkId === 'wan')!;
    expect(tx.arrive - tx.start).toBeGreaterThan(0.28);
    expect(tx.arrive - tx.start).toBeLessThan(0.29);
  });
});

describe('phone over Wi-Fi', () => {
  const r = run({ from: 'phone' });
  const frames = (link: string) => of(r, 'tx').filter((e) => e.linkId === link).map((e) => r.pdus.get(e.frameId)!);

  it('loads the page from the phone; the laptop stays quiet', () => {
    const actions = of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions).toContain('phone:done');
    expect(actions.some((a) => a.startsWith('laptop:'))).toBe(false);
    expect(of(r, 'tx').some((e) => e.linkId === 'lan')).toBe(false);
  });

  it('sends real 802.11 data frames over the air, with valid checksums and the right addresses', () => {
    const air = frames('wlan');
    expect(air.length).toBeGreaterThan(4);
    for (const f of air) {
      expect(f.first).toBe('wifi');
      const w = parseWifi(f.bytes);
      expect(w.fcsValid).toBe(true);
      if (w.toAp) {
        // Up: receiver is the access point (the router's Wi-Fi MAC), transmitter the phone.
        expect(w.addr1).toBe(ADDR.homeWlan.mac);
        expect(w.addr2).toBe(ADDR.phone.mac);
      } else {
        expect(w.addr2).toBe(ADDR.homeWlan.mac);
      }
    }
    const dns = air.find((f) => f.layers.some((l) => l.protocol === 'dns'))!;
    expect(dns.layers.map((l) => l.protocol)).toEqual(['wifi', 'ipv4', 'udp', 'dns']);
    expect(dns.layers[0]!.headerEnd).toBe(32);
  });

  it('the home router swaps the Wi-Fi frame for an Ethernet one and NATs the phone address', () => {
    for (const f of frames('wan')) expect(f.first).toBe('ethernet');
    const nat = of(r, 'nat:translate').find((e) => e.direction === 'out')!;
    expect(nat.before.ip).toBe(ADDR.phone.ip);
    expect(nat.after.ip).toBe(ADDR.homeWan.ip);
  });

  it('every Wi-Fi field has an explanation', () => {
    for (const f of frames('wlan')) for (const fld of f.layers[0]!.fields) expect(fld.explain.length).toBeGreaterThan(10);
  });
});
