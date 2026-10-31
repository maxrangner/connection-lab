import { describe, expect, it } from 'vitest';
import { fromBase64, toAscii } from './bytes/bytes';
import type { EventOf, SimEventType } from './events/SimEvent';
import type { FaultPlan } from './faults';
import { runScenario, type SimResult } from './run';
import { ADDR, fetchWebPage, type FetchWebPageOptions } from './scenarios/fetchWebPage';
import { parseDns } from './proto/dns';
import { parseIpv4 } from './proto/ipv4';
import { parseWifi } from './proto/wifi';
import { openWgData } from './proto/wireguard';
import { tunnelKeys } from './stack/vpn';
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

describe('HTTPS (a real captured TLS 1.3 session)', () => {
  for (const site of ['example.com', 'info.cern.ch'] as const) {
    describe(site, () => {
      const r = run({ https: true, site });
      const page = () => {
        const got = of(r, 'app').find((e) => e.action === 'http-response-received')!;
        return toAscii(r.pdus.get(got.pduId!)!.bytes);
      };

      it('the server decrypts the request and the browser decrypts the page', () => {
        const req = of(r, 'app').find((e) => e.action === 'http-request-received')!;
        expect(String(req.info?.requestLine)).toMatch(/^GET \/\S* HTTP\/1\.1$/);
        expect(page().startsWith('HTTP/1.1 200 OK')).toBe(true);
        expect(page()).toMatch(/<title>[^<]+<\/title>/i);
        expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
      });

      it('talks on port 443, and every frame to and from the server is TLS', () => {
        const segs = of(r, 'tx').filter((e) => e.linkId === 'bb2').map((e) => r.pdus.get(e.frameId)!);
        const withData = segs.filter((p) => p.layers.some((l) => l.protocol === 'tls'));
        expect(withData.length).toBeGreaterThan(3);
        expect(segs.some((p) => p.layers.some((l) => l.protocol === 'http'))).toBe(false);
        for (const p of withData) for (const l of p.layers) if (l.protocol === 'tls') for (const f of l.fields) expect(f.explain.length).toBeGreaterThan(10);
      });
    });
  }
});

describe('getting over a lost stretch', () => {
  const photo = (faults: Partial<FaultPlan>) => runScenario(fetchWebPage({ site: 'httpbin.org' }), { seed: 1, faults: { randomLoss: 0, manual: [], ...faults }, maxTime: 1000 });
  const doneAt = (r: SimResult) => of(r, 'app').find((e) => e.action === 'done')!.t;
  const clear = photo({});
  const firstData = of(clear, 'tx').find((e) => e.linkId === 'bb2' && e.fromDevice === 'server' && (clear.packets.get(e.packetId)!.tcp?.len ?? 0) > 0)!.start;

  it('after a short outage the whole window comes again within round trips, not one packet per timer', () => {
    for (const gap of [0.5, 2]) {
      const r = photo({ cuts: [{ link: 'bb2', from: firstData, to: firstData + gap }] });
      expect(doneAt(r)).toBeLessThan(firstData + gap + 1.5);
      expect(new Set(of(r, 'tcp:retransmit').map((e) => e.cause))).toContain('recovery');
    }
  });

  it('the timer recovers once a resend is answered', () => {
    const r = photo({ cuts: [{ link: 'bb2', from: firstData, to: firstData + 2 }] });
    const samples = of(r, 'tcp:rtt');
    expect(samples[samples.length - 1]!.rto).toBeLessThan(2);
  });

  it('two holes in one window are filled in round trips too', () => {
    const data = [...clear.packets.values()].filter((p) => (p.tcp?.len ?? 0) > 1000);
    const r = photo({ manual: [2, 3].map((i) => ({ packetId: data[i]!.id, linkId: 'bb2' })) });
    expect(doneAt(r)).toBeLessThan(0.2);
    expect(of(r, 'tcp:retransmit').map((e) => e.cause)).toEqual(['fast', 'recovery']);
  });

  it('after a timeout what the SACK blocks said had arrived is not sent again', () => {
    const data = [...clear.packets.values()].filter((p) => (p.tcp?.len ?? 0) > 1000);
    const lose = [20, 22, 24].map((i) => ({ packetId: data[i]!.id, linkId: 'bb2' }));
    // Three holes near the end: the fast retransmit would mend the first, so lose that too and leave it to the timer.
    const fast = of(photo({ manual: lose }), 'tcp:retransmit').find((e) => e.cause === 'fast')!;
    const r = photo({ manual: [...lose, { packetId: fast.packetId, linkId: 'bb2' }] });
    expect(of(r, 'tcp:retransmit').map((e) => e.cause)).toEqual(['fast', 'rto', 'recovery', 'recovery', 'recovery']);
    const resent = [...r.packets.values()].filter((p) => p.retransmitOf).map((p) => p.tcp!.relSeq);
    for (const i of [21, 23]) expect(resent).not.toContain(data[i]!.tcp!.relSeq);
    for (const i of [20, 22, 24]) expect(resent).toContain(data[i]!.tcp!.relSeq);
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
  });
});

