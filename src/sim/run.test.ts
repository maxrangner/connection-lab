import { describe, expect, it } from 'vitest';
import { parseIpv4 } from './proto/ipv4';
import { parseTcp, TCP_ACK, TCP_SYN } from './proto/tcp';
import type { Field } from './proto/types';
import { runScenario, type SimResult } from './run';
import { ADDR, fetchWebPage } from './scenarios/fetchWebPage';
import { fromBase64, toAscii } from './bytes/bytes';
import { HTTP_RESPONSE_BASE64 } from './scenarios/exampleComCapture';
import type { EventOf, SimEventType } from './events/SimEvent';

const run = (mss = 1460, manual: { packetId: string; linkId: string }[] = [], seed = 1): SimResult =>
  runScenario(fetchWebPage({ mss }), { seed, faults: { randomLoss: 0, manual } });

const of = <T extends SimEventType>(r: SimResult, type: T): EventOf<T>[] =>
  r.events.filter((e) => e.type === type) as EventOf<T>[];

const appActions = (r: SimResult): string[] =>
  of(r, 'app').map((e) => `${e.deviceId}:${e.action}`);

function allFields(fs: Field[], out: Field[] = []): Field[] {
  for (const f of fs) {
    out.push(f);
    if (f.children) allFields(f.children, out);
  }
  return out;
}

/** Frames that crossed a link, with their decoded IPv4/TCP view. */
function framesOn(r: SimResult, linkId: string) {
  return of(r, 'tx')
    .filter((e) => e.linkId === linkId)
    .map((e) => ({ e, pdu: r.pdus.get(e.frameId)!, label: r.packets.get(e.packetId)!.label }));
}

