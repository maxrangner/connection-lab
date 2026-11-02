import { describe, expect, it } from 'vitest';
import { fromBase64, toAscii } from './bytes/bytes';
import type { PduSnapshot } from './core/Simulator';
import type { EventOf, SimEventType } from './events/SimEvent';
import type { FaultPlan } from './faults';
import { runScenario, type SimResult } from './run';
import { ADDR, fetchWebPage, THIN_BPS, THIN_QUEUE, type FetchWebPageOptions } from './scenarios/fetchWebPage';
import { PHOTO_HTTP_RESPONSE_BASE64 } from './scenarios/photoCapture';
import { parseDhcp } from './proto/dhcp';
import { DNS_TRACES } from './scenarios/dnsTraceCapture';
import { dnsReferral, parseDns } from './proto/dns';
import { ICMP_DEST_UNREACHABLE, ICMP_ECHO, ICMP_ECHO_REPLY, ICMP_TIME_EXCEEDED, parseIcmp, pingTimestamp } from './proto/icmp';
import { parseIpv4 } from './proto/ipv4';
import { parseRtp, RTP_HEADER_LEN, RTP_PORT, RTP_SAMPLES_PER_PACKET } from './proto/rtp';
import type { Field } from './proto/types';
import { parseUdp } from './proto/udp';
import { VOICE_CLIP_CALLER_BASE64, VOICE_CLIP_FRIEND_BASE64 } from './scenarios/voiceClip';
import { parseWifi, parseWifiAck, WIFI_ACK_LEN, WIFI_ACK_TIMEOUT, WIFI_FC_ACK, WIFI_RETRY_LIMIT, WIFI_SIFS, WIFI_SLOT } from './proto/wifi';
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