describe('a name the resolver does not know', () => {
  const scenario = fetchWebPage();
  const dns = scenario.devices.find((d) => d.id === 'resolver')!.apps[0]!;
  if (dns.kind === 'dns-server') dns.records = {};
  const r = runScenario(scenario, { seed: 1, faults: { randomLoss: 0, manual: [] } });

  it('is answered with NXDOMAIN (rcode 3, no answers), and the browser gives up without connecting', () => {
    const resp = of(r, 'tx').find((e) => e.linkId === 'bb1' && r.packets.get(e.packetId)!.label.startsWith('DNS response'))!;
    const pdu = r.pdus.get(resp.frameId)!;
    const msg = parseDns(pdu.bytes, pdu.layers.find((l) => l.protocol === 'dns')!.start);
    expect(msg.flags).toBe(0x8183);
    expect(msg.rcode).toBe(3);
    expect(msg.answers).toHaveLength(0);
    const actions = of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions).toEqual(['laptop:start', 'laptop:dns-lookup', 'resolver:dns-serve', 'laptop:dns-answer', 'laptop:error']);
    expect(of(r, 'app').find((e) => e.action === 'error')?.info?.reason).toBe('no such name');
    expect([...r.packets.values()].some((p) => p.kind === 'tcp')).toBe(false);
  });
});

describe('a cut cable', () => {
  const cutRun = (cuts: { link: string; from: number; to?: number }[], opts: FetchWebPageOptions = {}) =>
    runScenario(fetchWebPage(opts), { seed: 1, faults: { randomLoss: 0, manual: [], cuts }, maxTime: 1000 });
  const sentAt = (r: SimResult, pick: (l: string) => boolean) => of(r, 'tx').filter((e) => pick(r.packets.get(e.packetId)!.label) && e.linkId === 'bb2').map((e) => e.start);

  it('loses everything sent on it; SYN resends back off 1, 2, 4 ... s until the laptop gives up', () => {
    const r = cutRun([{ link: 'bb2', from: 0 }]);
    const syn = sentAt(r, (l) => /^SYN/.test(l) || /SYN/.test(l));
    expect(syn).toHaveLength(7); // the SYN and Linux's 6 retries
    const gaps = syn.slice(1).map((t, i) => Math.round(t - syn[i]!));
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32]);
    expect(of(r, 'drop').every((d) => d.reason === 'cut')).toBe(true);
    const err = of(r, 'app').find((e) => e.action === 'error');
    expect(err?.info?.reason).toBe('connection timed out');
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(false);
  });

  it('mended in time: the next resend gets through and the page loads', () => {
    const r = cutRun([{ link: 'bb2', from: 0, to: 3 }]);
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
    expect(of(r, 'drop').length).toBeGreaterThan(0);
  });

  it('does not matter if the traffic does not use it', () => {
    const r = cutRun([{ link: 'bb1', from: 0 }], { revisit: true });
    expect(of(r, 'drop')).toHaveLength(0);
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
  });

  it('cut at the laptop from the start, the DNS question is what falls (with ARP warm)', () => {
    const r = cutRun([{ link: 'lan', from: 0 }], { warmArp: true });
    expect(of(r, 'drop').map((d) => r.packets.get(d.packetId)!.kind)).toEqual(['dns', 'dns']);
    expect(of(r, 'app').find((e) => e.action === 'error')?.info?.reason).toBe('DNS lookup timed out');
  });
});