describe('fetch http://example.com/ (no faults)', () => {
  const r = run();

  it('completes the page load and closes the connection cleanly', () => {
    expect(appActions(r)).toEqual([
      'laptop:start',
      'laptop:dns-lookup',
      'resolver:dns-serve',
      'laptop:dns-answer',
      'laptop:http-request-sent',
      'server:http-request-received',
      'server:http-response-sent',
      'laptop:http-response-received',
      'laptop:done',
    ]);
    const finalStates = of(r, 'tcp:state').map((e) => `${e.deviceId}:${e.to}`);
    expect(finalStates.filter((s) => s.endsWith('CLOSED'))).toHaveLength(2);
    expect(of(r, 'drop')).toHaveLength(0);
    expect(of(r, 'tcp:retransmit')).toHaveLength(0);
  });

  it('delivers the exact captured response bytes to the browser', () => {
    const got = of(r, 'app').find((e) => e.action === 'http-response-received')!;
    expect(toAscii(r.pdus.get(got.pduId!)!.bytes)).toBe(toAscii(fromBase64(HTTP_RESPONSE_BASE64)));
  });

  it('starts with ARP for the gateway, then sends the queued DNS query', () => {
    const lan = framesOn(r, 'lan');
    expect(lan[0]!.label).toMatch(/^ARP request/);
    expect(lan[1]!.label).toMatch(/^ARP reply/);
    expect(lan[2]!.label).toMatch(/^DNS query/);
  });

  it('decrements TTL at each router: 64 → 63 → 62', () => {
    const ttlOn = (link: string, label: RegExp): number => {
      const f = framesOn(r, link).find((x) => label.test(x.label))!;
      return parseIpv4(f.pdu.bytes, 14).ttl;
    };
    expect(ttlOn('lan', /^SYN$/)).toBe(64);
    expect(ttlOn('wan', /^SYN$/)).toBe(63);
    expect(ttlOn('bb2', /^SYN$/)).toBe(62);
    expect(ttlOn('bb2', /^SYN-ACK$/)).toBe(64);
    expect(ttlOn('lan', /^SYN-ACK$/)).toBe(62);
  });

  it('NATs the private source address and port on the WAN side, and back', () => {
    const lanSyn = framesOn(r, 'lan').find((x) => x.label === 'SYN')!;
    const wanSyn = framesOn(r, 'wan').find((x) => x.label === 'SYN')!;
    expect(parseIpv4(lanSyn.pdu.bytes, 14).src).toBe(ADDR.laptop.ip);
    expect(parseIpv4(wanSyn.pdu.bytes, 14).src).toBe(ADDR.homeWan.ip);
    const lanPort = parseTcp(lanSyn.pdu.bytes, 34).srcPort;
    const wanPort = parseTcp(wanSyn.pdu.bytes, 34).srcPort;
    expect(wanPort).not.toBe(lanPort);
    const nat = of(r, 'nat:add').find((e) => e.entry.proto === 'tcp')!;
    expect(nat.entry.inside.port).toBe(lanPort);
    expect(nat.entry.outside.port).toBe(wanPort);
  });

  it('rewrites Ethernet addresses at every hop', () => {
    const macs = (link: string): string => {
      const f = framesOn(r, link).find((x) => x.label === 'SYN')!;
      return f.pdu.layers[0]!.summary;
    };
    expect(macs('lan')).toContain(`${ADDR.laptop.mac} → ${ADDR.homeLan.mac}`);
    expect(macs('wan')).toContain(`${ADDR.homeWan.mac} → ${ADDR.ispCustomer.mac}`);
    expect(macs('bb2')).toContain(`${ADDR.ispToServer.mac} → ${ADDR.server.mac}`);
  });

  it('performs a correct three-way handshake', () => {
    const tcp = framesOn(r, 'bb2').map((x) => ({ label: x.label, t: parseTcp(x.pdu.bytes, 34) }));
    const syn = tcp.find((x) => x.label === 'SYN')!.t;
    const synAck = tcp.find((x) => x.label === 'SYN-ACK')!.t;
    const ack = tcp.find((x) => x.label === 'ACK')!.t;
    expect(syn.flags).toBe(TCP_SYN);
    expect(synAck.flags).toBe(TCP_SYN | TCP_ACK);
    expect(synAck.ack).toBe((syn.seq + 1) >>> 0);
    expect(ack.seq).toBe((syn.seq + 1) >>> 0);
    expect(ack.ack).toBe((synAck.seq + 1) >>> 0);
  });

  it('sends the whole 932-byte response in one segment at MSS 1460', () => {
    const data = framesOn(r, 'bb2').filter((x) => x.label.startsWith('HTTP 200'));
    expect(data).toHaveLength(1);
  });

  it('every snapshot decodes with valid checksums and every field is explained', () => {
    for (const pdu of r.pdus.values()) {
      for (const f of allFields(pdu.layers.flatMap((l) => l.fields))) {
        expect(f.display, `${pdu.id} ${f.key}`).not.toContain('✗');
        expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const again = run();
    expect(again.events.length).toBe(r.events.length);
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(r.events));
  });
});

describe('MSS 536', () => {
  it('splits the response into two segments (524 + 408 bytes with timestamps)', () => {
    const r = run(536);
    const data = framesOn(r, 'bb2').filter((x) => x.label.startsWith('HTTP 200'));
    expect(data.map((d) => d.label)).toEqual(['HTTP 200 OK (part 1/2)', 'HTTP 200 OK (part 2/2)']);
    const lens = data.map((d) => d.pdu.bytes.length - 14 - 20 - 32 - 4);
    expect(lens).toEqual([524, 408]);
    expect(appActions(r)).toContain('laptop:done');
  });
});

describe('packet loss', () => {
  const base = run(536);
  const pkt = (label: RegExp, link: string): string => {
    const tx = of(base, 'tx').find((e) => e.linkId === link && label.test(base.packets.get(e.packetId)!.label));
    if (!tx) throw new Error(`no ${label} on ${link}`);
    return tx.packetId;
  };

  it('keeps the event history before the fault identical', () => {
    const id = pkt(/^SYN$/, 'wan');
    const r = run(536, [{ packetId: id, linkId: 'wan' }]);
    const drop = of(r, 'drop')[0]!;
    expect(drop.reason).toBe('fault');
    const prefix = r.events.filter((e) => e.seq < drop.seq);
    expect(JSON.stringify(prefix)).toBe(JSON.stringify(base.events.slice(0, prefix.length)));
  });

  it('a lost SYN is retransmitted after the 1 s initial RTO', () => {
    const r = run(536, [{ packetId: pkt(/^SYN$/, 'wan'), linkId: 'wan' }]);
    const rt = of(r, 'tcp:retransmit');
    expect(rt).toHaveLength(1);
    expect(rt[0]!.cause).toBe('rto');
    const synTimes = of(r, 'tx').filter((e) => e.linkId === 'lan' && /^SYN/.test(r.packets.get(e.packetId)!.label) && e.fromDevice === 'laptop');
    expect(synTimes[1]!.start - synTimes[0]!.start).toBeCloseTo(1, 3);
    expect(appActions(r)).toContain('laptop:done');
  });

  it('a lost first response segment: the second arrives out of order, gets a SACK dup ACK, then RTO repairs it', () => {
    const r = run(536, [{ packetId: pkt(/part 1\/2/, 'bb2'), linkId: 'bb2' }]);
    // Both the second data segment and the server's FIN arrive behind the gap.
    expect(of(r, 'tcp:ooo').map((e) => e.len)).toEqual([408, 0]);
    const dup = of(r, 'tx').find((e) => r.packets.get(e.packetId)!.label === 'dup ACK')!;
    const sack = r.pdus.get(dup.frameId)!.layers.find((l) => l.protocol === 'tcp')!;
    expect(allFields(sack.fields).some((f) => f.key === 'tcp.opt.sack')).toBe(true);
    expect(of(r, 'tcp:retransmit').map((e) => e.cause)).toEqual(['rto']);
    const got = of(r, 'app').find((e) => e.action === 'http-response-received')!;
    expect(toAscii(r.pdus.get(got.pduId!)!.bytes)).toBe(toAscii(fromBase64(HTTP_RESPONSE_BASE64)));
  });

  it('a lost DNS query is retried after the 5 s resolver timeout', () => {
    const r = run(1460, [{ packetId: pkt(/^DNS query/, 'wan'), linkId: 'wan' }]);
    const lookups = of(r, 'app').filter((e) => e.action === 'dns-lookup');
    expect(lookups).toHaveLength(2);
    expect(lookups[1]!.t - lookups[0]!.t).toBeCloseTo(5, 3);
    expect(appActions(r)).toContain('laptop:done');
  });

  it('a lost ARP reply is retried after 1 s', () => {
    const r = run(1460, [{ packetId: pkt(/^ARP reply/, 'lan'), linkId: 'lan' }]);
    const reqs = of(r, 'tx').filter((e) => /^ARP request/.test(r.packets.get(e.packetId)!.label));
    expect(reqs).toHaveLength(2);
    expect(appActions(r)).toContain('laptop:done');
  });

  it('a lost final ACK of the handshake is harmless: the GET carries the same ACK', () => {
    const r = run(1460, [{ packetId: pkt(/^ACK$/, 'wan'), linkId: 'wan' }]);
    expect(of(r, 'tcp:retransmit')).toHaveLength(0);
    expect(appActions(r)).toContain('laptop:done');
  });

  it('survives 20% random loss on every link', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = runScenario(fetchWebPage(), { seed, faults: { randomLoss: 0.2, manual: [] } });
      const done = appActions(r).some((a) => a === 'laptop:done' || a === 'laptop:error');
      expect(done, `seed ${seed}`).toBe(true);
    }
  });
});