describe('noisy Wi-Fi: 802.11 Acks and link-layer retries', () => {
  const noisy = (opts: FetchWebPageOptions = {}, seed = 10) => runScenario(fetchWebPage({ from: 'phone', noise: 0.5, ...opts }), { seed, faults: { randomLoss: 0, manual: [] }, maxTime: 1000 });
  const r = noisy();
  const plain = run({ from: 'phone' });
  const isAck = (x: SimResult, packetId: string) => x.packets.get(packetId)!.kind === 'wifi-ack';
  const onAir = (x: SimResult) => of(x, 'tx').filter((e) => e.linkId === 'wlan');
  const macOf = (x: SimResult, device: string) => x.scenario.devices.find((d) => d.id === device)!.ifaces.find((i) => i.wifi)!.mac;

  it('every data frame that gets across is answered by a real 14-byte Ack, SIFS (10 µs at 2.4 GHz) after its last bit', () => {
    const delivered = of(r, 'rx').filter((e) => e.linkId === 'wlan' && !isAck(r, e.packetId));
    expect(delivered.length).toBeGreaterThan(8);
    for (const rx of delivered) {
      const data = parseWifi(r.pdus.get(rx.frameId)!.bytes);
      // Only a frame addressed to this radio is acknowledged; one to everyone is not.
      if (data.addr1 !== macOf(r, rx.deviceId)) continue;
      const ack = onAir(r).find((e) => e.fromDevice === rx.deviceId && isAck(r, e.packetId) && e.start >= rx.t)!;
      expect(ack.start - rx.t).toBeCloseTo(WIFI_SIFS, 9);
      const frame = r.pdus.get(ack.frameId)!;
      expect(frame.bytes.length).toBe(WIFI_ACK_LEN);
      expect(frame.bytes[0]).toBe(WIFI_FC_ACK);
      expect(frame.first).toBe('wifi');
      expect(frame.layers.map((l) => l.summary)).toEqual([`Wi-Fi ACK → ${data.addr2}`]);
      expect(parseWifiAck(frame.bytes)).toEqual({ ra: data.addr2, fcsValid: true });
      expect(r.packets.get(ack.packetId)).toMatchObject({ kind: 'wifi-ack', label: 'Wi-Fi ACK', origin: rx.deviceId });
    }
    expect(onAir(r).filter((e) => isAck(r, e.packetId)).length).toBeGreaterThan(8);
  });

  it('frames fall to interference, the sender tries the same frame again with the Retry bit and the same sequence number, and the page still comes', () => {
    const lost = of(r, 'drop').filter((d) => d.reason === 'interference');
    expect(lost.length).toBeGreaterThan(0);
    for (const d of lost) expect(d).toMatchObject({ linkId: 'wlan', deviceId: expect.stringMatching(/^(phone|home)$/), frameId: expect.any(String) });
    const retries = of(r, 'wifi:retry');
    expect(retries.length).toBeGreaterThan(0);
    for (const e of retries) {
      const again = parseWifi(r.pdus.get(e.frameId)!.bytes);
      const first = parseWifi(r.pdus.get(onAir(r).find((t) => t.packetId === e.packetId)!.frameId)!.bytes);
      expect(again.retry).toBe(true);
      expect(first.retry).toBe(false);
      expect(r.pdus.get(e.frameId)!.bytes[1]! & 0x08).toBe(0x08);
      expect(again.seq).toBe(first.seq);
      expect(again.fcsValid).toBe(true);
      expect(e.attempt).toBeGreaterThanOrEqual(1);
      expect(e.attempt).toBeLessThanOrEqual(WIFI_RETRY_LIMIT);
      // The copy goes on the air right after the retry event, and it is the frame the event names.
      const tx = of(r, 'tx').find((t) => t.frameId === e.frameId)!;
      expect(tx).toMatchObject({ linkId: 'wlan', fromDevice: e.deviceId, packetId: e.packetId });
      expect(tx.start - e.t).toBeLessThan(1e-4);
    }
    // The first retry comes after the Ack timeout (50 µs from the last bit) plus a backoff of whole 9 µs slots.
    const first = retries[0]!;
    const before = of(r, 'tx').filter((t) => t.packetId === first.packetId && t.linkId === 'wlan' && t.start < first.t).at(-1)!;
    expect(first.backoff / WIFI_SLOT).toBeCloseTo(Math.round(first.backoff / WIFI_SLOT), 6);
    expect(first.t).toBeCloseTo(before.txEnd + WIFI_ACK_TIMEOUT + first.backoff, 9);
    expect(of(r, 'wifi:ack').length).toBeGreaterThan(8);
    expect(of(r, 'app').some((e) => e.deviceId === 'phone' && e.action === 'done')).toBe(true);
    expect(of(r, 'drop').filter((d) => d.reason === 'retry-limit')).toHaveLength(0);
  });

  it('a lost Ack makes the sender send the frame again although it arrived: the receiver drops the copy by its sequence number', () => {
    const lostAcks = of(r, 'drop').filter((d) => d.reason === 'interference' && isAck(r, d.packetId));
    expect(lostAcks.length).toBeGreaterThan(0);
    let shown = 0;
    for (const d of lostAcks) {
      const ack = r.packets.get(d.packetId)!;
      const acked = of(r, 'rx').filter((e) => e.linkId === 'wlan' && e.deviceId === ack.origin && !isAck(r, e.packetId) && e.t <= d.t).at(-1)!;
      const dup = of(r, 'drop').find((x) => x.reason === 'duplicate-frame' && x.deviceId === ack.origin && x.packetId === acked.packetId && x.t > d.t);
      if (!dup) continue;
      shown++;
      expect(parseWifi(r.pdus.get(dup.frameId!)!.bytes).retry).toBe(true);
      // The copy was still acknowledged, or the sender would keep trying.
      expect(onAir(r).some((e) => e.fromDevice === ack.origin && isAck(r, e.packetId) && Math.abs(e.start - dup.t - WIFI_SIFS) < 1e-9)).toBe(true);
    }
    expect(shown).toBeGreaterThan(0);
    for (const dup of of(r, 'drop').filter((x) => x.reason === 'duplicate-frame')) expect(dup).toMatchObject({ linkId: 'wlan', frameId: expect.any(String) });
  });

  it('noise 1: every frame is lost, each tried 7 more times with a doubling window, then given up; DNS times out as usual', () => {
    const x = noisy({ noise: 1 });
    expect(of(x, 'rx').filter((e) => e.linkId === 'wlan')).toHaveLength(0);
    expect([...x.packets.values()].filter((p) => p.kind === 'wifi-ack')).toHaveLength(0);
    const byPacket = new Map<string, EventOf<'wifi:retry'>[]>();
    for (const e of of(x, 'wifi:retry')) byPacket.set(e.packetId, [...(byPacket.get(e.packetId) ?? []), e]);
    expect(byPacket.size).toBeGreaterThan(0);
    for (const [packetId, tries] of byPacket) {
      expect(tries.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      // Backoff i is drawn from 0..CW with CW 15, 31, 63 ... 1023 slots of 9 µs.
      tries.forEach((e, i) => expect(e.backoff).toBeLessThanOrEqual((2 ** (i + 4) - 1) * WIFI_SLOT + 1e-12));
      const gaveUp = of(x, 'drop').find((d) => d.reason === 'retry-limit' && d.packetId === packetId)!;
      expect(gaveUp).toMatchObject({ deviceId: tries[0]!.deviceId, linkId: 'wlan', frameId: tries[6]!.frameId });
      expect(gaveUp.t).toBeGreaterThan(tries[6]!.t);
    }
    expect(of(x, 'drop').filter((d) => d.reason === 'retry-limit')).toHaveLength(byPacket.size);
    expect(of(x, 'app').map((e) => `${e.deviceId}:${e.action}`)).toEqual(['phone:start', 'phone:dns-lookup', 'phone:dns-lookup', 'phone:error']);
    expect(of(x, 'app').at(-1)!.info?.reason).toBe('DNS lookup timed out');
  });

  it('with noise 0 nothing changes: no Acks, no radio events, the phone and laptop runs byte for byte as before', () => {
    const quiet = [plain, run({ from: 'phone', noise: 0 }), run({}), run({ noise: 0.5 }), run({ site: 'connection-lab.rangner.com', noise: 0 })];
    for (const x of quiet) {
      expect([...x.packets.values()].some((p) => p.kind === 'wifi-ack')).toBe(false);
      expect(of(x, 'wifi:retry')).toHaveLength(0);
      expect(of(x, 'wifi:ack')).toHaveLength(0);
      expect(of(x, 'drop').filter((d) => ['interference', 'duplicate-frame', 'retry-limit'].includes(d.reason))).toHaveLength(0);
    }
    expect(JSON.stringify(quiet[1]!.events)).toBe(JSON.stringify(plain.events));
    // Noise on a run from the laptop changes nothing: nobody is on the Wi-Fi.
    expect(JSON.stringify(quiet[3]!.events)).toBe(JSON.stringify(quiet[2]!.events));
    const frames = (x: SimResult) => of(x, 'tx').map((e) => [e.linkId, e.fromDevice, Array.from(x.pdus.get(e.frameId)!.bytes)]);
    expect(frames(quiet[1]!)).toEqual(frames(plain));
  });

  it('is deterministic, decided by hash: the same seed gives the same run, and up to the first loss the same frames go as with a quiet radio', () => {
    expect(JSON.stringify(noisy().events)).toBe(JSON.stringify(r.events));
    expect(JSON.stringify(noisy({}, 2).events)).not.toBe(JSON.stringify(r.events));
    const firstLoss = of(r, 'drop').find((d) => d.reason === 'interference')!.t;
    const frames = (x: SimResult, until: number) => of(x, 'tx').filter((e) => e.t <= until && !isAck(x, e.packetId)).map((e) => [e.linkId, x.packets.get(e.packetId)!.label]);
    const before = frames(r, firstLoss);
    expect(before.length).toBeGreaterThan(0);
    expect(before).toEqual(frames(plain, Infinity).slice(0, before.length));
  });

  it('works with the call, the photo and together, and every field of every frame on the air is explained', () => {
    const call = noisy({ call: true });
    expect(of(call, 'app').filter((e) => e.action === 'call-done').map((e) => e.info)).toEqual([{ received: 50, gaps: 0 }, { received: 50, gaps: 0 }]);
    expect(of(call, 'wifi:retry').length).toBeGreaterThan(0);
    const photo = noisy({ site: 'connection-lab.rangner.com' });
    expect(of(photo, 'app').find((e) => e.action === 'done')?.info?.bytes).toBe(fromBase64(PHOTO_HTTP_RESPONSE_BASE64).length);
    expect(of(photo, 'wifi:retry').length).toBeGreaterThan(0);
    const both = noisy({ joins: [{}] });
    expect(of(both, 'app').filter((e) => e.action === 'done').map((e) => e.deviceId).sort()).toEqual(['laptop', 'phone']);
    const walk = (fs: Field[]): Field[] => fs.flatMap((f) => [f, ...walk(f.children ?? [])]);
    let seen = 0;
    for (const x of [r, photo]) {
      for (const pdu of x.pdus.values()) {
        if (pdu.first !== 'wifi') continue;
        seen++;
        for (const f of walk(pdu.layers.flatMap((l) => l.fields))) {
          expect(f.display, `${pdu.id} ${f.key}`).not.toContain('✗');
          expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(10);
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
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
  const photo = (faults: Partial<FaultPlan>) => runScenario(fetchWebPage({ site: 'connection-lab.rangner.com' }), { seed: 1, faults: { randomLoss: 0, manual: [], ...faults }, maxTime: 1000 });
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
    const lose = [19, 21, 23].map((i) => ({ packetId: data[i]!.id, linkId: 'bb2' }));
    // Three holes near the end: the fast retransmit would mend the first, so lose that too and leave it to the timer.
    const fast = of(photo({ manual: lose }), 'tcp:retransmit').find((e) => e.cause === 'fast')!;
    const r = photo({ manual: [...lose, { packetId: fast.packetId, linkId: 'bb2' }] });
    expect(of(r, 'tcp:retransmit').map((e) => e.cause)).toEqual(['fast', 'rto', 'recovery', 'recovery', 'recovery']);
    const resent = [...r.packets.values()].filter((p) => p.retransmitOf).map((p) => p.tcp!.relSeq);
    for (const i of [20, 22]) expect(resent).not.toContain(data[i]!.tcp!.relSeq);
    for (const i of [19, 21, 23]) expect(resent).toContain(data[i]!.tcp!.relSeq);
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
  });
});

describe('a thin pipe: DSL to the ISP, with a small buffer on its port', () => {
  const photo = (opts: FetchWebPageOptions = {}) => runScenario(fetchWebPage({ site: 'connection-lab.rangner.com', thin: true, ...opts }), { seed: 1, faults: { randomLoss: 0, manual: [] }, maxTime: 1000 });
  const r = photo();
  const wanOf = (opts: FetchWebPageOptions) => fetchWebPage(opts).links.find((l) => l.id === 'wan')!;
  /** The parts of the photo as the server first sent them, in order. */
  const parts = [...r.packets.values()].filter((p) => p.origin === 'server' && (p.tcp?.len ?? 0) > 0 && !p.retransmitOf);
  /** What waited at the ISP's port onto the line. */
  const queued = of(r, 'queue').filter((e) => e.linkId === 'wan' && e.iface === 'isp.cust' && e.deviceId === 'isp');

  it('is a 20 Mbit/s line with the same delay and a finite buffer; stretched it keeps both; the satellite wins over it', () => {
    expect(wanOf({ thin: true })).toMatchObject({ bitsPerSecond: THIN_BPS, delay: 0.002, queue: THIN_QUEUE });
    expect(wanOf({ thin: true, wanDelay: 0.01 })).toMatchObject({ bitsPerSecond: THIN_BPS, delay: 0.01, queue: THIN_QUEUE });
    expect(wanOf({ thin: true, slow: true })).toMatchObject({ bitsPerSecond: 25e6, delay: 0.28 });
    expect(wanOf({ thin: true, slow: true }).queue).toBeUndefined();
    expect(wanOf({}).queue).toBeUndefined();
  });

  it('the server’s burst piles up at the ISP’s port: the first part goes straight on, each next one finds one more ahead of it', () => {
    expect(queued.some((e) => e.packetId === parts[0]!.id)).toBe(false);
    const burst = parts.slice(1, THIN_QUEUE + 1).map((p) => queued.find((e) => e.packetId === p.id)!);
    expect(burst.map((e) => e.depth)).toEqual(burst.map((_, i) => i));
    for (let i = 1; i < burst.length; i++) expect(burst[i]!.wait).toBeGreaterThan(burst[i - 1]!.wait);
    // A part in the buffer waits a whole serialization time per frame ahead of it: 1522 bytes on the wire at 20 Mbit/s.
    const perFrame = ((1448 + 20 + 20 + 12 + 14 + 4 + 8 + 12) * 8) / THIN_BPS;
    expect(burst[0]!.wait).toBeCloseTo(perFrame, 5);
    expect(burst[1]!.wait).toBeCloseTo(2 * perFrame, 5);
  });

  it('every wait is real: the queue event is when it was handed in, the tx starts when its turn comes', () => {
    expect(queued.length).toBeGreaterThan(10);
    for (const q of queued) {
      expect(q.wait).toBeGreaterThan(0);
      const tx = of(r, 'tx').find((e) => e.frameId === q.frameId)!;
      expect(tx.fromIface).toBe('isp.cust');
      expect(Math.abs(tx.start - q.t - q.wait)).toBeLessThan(1e-6);
      expect(tx.t).toBeGreaterThanOrEqual(q.t);
    }
  });

  it('when the buffer is full the tail is dropped at the router, before any cable, with no cut anywhere', () => {
    const drops = of(r, 'drop');
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) expect(d).toMatchObject({ reason: 'queue-full', deviceId: 'isp', linkId: 'wan' });
    // The last of the first burst of ten finds the buffer full.
    const data = drops.filter((d) => (r.packets.get(d.packetId)!.tcp?.len ?? 0) > 0);
    expect(data.map((d) => d.packetId)).toEqual([parts[THIN_QUEUE + 1]!.id]);
    for (const d of drops) {
      expect(of(r, 'tx').some((e) => e.frameId === d.frameId)).toBe(false);
      expect(of(r, 'queue').some((e) => e.frameId === d.frameId)).toBe(false);
      expect(d.t).toBeLessThan(of(r, 'tx').find((e) => e.packetId === d.packetId && e.linkId === 'bb2')!.arrive + 1e-3);
    }
  });

  it('TCP mends it on its own: three dup ACKs, a fast retransmit, no timer, and the whole photo byte for byte', () => {
    expect(of(r, 'tcp:dup-ack').filter((e) => e.deviceId === 'server').length).toBeGreaterThanOrEqual(3);
    const causes = of(r, 'tcp:retransmit').map((e) => e.cause);
    expect(causes[0]).toBe('fast');
    expect(causes.every((c) => c === 'fast' || c === 'recovery')).toBe(true);
    expect(of(r, 'timer:fire').filter((e) => e.kind === 'tcp-rto')).toHaveLength(0);
    const response = fromBase64(PHOTO_HTTP_RESPONSE_BASE64);
    const got = of(r, 'app').find((e) => e.action === 'http-response-received')!;
    expect(r.pdus.get(got.pduId!)!.bytes).toEqual(response);
    expect(of(r, 'app').find((e) => e.action === 'done')?.info?.bytes).toBe(response.length);
  });

  it('a one-packet page has nothing to pile up: no drop', () => {
    const x = run({ thin: true });
    expect(of(x, 'drop')).toHaveLength(0);
    expect(of(x, 'app').some((e) => e.action === 'done')).toBe(true);
  });

  it('with thin off nothing is ever queued visibly, whatever else is on', () => {
    for (const o of [{}, { site: 'connection-lab.rangner.com' as const }, { slow: true, site: 'connection-lab.rangner.com' as const }, { vpn: true }, { dhcp: true }]) {
      const x = runScenario(fetchWebPage(o), { seed: 1, faults: { randomLoss: 0, manual: [] }, maxTime: 1000 });
      expect(of(x, 'queue')).toHaveLength(0);
      expect(of(x, 'drop').filter((d) => d.reason === 'queue-full')).toHaveLength(0);
    }
  });

  it('is deterministic, and the photo still arrives with the other settings on', () => {
    expect(JSON.stringify(photo().events)).toBe(JSON.stringify(r.events));
    for (const o of [{ https: true }, { vpn: true }, { from: 'phone' as const }, { slow: true }, { dhcp: true }, { cold: true }, { revisit: true }]) {
      const x = photo(o);
      expect(of(x, 'app').some((e) => e.action === 'done'), JSON.stringify(o)).toBe(true);
    }
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
    for (const o of [{}, { https: true }, { from: 'phone' as const }, { site: 'connection-lab.rangner.com' as const }]) {
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

describe('getting an address by DHCP', () => {
  const r = run({ dhcp: true });
  const frames = (x: SimResult, link: string) => of(x, 'tx').filter((e) => e.linkId === link).map((e) => ({ e, pdu: x.pdus.get(e.frameId)!, label: x.packets.get(e.packetId)!.label }));
  /** The DHCP message inside a frame, with the addresses around it. */
  const dhcpIn = (pdu: PduSnapshot) => {
    const l = pdu.layers.find((x) => x.protocol === 'dhcp')!;
    const ipL = pdu.layers.find((x) => x.protocol === 'ipv4')!;
    const udpL = pdu.layers.find((x) => x.protocol === 'udp')!;
    return { m: parseDhcp(pdu.bytes, l.start), ip: parseIpv4(pdu.bytes, ipL.start), udp: parseUdp(pdu.bytes, udpL.start), mac: pdu.layers[0]!.summary };
  };
  const allFields = (fs: Field[], out: Field[] = []): Field[] => {
    for (const f of fs) {
      out.push(f);
      if (f.children) allFields(f.children, out);
    }
    return out;
  };

  it('the first four packets on the LAN are DISCOVER, OFFER, REQUEST, ACK with one transaction id', () => {
    const lan = frames(r, 'lan');
    expect(lan.slice(0, 4).map((f) => f.label)).toEqual(['DHCP DISCOVER', 'DHCP OFFER 192.168.1.23', 'DHCP REQUEST 192.168.1.23', 'DHCP ACK 192.168.1.23']);
    const [d, o, q, a] = lan.slice(0, 4).map((f) => dhcpIn(f.pdu));
    expect([d, o, q, a].map((x) => x!.m.options.type)).toEqual([1, 2, 3, 5]);
    expect(new Set([d, o, q, a].map((x) => x!.m.xid)).size).toBe(1);
    expect([d, o, q, a].map((x) => x!.m.op)).toEqual([1, 2, 1, 2]);
    expect(lan[4]!.label).toMatch(/^ARP request/);
  });

  it('the client sends from nowhere to everyone: 0.0.0.0 → 255.255.255.255, ports 68 → 67, the broadcast MAC', () => {
    for (const f of frames(r, 'lan').filter((x) => /DISCOVER|REQUEST/.test(x.label))) {
      const { m, ip, udp, mac } = dhcpIn(f.pdu);
      expect(ip.src).toBe('0.0.0.0');
      expect(ip.dst).toBe('255.255.255.255');
      expect([udp.srcPort, udp.dstPort]).toEqual([68, 67]);
      expect(mac).toContain(`${ADDR.laptop.mac} → ff:ff:ff:ff:ff:ff`);
      expect(m.chaddr).toBe(ADDR.laptop.mac);
      expect(m.ciaddr).toBe('0.0.0.0');
      expect(m.options.hostName).toBe('laptop');
      expect(m.options.paramRequest).toEqual([1, 3, 6, 15, 28, 51, 54]);
      expect(m.options.clientId).toBe(ADDR.laptop.mac);
    }
    const q = dhcpIn(frames(r, 'lan').find((x) => x.label.startsWith('DHCP REQUEST'))!.pdu).m;
    expect(q.options.requestedIp).toBe(ADDR.laptop.ip);
    expect(q.options.serverId).toBe(ADDR.homeLan.ip);
  });

  it('OFFER and ACK carry the lease: yiaddr, mask, router, DNS, lease time, server id, unicast to the client MAC', () => {
    for (const f of frames(r, 'lan').filter((x) => /^DHCP (OFFER|ACK)/.test(x.label))) {
      const { m, ip, udp, mac } = dhcpIn(f.pdu);
      expect(m.yiaddr).toBe(ADDR.laptop.ip);
      expect(m.siaddr).toBe(ADDR.homeLan.ip);
      expect(m.options).toMatchObject({ subnetMask: '255.255.255.0', routers: [ADDR.homeLan.ip], dns: [ADDR.resolver.ip], leaseTime: 86400, serverId: ADDR.homeLan.ip });
      expect(ip.src).toBe(ADDR.homeLan.ip);
      expect(ip.dst).toBe(ADDR.laptop.ip);
      expect([udp.srcPort, udp.dstPort]).toEqual([67, 68]);
      expect(mac).toContain(`${ADDR.homeLan.mac} → ${ADDR.laptop.mac}`);
    }
  });

  it('after the ACK the laptop has its address, asks DNS from it and the page arrives', () => {
    const actions = of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions.slice(0, 7)).toEqual(['laptop:dhcp-discover', 'home:dhcp-offer', 'laptop:dhcp-request', 'home:dhcp-ack', 'laptop:dhcp-configured', 'laptop:start', 'laptop:dns-lookup']);
    expect(of(r, 'app').find((e) => e.action === 'dhcp-configured')?.info).toMatchObject({ address: ADDR.laptop.ip, prefixLen: 24, router: ADDR.homeLan.ip, dns: [ADDR.resolver.ip], lease: 86400 });
    const dns = frames(r, 'lan').find((x) => x.label.startsWith('DNS query'))!;
    const ip = parseIpv4(dns.pdu.bytes, 14);
    expect(ip.src).toBe(ADDR.laptop.ip);
    expect(ip.dst).toBe(ADDR.resolver.ip);
    expect(actions).toContain('laptop:done');
    expect(of(r, 'drop')).toHaveLength(0);
    // The scenario itself is untouched: the laptop still starts from nothing next time.
    expect(r.scenario.devices.find((d) => d.id === 'laptop')!.ifaces[0]!.ip).toBe('0.0.0.0');
  });

  it('a lost OFFER: the DISCOVER goes again after 4 s with the same xid and secs = 4, and the page still comes', () => {
    const offer = [...r.packets.values()].find((p) => p.label.startsWith('DHCP OFFER'))!;
    const x = run({ dhcp: true }, { randomLoss: 0, manual: [{ packetId: offer.id, linkId: 'lan' }] });
    const discovers = frames(x, 'lan').filter((f) => f.label.startsWith('DHCP DISCOVER'));
    expect(discovers.map((f) => f.label)).toEqual(['DHCP DISCOVER', 'DHCP DISCOVER (retry)']);
    expect(discovers[1]!.e.start - discovers[0]!.e.start).toBeCloseTo(4, 6);
    const [a, b] = discovers.map((f) => dhcpIn(f.pdu).m);
    expect(b!.xid).toBe(a!.xid);
    expect([a!.secs, b!.secs]).toEqual([0, 4]);
    expect(of(x, 'timer:fire').map((e) => e.kind)).toContain('dhcp-retry');
    expect(of(x, 'drop').map((d) => d.reason)).toEqual(['fault']);
    expect(of(x, 'app').some((e) => e.action === 'done')).toBe(true);
  });

  it('with no server answering it backs off 4, 8, 16, 32 s and gives up', () => {
    const x = runScenario(fetchWebPage({ dhcp: true }), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'lan', from: 0 }] }, maxTime: 1000 });
    const sent = of(x, 'tx').filter((e) => e.linkId === 'lan').map((e) => e.start);
    expect(sent.map((t, i) => (i ? Math.round(t - sent[i - 1]!) : 0))).toEqual([0, 4, 8, 16]);
    expect(of(x, 'app').map((e) => `${e.deviceId}:${e.action}`)).toEqual(['laptop:dhcp-discover', 'laptop:dhcp-discover', 'laptop:dhcp-discover', 'laptop:dhcp-discover', 'laptop:error']);
    expect(of(x, 'app').at(-1)!.t).toBeCloseTo(60, 6);
  });

  it('the phone gets 192.168.1.42 over Wi-Fi, its DISCOVER going up to the access point for everyone', () => {
    const x = run({ dhcp: true, from: 'phone' });
    const air = frames(x, 'wlan');
    expect(air.slice(0, 4).map((f) => f.label)).toEqual(['DHCP DISCOVER', 'DHCP OFFER 192.168.1.42', 'DHCP REQUEST 192.168.1.42', 'DHCP ACK 192.168.1.42']);
    const d = parseWifi(air[0]!.pdu.bytes);
    expect(d).toMatchObject({ toAp: true, addr1: ADDR.homeWlan.mac, addr2: ADDR.phone.mac, addr3: 'ff:ff:ff:ff:ff:ff' });
    const o = parseWifi(air[1]!.pdu.bytes);
    expect(o).toMatchObject({ toAp: false, addr1: ADDR.phone.mac, addr2: ADDR.homeWlan.mac });
    expect(of(x, 'app').find((e) => e.action === 'dhcp-configured')?.info?.address).toBe(ADDR.phone.ip);
    expect(of(x, 'app').some((e) => e.deviceId === 'phone' && e.action === 'done')).toBe(true);
    expect(of(x, 'tx').some((e) => e.linkId === 'lan')).toBe(false);
  });

  it('works with the other settings too: HTTPS, VPN, a second visit, the bigger page', () => {
    for (const o of [{ https: true }, { vpn: true }, { revisit: true }, { site: 'info.cern.ch' as const }, { vpn: true, from: 'phone' as const }]) {
      const x = run({ dhcp: true, ...o });
      expect(of(x, 'app').find((e) => e.action === 'dhcp-configured')).toBeTruthy();
      expect(of(x, 'app').some((e) => e.action === 'done')).toBe(true);
    }
  });

  it('every DHCP field is explained and every checksum checks out', () => {
    let seen = 0;
    for (const pdu of r.pdus.values()) {
      if (!pdu.layers.some((l) => l.protocol === 'dhcp')) continue;
      seen++;
      for (const f of allFields(pdu.layers.flatMap((l) => l.fields))) {
        expect(f.display, `${pdu.id} ${f.key}`).not.toContain('✗');
        expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(0);
      }
    }
    expect(seen).toBeGreaterThan(8);
  });

  it('is deterministic for a given seed', () => {
    const again = run({ dhcp: true });
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(r.events));
    expect(JSON.stringify(run({ dhcp: true }, undefined, 2).events)).not.toBe(JSON.stringify(r.events));
  });
});

describe('a cold resolver (the real walk root → .com → authoritative)', () => {
  const r = run({ cold: true });
  const warm = run({});
  const UP = ['up1', 'up2', 'up3'];
  const onUp = (x: SimResult) => of(x, 'tx').filter((e) => UP.includes(e.linkId));
  const dnsOf = (x: SimResult, e: EventOf<'tx'>) => {
    const pdu = x.pdus.get(e.frameId)!;
    return parseDns(pdu.bytes, pdu.layers.find((l) => l.protocol === 'dns')!.start);
  };
  const hops = DNS_TRACES['example.com']!.hops;

  it('asks the root, then the .com server, then the site’s own server, each a real RD=0 question on its own cable', () => {
    const questions = onUp(r).filter((e) => e.fromDevice === 'resolver');
    expect(questions.map((e) => [e.linkId, e.toDevice])).toEqual([['up1', 'root'], ['up2', 'tld'], ['up3', 'auth']]);
    questions.forEach((e, i) => {
      const q = dnsOf(r, e);
      expect(q.flags).toBe(0);
      expect(q.questions[0]).toMatchObject({ name: 'example.com', type: 1 });
      const ip = parseIpv4(r.pdus.get(e.frameId)!.bytes, 14);
      expect(ip.dst).toBe(hops[i]!.server.ip);
      expect(ip.src).toBe(ADDR.resolver.ip);
    });
    const ids = new Set(questions.map((e) => dnsOf(r, e).id));
    expect(ids.size).toBe(3);
    const actions = of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions.slice(0, 11)).toEqual([
      'laptop:start', 'laptop:dns-lookup',
      'resolver:dns-iterate', 'root:dns-serve', 'resolver:dns-referral',
      'resolver:dns-iterate', 'tld:dns-serve', 'resolver:dns-referral',
      'resolver:dns-iterate', 'auth:dns-serve', 'resolver:dns-learn',
    ]);
    expect(actions.slice(11, 13)).toEqual(['resolver:dns-serve', 'laptop:dns-answer']);
  });

  it('the referrals on the wire are the captured bytes: NS records plus glue, only the id changed', () => {
    const replies = onUp(r).filter((e) => e.toDevice === 'resolver');
    expect(replies.map((e) => e.fromDevice)).toEqual(['root', 'tld', 'auth']);
    replies.forEach((e, i) => {
      const pdu = r.pdus.get(e.frameId)!;
      const dns = pdu.layers.find((l) => l.protocol === 'dns')!;
      const captured = fromBase64(hops[i]!.response);
      expect(pdu.bytes.slice(dns.start + 2, dns.end)).toEqual(captured.slice(2));
    });
    const root = dnsReferral(dnsOf(r, replies[0]!))!;
    expect(root.zone).toBe('com');
    expect(root.servers).toHaveLength(13);
    expect(root.servers[0]).toEqual({ name: 'l.gtld-servers.net', ip: '192.41.162.30' });
    const com = dnsReferral(dnsOf(r, replies[1]!))!;
    expect(com).toMatchObject({ zone: 'example.com', servers: [{ name: 'hera.ns.cloudflare.com', ip: '108.162.192.162' }, { name: 'elliott.ns.cloudflare.com' }] });
    expect(dnsReferral(dnsOf(r, replies[2]!))).toBeUndefined();
  });

  it('the laptop gets the same address as from a warm resolver, with the authoritative TTL, and the page arrives', () => {
    const answer = (x: SimResult) => of(x, 'app').find((e) => e.action === 'dns-answer')!.info!;
    expect(answer(r).addresses).toEqual(answer(warm).addresses);
    expect(answer(r).ttl).toBe(300);
    expect(of(r, 'app').some((e) => e.action === 'done')).toBe(true);
    expect(of(r, 'drop')).toHaveLength(0);
    for (const site of ['info.cern.ch', 'connection-lab.rangner.com'] as const) {
      const x = run({ cold: true, site });
      expect(onUp(x)).toHaveLength(6);
      expect(of(x, 'app').some((e) => e.action === 'done')).toBe(true);
    }
  });

  it('each upstream cable takes half the measured round trip', () => {
    onUp(r).forEach((e) => {
      const hop = hops[Number(e.linkId.slice(2)) - 1]!;
      expect(e.arrive - e.start).toBeGreaterThan(hop.rttMs / 2000);
      expect(e.arrive - e.start).toBeLessThan(hop.rttMs / 2000 + 0.001);
    });
  });

  it('answers a second question from its cache: the walk happens once', () => {
    const reply = of(r, 'tx').find((e) => e.linkId === 'bb1' && e.fromDevice === 'resolver')!;
    const again = run({ cold: true }, { randomLoss: 0, manual: [{ packetId: reply.packetId, linkId: 'bb1' }] });
    const actions = of(again, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions.filter((a) => a === 'laptop:dns-lookup')).toHaveLength(2);
    expect(actions.filter((a) => a === 'resolver:dns-serve')).toHaveLength(2);
    expect(actions.filter((a) => a === 'resolver:dns-iterate')).toHaveLength(3);
    expect(onUp(again)).toHaveLength(6);
    expect(of(again, 'app').some((e) => e.action === 'done')).toBe(true);
  });

  it('with cold off nothing crosses the upstream cables, whatever else is on', () => {
    for (const o of [{}, { site: 'info.cern.ch' as const }, { from: 'phone' as const }, { vpn: true }, { https: true }, { revisit: true }]) {
      expect(onUp(run(o))).toHaveLength(0);
    }
    expect(warm.scenario.devices.map((d) => d.kind)).toEqual(expect.arrayContaining(['root-server', 'tld-server', 'auth-server']));
    expect(warm.scenario.devices.find((d) => d.id === 'tld')).toMatchObject({ label: '.com server' });
    expect(run({ site: 'info.cern.ch' }).scenario.devices.find((d) => d.id === 'tld')).toMatchObject({ label: '.ch server' });
  });

  it('every field of every frame on the upstream cables is explained and checks out', () => {
    const walk = (fs: Field[]): Field[] => fs.flatMap((f) => [f, ...walk(f.children ?? [])]);
    for (const e of onUp(r)) {
      for (const f of walk(r.pdus.get(e.frameId)!.layers.flatMap((l) => l.fields))) {
        expect(f.display, f.key).not.toContain('✗');
        expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(run({ cold: true }).events)).toBe(JSON.stringify(r.events));
  });

  it('a server that stays quiet is asked twice, then the laptop hears SERVFAIL', () => {
    const x = runScenario(fetchWebPage({ cold: true }), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'up2', from: 0 }] }, maxTime: 1000 });
    const asked = of(x, 'tx').filter((e) => e.linkId === 'up2');
    expect(asked).toHaveLength(2);
    expect(asked[1]!.start - asked[0]!.start).toBeCloseTo(2, 3);
    const answer = of(x, 'app').find((e) => e.action === 'dns-answer')!;
    expect(answer.info?.rcode).toBe(2);
    expect(of(x, 'app').find((e) => e.action === 'error')?.info?.reason).toBe('the resolver could not find out');
  });
});