describe('VPN (a WireGuard tunnel)', () => {
  const r = run({ vpn: true });
  const frames = (link: string) => of(r, 'tx').filter((e) => e.linkId === link).map((e) => r.pdus.get(e.frameId)!);

  it('still looks up the address and loads the page, http and https, laptop and phone', () => {
    for (const o of [{}, { https: true }, { from: 'phone' as const }, { site: 'info.cern.ch' as const }]) {
      const x = run({ vpn: true, ...o });
      expect(of(x, 'app').some((e) => e.action === 'done')).toBe(true);
      expect(of(x, 'app').find((e) => e.action === 'dns-answer')).toBeTruthy();
    }
  });

  it('on the home side and at the ISP every frame is just UDP to the VPN server', () => {
    for (const link of ['lan', 'wan', 'bb3']) {
      expect(frames(link).length).toBeGreaterThan(8);
      for (const f of frames(link)) {
        expect(f.layers.map((l) => l.protocol).slice(1).filter((p) => p !== 'arp')).toEqual(f.first === 'ethernet' && f.layers[1]?.protocol === 'arp' ? [] : ['ipv4', 'udp', 'wireguard']);
      }
    }
  });

  it('the ISP never handles an opened packet: what the VPN server sends on takes its own cables', () => {
    for (const o of [{}, { https: true }, { from: 'phone' as const }, { site: 'httpbin.org' as const }]) {
      const x = run({ vpn: true, ...o });
      const crossed = new Set(of(x, 'tx').map((e) => e.linkId));
      for (const link of ['bb4', 'bb5']) expect(crossed.has(link)).toBe(true);
      for (const link of ['bb1', 'bb2']) expect(crossed.has(link)).toBe(false);
      for (const e of of(x, 'tx').filter((f) => f.fromDevice === 'isp' || f.toDevice === 'isp')) {
        expect(x.pdus.get(e.frameId)!.layers.some((l) => l.protocol === 'wireguard')).toBe(true);
      }
    }
  });

  it('the real sealed bytes open with the session key: inside is a packet to the real destination', () => {
    const f = frames('wan').find((x) => x.layers.some((l) => l.protocol === 'wireguard'))!;
    const wg = f.layers.find((l) => l.protocol === 'wireguard')!;
    const opened = openWgData(tunnelKeys(1).up, f.bytes.slice(wg.start, wg.end))!;
    const ip = parseIpv4(opened, 0);
    expect(ip.src).toBe(ADDR.vpn.tunnelIp);
    expect(ip.dst).toBe(ADDR.resolver.ip);
  });

  it('past the VPN server packets are ordinary again, from its address, so the web server never sees the home address', () => {
    const toServer = frames('bb4').filter((f) => f.layers.some((l) => l.protocol === 'http'));
    expect(toServer.length).toBeGreaterThan(0);
    for (const f of frames('bb4')) {
      const ip = f.layers.find((l) => l.protocol === 'ipv4')!;
      const addrs = ip.fields.filter((x) => /ipv4\.(src|dst)/.test(x.key)).map((x) => x.display);
      expect(addrs).toContain(ADDR.vpn.ip);
      expect(addrs).not.toContain(ADDR.homeWan.ip);
    }
  });

  it('every WireGuard field has an explanation, and a lost sealed packet is resent', () => {
    const f = frames('wan').find((x) => x.layers.some((l) => l.protocol === 'wireguard'))!;
    for (const x of f.layers.find((l) => l.protocol === 'wireguard')!.fields) expect(x.explain.length).toBeGreaterThan(10);
    const get = [...r.packets.values()].find((p) => p.tcp && p.tcp.len > 0)!;
    const lost = run({ vpn: true }, { randomLoss: 0, manual: [{ packetId: get.id, linkId: 'wan' }] });
    expect(of(lost, 'tcp:retransmit').length).toBeGreaterThan(0);
    expect(of(lost, 'app').some((e) => e.action === 'done')).toBe(true);
  });
});

describe('several lines at once', () => {
  it('cuts each keep to their own lines and times', () => {
    const r = runScenario(fetchWebPage({ revisit: true }), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'bb1', from: 0 }, { link: 'bb2', from: 0, to: 2 }] }, maxTime: 1000 });
    expect(of(r, 'drop').length).toBeGreaterThan(0);
    expect(of(r, 'drop').every((d) => d.linkId === 'bb2')).toBe(true);
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
  });
});