describe('a voice call (RTP over UDP)', () => {
  const r = run({ call: true });
  const actions = (x: SimResult) => of(x, 'app').map((e) => `${e.deviceId}:${e.action}`);
  /** The RTP packets one device sent, in order, with the bytes as they left it. */
  const sentBy = (x: SimResult, device: string) =>
    [...x.packets.values()]
      .filter((p) => p.kind === 'rtp' && p.origin === device)
      .map((p) => {
        const made = of(x, 'encapsulate').find((e) => e.packetId === p.id && e.protocol === 'rtp')!;
        return { p, bytes: x.pdus.get(made.pduId)!.bytes, t: made.t };
      });
  const walk = (fs: Field[]): Field[] => fs.flatMap((f) => [f, ...walk(f.children ?? [])]);

  it('looks the friend up by name, then streams 50 packets each way, 20 ms apart, and both sides hang up', () => {
    expect(of(r, 'app').find((e) => e.action === 'dns-answer')?.info).toMatchObject({ name: 'sam.example', addresses: [ADDR.friend.ip], ttl: 300 });
    expect(actions(r).slice(0, 5)).toEqual(['laptop:start', 'laptop:dns-lookup', 'resolver:dns-serve', 'laptop:dns-answer', 'friend:rtp-received']);
    for (const device of ['laptop', 'friend']) {
      const sent = sentBy(r, device);
      expect(sent).toHaveLength(50);
      expect(sent.map((s) => s.p.label)).toEqual(Array.from({ length: 50 }, (_, i) => `RTP voice (part ${i + 1}/50)`));
      for (let i = 1; i < sent.length; i++) expect(sent[i]!.t - sent[i - 1]!.t).toBeCloseTo(0.02, 9);
    }
    expect(actions(r).slice(-2)).toEqual(['friend:call-done', 'laptop:call-done']);
    for (const e of of(r, 'app').filter((e) => e.action === 'call-done')) expect(e.info).toEqual({ received: 50, gaps: 0 });
    expect(actions(r).filter((a) => a.endsWith(':rtp-received'))).toHaveLength(100);
    expect(of(r, 'tx').filter((e) => e.linkId === 'bb6')).toHaveLength(100);
    expect([...r.packets.values()].some((p) => p.kind === 'tcp')).toBe(false);
  });

  it('each stream has one SSRC, consecutive sequence numbers and timestamps going up by 160; the friend answers to the caller’s port', () => {
    const caller = sentBy(r, 'laptop').map((s) => parseRtp(s.bytes, 0));
    const friend = sentBy(r, 'friend').map((s) => parseRtp(s.bytes, 0));
    for (const stream of [caller, friend]) {
      expect(new Set(stream.map((h) => h.ssrc)).size).toBe(1);
      expect(stream.map((h) => h.marker)).toEqual([true, ...Array(49).fill(false)]);
      for (let i = 1; i < stream.length; i++) {
        expect(stream[i]!.seq).toBe((stream[i - 1]!.seq + 1) & 0xffff);
        expect(stream[i]!.timestamp).toBe((stream[i - 1]!.timestamp + RTP_SAMPLES_PER_PACKET) >>> 0);
      }
      expect(stream.every((h) => h.version === 2 && h.payloadType === 0 && h.payloadEnd - h.payloadStart === 160)).toBe(true);
    }
    expect(caller[0]!.ssrc).not.toBe(friend[0]!.ssrc);
    const out = of(r, 'tx').find((e) => e.linkId === 'bb6' && e.fromDevice === 'isp')!;
    const back = of(r, 'tx').find((e) => e.linkId === 'bb6' && e.fromDevice === 'friend')!;
    const udpOf = (e: EventOf<'tx'>) => parseUdp(r.pdus.get(e.frameId)!.bytes, 34);
    expect(udpOf(out).dstPort).toBe(RTP_PORT);
    expect(udpOf(back)).toMatchObject({ srcPort: RTP_PORT, dstPort: udpOf(out).srcPort });
    expect(udpOf(out).length).toBe(8 + RTP_HEADER_LEN + 160);
  });

  it('the bytes each side receives are the other’s clip, byte for byte', () => {
    const heard = (device: string) =>
      of(r, 'app')
        .filter((e) => e.deviceId === device && e.action === 'rtp-received')
        .map((e) => {
          const b = r.pdus.get(e.pduId!)!.bytes;
          return b.subarray(parseRtp(b, 0).payloadStart);
        });
    const join = (parts: Uint8Array[]) => parts.reduce((all, p) => new Uint8Array([...all, ...p]), new Uint8Array(0));
    expect(join(heard('friend'))).toEqual(fromBase64(VOICE_CLIP_CALLER_BASE64));
    expect(join(heard('laptop'))).toEqual(fromBase64(VOICE_CLIP_FRIEND_BASE64));
  });

  it('a lost packet is a gap, and nothing is ever sent again: no retransmission, no timer', () => {
    const third = sentBy(r, 'friend')[2]!.p;
    const x = run({ call: true }, { randomLoss: 0, manual: [{ packetId: third.id, linkId: 'bb6' }] });
    expect(of(x, 'drop').map((d) => d.reason)).toEqual(['fault']);
    const gaps = of(x, 'app').filter((e) => e.action === 'rtp-gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.deviceId).toBe('laptop');
    const seq = third.rtp!.seq;
    expect(gaps[0]!.info).toEqual({ expected: seq, got: (seq + 1) & 0xffff, missing: 1 });
    expect(of(x, 'app').filter((e) => e.action === 'rtp-late')).toHaveLength(0);
    expect(of(x, 'app').find((e) => e.deviceId === 'laptop' && e.action === 'call-done')?.info).toEqual({ received: 49, gaps: 1 });
    expect(of(x, 'app').find((e) => e.deviceId === 'friend' && e.action === 'call-done')?.info).toEqual({ received: 50, gaps: 0 });
    expect([...x.packets.values()].filter((p) => p.retransmitOf)).toHaveLength(0);
    expect([...x.packets.values()].filter((p) => p.kind === 'rtp')).toHaveLength(100);
    expect(of(x, 'timer:set').filter((e) => e.kind !== 'arp-retry' && e.kind !== 'dns-retry')).toHaveLength(0);
    // The same number of packets go out, at the same moments, as with nothing lost.
    expect(sentBy(x, 'friend').map((s) => s.t)).toEqual(sentBy(r, 'friend').map((s) => s.t));
  });

  it('a cable cut for 0.3 s mid-call costs about 15 packets each way, with no retry and the call still ending', () => {
    const start = of(r, 'tx').find((e) => e.linkId === 'wan' && r.packets.get(e.packetId)!.kind === 'rtp')!.start;
    const x = runScenario(fetchWebPage({ call: true }), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'wan', from: start + 0.3, to: start + 0.6 }] }, maxTime: 100 });
    const dropped = of(x, 'drop');
    expect(dropped.every((d) => d.reason === 'cut')).toBe(true);
    expect(dropped.length).toBeGreaterThanOrEqual(28);
    expect(dropped.length).toBeLessThanOrEqual(32);
    for (const device of ['laptop', 'friend']) {
      const done = of(x, 'app').find((e) => e.deviceId === device && e.action === 'call-done')!.info!;
      expect(Number(done.gaps)).toBeGreaterThanOrEqual(14);
      expect(Number(done.gaps)).toBeLessThanOrEqual(16);
      expect(Number(done.received) + Number(done.gaps)).toBe(50);
      const missing = of(x, 'app').filter((e) => e.deviceId === device && e.action === 'rtp-gap').reduce((n, e) => n + Number(e.info!.missing), 0);
      expect(missing).toBe(Number(done.gaps));
    }
    expect([...x.packets.values()].filter((p) => p.retransmitOf)).toHaveLength(0);
    expect(x.endTime).toBeLessThan(start + 1.1);
  });

  it('a cable cut before the call: the caller talks into the void and gives up; the friend never speaks', () => {
    const x = runScenario(fetchWebPage({ call: true, revisit: true }), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'bb6', from: 0 }] }, maxTime: 100 });
    expect(sentBy(x, 'laptop')).toHaveLength(50);
    expect(sentBy(x, 'friend')).toHaveLength(0);
    expect(actions(x).at(-1)).toBe('laptop:error');
    expect(of(x, 'app').at(-1)!.info?.reason).toBe('nobody answered');
  });

  it('works with the other settings too: a second call, DHCP, the phone, the satellite', () => {
    for (const o of [{ revisit: true }, { dhcp: true }, { from: 'phone' as const }, { slow: true }, { cold: true }]) {
      const x = run({ call: true, ...o });
      expect(of(x, 'app').filter((e) => e.action === 'call-done').map((e) => e.info)).toEqual([{ received: 50, gaps: 0 }, { received: 50, gaps: 0 }]);
    }
    expect(actions(run({ call: true, revisit: true }))).toContain('laptop:dns-cache-hit');
    expect(actions(run({ call: true, from: 'phone' }))).toContain('phone:call-done');
    expect(of(run({ call: true, joins: [{}] }), 'app').filter((e) => e.action === 'done' || e.action === 'call-done')).toHaveLength(3);
  });

  it('every RTP field is explained and every checksum checks out; the friend is in every run and silent otherwise', () => {
    let seen = 0;
    for (const e of of(r, 'tx').filter((e) => e.linkId === 'bb6')) {
      const pdu = r.pdus.get(e.frameId)!;
      expect(pdu.layers.map((l) => l.protocol)).toEqual(['ethernet', 'ipv4', 'udp', 'rtp']);
      seen++;
      for (const f of walk(pdu.layers.flatMap((l) => l.fields))) {
        expect(f.display, f.key).not.toContain('✗');
        expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(0);
      }
    }
    expect(seen).toBe(100);
    const plain = run({});
    expect(plain.scenario.devices.find((d) => d.id === 'friend')).toMatchObject({ kind: 'peer', label: "Sam's phone" });
    expect(of(plain, 'tx').some((e) => e.linkId === 'bb6')).toBe(false);
    expect([...plain.packets.values()].some((p) => p.kind === 'rtp')).toBe(false);
  });

  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(run({ call: true }).events)).toBe(JSON.stringify(r.events));
    expect(JSON.stringify(run({ call: true }, undefined, 2).events)).not.toBe(JSON.stringify(r.events));
  });
});

/** The frames on one cable, each with its event, snapshot and the packet's label. */
const framesOn = (x: SimResult, link: string) => of(x, 'tx').filter((e) => e.linkId === link).map((e) => ({ e, pdu: x.pdus.get(e.frameId)!, label: x.packets.get(e.packetId)!.label }));
/** The IP header and the ICMP message in a frame. */
const icmpIn = (pdu: PduSnapshot) => {
  const l = pdu.layers.find((x) => x.protocol === 'icmp')!;
  return { ip: parseIpv4(pdu.bytes, pdu.layers.find((x) => x.protocol === 'ipv4')!.start), m: parseIcmp(pdu.bytes, l.start, l.end), bytes: pdu.bytes.subarray(l.start, l.end) };
};
const walkFields = (fs: Field[]): Field[] => fs.flatMap((f) => [f, ...walkFields(f.children ?? [])]);
const explained = (x: SimResult, has: (pdu: PduSnapshot) => boolean): number => {
  let seen = 0;
  for (const pdu of x.pdus.values()) {
    if (!has(pdu)) continue;
    seen++;
    for (const f of walkFields(pdu.layers.flatMap((l) => l.fields))) {
      expect(f.display, `${pdu.id} ${f.key}`).not.toContain('✗');
      expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(0);
    }
  }
  return seen;
};

describe('ping (ICMP echo, like `ping -c 4`)', () => {
  const r = run({ probe: 'ping' });
  const requests = framesOn(r, 'lan').filter((f) => f.label.startsWith('ICMP echo request'));
  const replies = framesOn(r, 'lan').filter((f) => f.label.startsWith('ICMP echo reply'));

  it('looks the name up, then sends four echo requests a second apart and hears four replies', () => {
    const actions = of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);
    expect(actions.slice(0, 4)).toEqual(['laptop:start', 'laptop:dns-lookup', 'resolver:dns-serve', 'laptop:dns-answer']);
    expect(actions.filter((a) => a === 'laptop:ping-request')).toHaveLength(4);
    expect(actions.filter((a) => a === 'laptop:ping-reply')).toHaveLength(4);
    expect(requests).toHaveLength(4);
    expect(replies).toHaveLength(4);
    requests.slice(1).forEach((f, i) => expect(f.e.start - requests[i]!.e.start).toBeCloseTo(1, 6));
    expect(of(r, 'app').map((e) => e.action === 'ping-reply' && e.info?.seq).filter(Boolean)).toEqual([1, 2, 3, 4]);
    expect(of(r, 'app').find((e) => e.action === 'ping-done')?.info).toMatchObject({ to: 'example.com', target: '104.20.23.154', sent: 4, received: 4, lossPct: 0 });
    expect([...r.packets.values()].some((p) => p.kind === 'tcp')).toBe(false);
  });

  it('each is 84 bytes of IP, 64 of ICMP: one identifier, seq 1 … 4, a timestamp and then the bytes 0x10 … 0x37', () => {
    const ids = new Set<number>();
    [...requests, ...replies].forEach((f, i) => {
      const { ip, m, bytes } = icmpIn(f.pdu);
      expect(ip.totalLength).toBe(84);
      expect(bytes.length).toBe(64);
      expect(m.type).toBe(i < 4 ? ICMP_ECHO : ICMP_ECHO_REPLY);
      expect(m.checksumValid).toBe(true);
      expect(m.seq).toBe((i % 4) + 1);
      ids.add(m.id!);
      expect([...bytes.subarray(24)]).toEqual(Array.from({ length: 40 }, (_, k) => 0x10 + k));
    });
    expect(ids.size).toBe(1);
    // The reply carries the request's data back unchanged, timestamp included.
    replies.forEach((f, i) => expect(icmpIn(f.pdu).bytes.subarray(8)).toEqual(icmpIn(requests[i]!.pdu).bytes.subarray(8)));
    expect(pingTimestamp(icmpIn(requests[1]!.pdu).bytes.subarray(8))).toBeCloseTo(requests[1]!.e.start, 5);
  });

  it('measures the real round trip: twice the 2 ms fiber plus the 4 ms backbone, a little serialisation on top', () => {
    for (const e of of(r, 'app').filter((x) => x.action === 'ping-reply')) {
      expect(e.info).toMatchObject({ from: '104.20.23.154', ttl: 62, bytes: 64 });
      expect(Number(e.info?.rttMs)).toBeGreaterThan(12);
      expect(Number(e.info?.rttMs)).toBeLessThan(12.1);
    }
    const done = of(r, 'app').find((e) => e.action === 'ping-done')!.info!;
    expect(Number(done.minMs)).toBeGreaterThan(12);
    expect(done.avgMs).toBe(done.minMs);
    expect(done.maxMs).toBe(done.minMs);
    // The last reply comes in, and ping sums up at once rather than waiting its second out.
    expect(of(r, 'timer:cancel').some((e) => e.kind === 'ping-wait')).toBe(true);
    expect(r.endTime).toBeLessThan(3.1);
  });

  it('the home router translates the identifier like a port, and back again for the reply', () => {
    const entry = of(r, 'nat:add').find((e) => e.entry.proto === 'icmp')!.entry;
    expect(entry.inside).toEqual({ ip: ADDR.laptop.ip, port: icmpIn(requests[0]!.pdu).m.id });
    expect(entry.outside.ip).toBe(ADDR.homeWan.ip);
    expect(entry.outside.port).not.toBe(entry.inside.port);
    const onWan = framesOn(r, 'wan').filter((f) => f.label.startsWith('ICMP echo'));
    expect(onWan).toHaveLength(8);
    for (const f of onWan) {
      const { ip, m } = icmpIn(f.pdu);
      expect(m.id).toBe(entry.outside.port);
      expect(m.checksumValid).toBe(true);
      expect(m.type === ICMP_ECHO ? ip.src : ip.dst).toBe(ADDR.homeWan.ip);
    }
    expect(of(r, 'nat:translate').filter((e) => r.packets.get(e.packetId)!.kind === 'icmp')).toHaveLength(8);
  });

  it('works from the phone, over the satellite, inside the VPN and after DHCP', () => {
    const phone = run({ probe: 'ping', from: 'phone' });
    expect(of(phone, 'app').find((e) => e.action === 'ping-done')).toMatchObject({ deviceId: 'phone', info: { received: 4 } });
    const slow = run({ probe: 'ping', slow: true });
    expect(Number(of(slow, 'app').find((e) => e.action === 'ping-done')!.info!.minMs)).toBeGreaterThan(560);
    const vpn = run({ probe: 'ping', vpn: true });
    expect(of(vpn, 'app').find((e) => e.action === 'ping-done')?.info).toMatchObject({ received: 4 });
    // Sealed all the way to the VPN server, which translates the id as the home router would, and the server sees only its address.
    for (const f of framesOn(vpn, 'wan')) expect(f.pdu.layers.some((l) => l.protocol === 'icmp')).toBe(false);
    for (const f of framesOn(vpn, 'bb4')) expect([icmpIn(f.pdu).ip.src, icmpIn(f.pdu).ip.dst]).toContain(ADDR.vpn.ip);
    expect(of(vpn, 'nat:translate').filter((e) => e.deviceId === 'vpn' && vpn.packets.get(e.packetId)!.kind === 'icmp')).toHaveLength(8);
    const dhcp = run({ probe: 'ping', dhcp: true });
    expect(of(dhcp, 'app').map((e) => e.action).filter((a) => a === 'dhcp-configured' || a === 'ping-done')).toEqual(['dhcp-configured', 'ping-done']);
  });

  it('every ICMP field is explained, every checksum checks out, and the run is deterministic', () => {
    expect(explained(r, (pdu) => pdu.layers.some((l) => l.protocol === 'icmp'))).toBeGreaterThan(30);
    expect(JSON.stringify(run({ probe: 'ping' }).events)).toBe(JSON.stringify(r.events));
    expect(JSON.stringify(run({ probe: 'ping' }, undefined, 2).events)).not.toBe(JSON.stringify(r.events));
  });
});

describe('traceroute (UDP probes, like Linux traceroute)', () => {
  const r = run({ probe: 'traceroute' });
  const probes = framesOn(r, 'lan').filter((f) => f.label.startsWith('traceroute probe'));
  const hops = of(r, 'app').filter((e) => e.action === 'trace-hop').map((e) => e.info!);

  it('sends 60-byte probes with TTL 1, 2, 3, three per hop, from one port to ports 33434 and up', () => {
    expect(probes.map((f) => f.label)).toEqual(['TTL 1 · 1/3', 'TTL 1 · 2/3', 'TTL 1 · 3/3', 'TTL 2 · 1/3', 'TTL 2 · 2/3', 'TTL 2 · 3/3', 'TTL 3 · 1/3', 'TTL 3 · 2/3', 'TTL 3 · 3/3'].map((s) => `traceroute probe · ${s}`));
    const ports = new Set<number>();
    probes.forEach((f, i) => {
      const ip = parseIpv4(f.pdu.bytes, 14);
      const udp = parseUdp(f.pdu.bytes, 34);
      expect(ip.ttl).toBe(Math.floor(i / 3) + 1);
      expect(ip.totalLength).toBe(60);
      expect(ip.df).toBe(true);
      expect(udp.dstPort).toBe(33434 + i);
      ports.add(udp.srcPort);
      expect([...f.pdu.bytes.subarray(42, 74)]).toEqual(Array.from({ length: 32 }, (_, k) => 0x40 + k));
    });
    expect(ports.size).toBe(1);
  });

  it('TTL 1 dies at the home router, TTL 2 at the ISP, TTL 3 reaches the server: each tells the laptop so, from its own address', () => {
    const drops = of(r, 'drop').map((d) => `${d.deviceId}:${d.reason}`);
    expect(drops).toEqual([...Array(3).fill('home:ttl-expired'), ...Array(3).fill('isp:ttl-expired'), ...Array(3).fill('server:no-socket')]);
    expect(hops.map((h) => [h.ttl, h.from, h.reached])).toEqual([
      [1, ADDR.homeLan.ip, 0], [1, ADDR.homeLan.ip, 0], [1, ADDR.homeLan.ip, 0],
      [2, ADDR.ispCustomer.ip, 0], [2, ADDR.ispCustomer.ip, 0], [2, ADDR.ispCustomer.ip, 0],
      [3, '104.20.23.154', 1], [3, '104.20.23.154', 1], [3, '104.20.23.154', 1],
    ]);
    expect(of(r, 'app').find((e) => e.action === 'trace-done')?.info).toEqual({ to: 'example.com', target: '104.20.23.154', hops: 3, reached: 1, path: [ADDR.homeLan.ip, ADDR.ispCustomer.ip, '104.20.23.154'] });
    // The round trips grow with the path: at once, 2 × 2 ms, 2 × (2 + 4) ms.
    expect(hops.map((h) => Math.round(Number(h.rttMs)))).toEqual([0, 0, 0, 4, 4, 4, 12, 12, 12]);
    // Each answer quotes the probe it is about: the laptop's own header, with the TTL as it arrived, which is always 1:
    // that is the whole trick, every probe dies exactly where it was meant to.
    const answers = framesOn(r, 'lan').filter((f) => f.label.startsWith('ICMP') && f.e.toDevice === 'laptop');
    expect(answers).toHaveLength(9);
    answers.forEach((f, i) => {
      const { ip, m } = icmpIn(f.pdu);
      expect(m.type).toBe(i < 6 ? ICMP_TIME_EXCEEDED : ICMP_DEST_UNREACHABLE);
      expect(m.code).toBe(i < 6 ? 0 : 3);
      expect(ip.totalLength).toBe(56);
      expect(m.quoted!.ip).toMatchObject({ src: ADDR.laptop.ip, dst: '104.20.23.154', ttl: 1 });
      expect(m.quoted!.dstPort).toBe(33434 + i);
    });
  });

  it('the home router finds whose packet an error is about by the header it quotes, and translates the quote back', () => {
    const fromIsp = framesOn(r, 'wan').filter((f) => f.label.startsWith('ICMP') && f.e.toDevice === 'home');
    expect(fromIsp).toHaveLength(6);
    const outsidePorts = of(r, 'nat:add').map((e) => e.entry.outside.port);
    for (const f of fromIsp) {
      const { ip, m } = icmpIn(f.pdu);
      expect(ip.dst).toBe(ADDR.homeWan.ip);
      expect(m.quoted!.ip.src).toBe(ADDR.homeWan.ip);
      expect(outsidePorts).toContain(m.quoted!.srcPort);
    }
    const back = of(r, 'nat:translate').filter((e) => e.direction === 'in' && r.packets.get(e.packetId)!.kind === 'icmp');
    expect(back).toHaveLength(6);
    for (const e of back) {
      const { ip, m } = icmpIn(r.pdus.get(e.pduId)!);
      expect(ip.dst).toBe(ADDR.laptop.ip);
      expect(m.quoted!.ip.src).toBe(ADDR.laptop.ip);
      expect(m.quoted!.srcPort).toBe(e.after.port);
      expect(m.checksumValid).toBe(true);
      expect(ip.checksumValid).toBe(true);
    }
  });

  it('inside the VPN the VPN server is the first hop that answers, from its own address, and the server the second', () => {
    const vpn = run({ probe: 'traceroute', vpn: true });
    expect(of(vpn, 'app').find((e) => e.action === 'trace-done')?.info).toMatchObject({ hops: 2, reached: 1, path: [ADDR.vpn.ip, '104.20.23.154'] });
    expect(of(vpn, 'drop').map((d) => `${d.deviceId}:${d.reason}`)).toEqual([...Array(3).fill('vpn:ttl-expired'), ...Array(3).fill('server:no-socket')]);
    for (const f of framesOn(vpn, 'bb3')) expect(f.pdu.layers.some((l) => l.protocol === 'wireguard')).toBe(true);
    for (const o of [{ from: 'phone' as const }, { slow: true }, { dhcp: true }]) {
      expect(of(run({ probe: 'traceroute', ...o }), 'app').find((e) => e.action === 'trace-done')?.info).toMatchObject({ hops: 3, reached: 1 });
    }
  });

  it('a probe nobody answers: traceroute waits a second, sends the next, and goes on to the last hop allowed', () => {
    const x = runScenario(fetchWebPage({ probe: 'traceroute' }), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'bb2', from: 0 }] }, maxTime: 1000 });
    expect(of(x, 'timer:fire').filter((e) => e.kind === 'trace-wait')).toHaveLength(6 * 3);
    const sent = of(x, 'app').filter((e) => e.action === 'trace-probe');
    expect(sent).toHaveLength(8 * 3);
    expect(sent[7]!.t - sent[6]!.t).toBeCloseTo(1, 6);
    expect(of(x, 'app').find((e) => e.action === 'trace-done')?.info).toMatchObject({ hops: 8, reached: 0, path: [ADDR.homeLan.ip, ADDR.ispCustomer.ip] });
  });

  it('every ICMP and probe field is explained, every checksum checks out, and the run is deterministic', () => {
    expect(explained(r, (pdu) => pdu.layers.some((l) => l.protocol === 'icmp') || r.packets.get(pdu.packetId)?.kind === 'probe')).toBeGreaterThan(60);
    expect(JSON.stringify(run({ probe: 'traceroute' }).events)).toBe(JSON.stringify(r.events));
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
