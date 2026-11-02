import { describe, expect, it } from 'vitest';
import { bytesToIp6 } from '../bytes/addr';
import { ascii, fromBase64, hexBytes, setU16 } from '../bytes/bytes';
import { internetChecksum, transportChecksum } from '../bytes/checksum';
import { DNS_TRACES } from '../scenarios/dnsTraceCapture';
import { natRewrite } from '../stack/Router';
import { buildArp, parseArp } from './arp';
import { decodePdu } from './decode';
import { BOOTREPLY, BOOTREQUEST, buildDhcp, DHCP_ACK, DHCP_DISCOVER, DHCP_OFFER, DHCP_REQUEST, parseDhcp, type DhcpMessage } from './dhcp';
import { buildDnsQuery, buildDnsResponse, DNS_TYPE_A, DNS_TYPE_AAAA, DNS_TYPE_CNAME, DNS_TYPE_NS, dnsAddresses, dnsReferral, parseDns } from './dns';
import { buildEthernet, ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEthernet } from './ethernet';
import { buildRtp, describeRtp, parseRtp, RTP_PT_PCMU } from './rtp';
import { buildIcmp, ICMP_DEST_UNREACHABLE, ICMP_ECHO, ICMP_ECHO_REPLY, ICMP_PORT_UNREACHABLE, ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED, parseIcmp, pingData, pingTimestamp } from './icmp';
import { buildIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP, parseIpv4 } from './ipv4';
import { buildTcp, encodeOptions, parseTcp, TCP_SYN } from './tcp';
import type { Field, LayerPdu } from './types';
import { buildUdp, parseUdp } from './udp';
import { buildWifi, buildWifiAck, parseWifi, parseWifiAck, WIFI_ACK_LEN, wifiFrameKind } from './wifi';

function allFields(layers: LayerPdu[]): Field[] {
  const out: Field[] = [];
  const walk = (fs: Field[]): void => {
    for (const f of fs) {
      out.push(f);
      if (f.children) walk(f.children);
    }
  };
  for (const l of layers) walk(l.fields);
  return out;
}

describe('ARP', () => {
  it('builds the 28-byte request layout and parses it back', () => {
    const b = buildArp({ oper: 1, sha: '3c:22:fb:5a:10:e4', spa: '192.168.1.23', tha: '00:00:00:00:00:00', tpa: '192.168.1.1' });
    expect(hexBytes(b, 0, 8, '')).toBe('0001080006040001');
    expect(b.length).toBe(28);
    expect(parseArp(b, 0)).toMatchObject({ oper: 1, spa: '192.168.1.23', tpa: '192.168.1.1' });
  });

  it('is padded to the 60-byte minimum (+ 4 byte FCS) inside Ethernet', () => {
    const arp = buildArp({ oper: 1, sha: '3c:22:fb:5a:10:e4', spa: '192.168.1.23', tha: '00:00:00:00:00:00', tpa: '192.168.1.1' });
    const frame = buildEthernet({ dst: 'ff:ff:ff:ff:ff:ff', src: '3c:22:fb:5a:10:e4', type: ETHERTYPE_ARP }, arp);
    expect(frame.length).toBe(64);
    const eth = parseEthernet(frame);
    expect(eth.fcsValid).toBe(true);
    const layers = decodePdu(frame, 'ethernet');
    expect(layers.map((l) => l.protocol)).toEqual(['ethernet', 'arp']);
    expect(allFields(layers).find((f) => f.key === 'eth.padding')?.length).toBe(18);
  });

  it('detects a corrupted frame through the FCS', () => {
    const frame = buildEthernet({ dst: 'ff:ff:ff:ff:ff:ff', src: '3c:22:fb:5a:10:e4', type: ETHERTYPE_ARP }, new Uint8Array(46));
    frame[20] = (frame[20] ?? 0) ^ 0x01;
    expect(parseEthernet(frame).fcsValid).toBe(false);
  });
});

describe('IPv4 + UDP + DNS', () => {
  const query = buildDnsQuery(0x1a2b, 'example.com');
  const udp = buildUdp(55391, 53, query, '192.168.1.23', '1.1.1.1');
  const ip = buildIpv4({ id: 7, df: true, ttl: 64, protocol: IPPROTO_UDP, src: '192.168.1.23', dst: '1.1.1.1' }, udp);

  it('encodes the DNS question as length-prefixed labels', () => {
    expect(query.length).toBe(29);
    expect(hexBytes(query, 12, 29, '')).toBe('076578616d706c6503636f6d0000010001');
    expect(hexBytes(query, 0, 4, '')).toBe('1a2b0100');
  });

  it('fills in lengths and valid checksums', () => {
    const p = parseIpv4(ip, 0);
    expect(p.totalLength).toBe(20 + 8 + 29);
    expect(p.checksumValid).toBe(true);
    expect(parseUdp(ip, 20)).toMatchObject({ srcPort: 55391, dstPort: 53, length: 37 });
    const layers = decodePdu(ip, 'ipv4');
    expect(layers.map((l) => l.protocol)).toEqual(['ipv4', 'udp', 'dns']);
    const csums = allFields(layers).filter((f) => f.key.endsWith('checksum'));
    expect(csums).toHaveLength(2);
    for (const c of csums) expect(c.display).toContain('✓');
  });

  it('NAT keeps a UDP checksum that works out to 0 as 0xffff, so it still verifies', () => {
    // Pick the two payload bytes so that the checksum after the rewrite sums to zero.
    const src = { ip: '203.0.113.7', port: 40000 };
    let udp: Uint8Array = new Uint8Array(0);
    for (let word = 0; word < 0x10000; word++) {
      udp = buildUdp(src.port, 53, Uint8Array.from([word >>> 8, word & 0xff]), src.ip, '1.1.1.1');
      setU16(udp, 6, 0);
      if (transportChecksum(src.ip, '1.1.1.1', IPPROTO_UDP, udp) === 0) break;
    }
    expect(transportChecksum(src.ip, '1.1.1.1', IPPROTO_UDP, udp)).toBe(0);
    const inside = buildUdp(55391, 53, udp.subarray(8), '192.168.1.23', '1.1.1.1');
    const packet = buildIpv4({ id: 7, df: true, ttl: 64, protocol: IPPROTO_UDP, src: '192.168.1.23', dst: '1.1.1.1' }, inside);
    const out = natRewrite(packet, { src });
    expect(parseUdp(out, 20).checksum).toBe(0xffff);
    expect(transportChecksum(src.ip, '1.1.1.1', IPPROTO_UDP, out.subarray(20))).toBe(0);
    expect(parseIpv4(out, 0).checksumValid).toBe(true);
  });

  it('round-trips a response with name compression and two A records', () => {
    const resp = buildDnsResponse(0x1a2b, 'example.com', [
      { ip: '104.20.23.154', ttl: 217 },
      { ip: '172.66.147.243', ttl: 217 },
    ]);
    const p = parseDns(resp, 0);
    expect(p.isResponse).toBe(true);
    expect(p.flags).toBe(0x8180);
    expect(p.answers.map((a) => a.ip)).toEqual(['104.20.23.154', '172.66.147.243']);
    expect(hexBytes(resp, 29, 31, '')).toBe('c00c');
    expect(resp.length).toBe(29 + 2 * 16);
  });
});

describe('RTP', () => {
  const audio = Uint8Array.from({ length: 160 }, (_, i) => 0xff - (i % 16));
  const pkt = buildRtp({ marker: false, payloadType: RTP_PT_PCMU, seq: 0x1234, timestamp: 0x89abcdef, ssrc: 0xdeadbeef }, audio);

  it('lays out the 12-byte header: 0x80 0x00 for V=2 PT=0, then seq, timestamp, SSRC, then the audio', () => {
    expect(pkt.length).toBe(172);
    expect(hexBytes(pkt, 0, 12, '')).toBe('8000123489abcdefdeadbeef');
    expect(pkt.subarray(12)).toEqual(audio);
    const marked = buildRtp({ marker: true, payloadType: 8, seq: 1, timestamp: 160, ssrc: 1 }, audio);
    expect(hexBytes(marked, 0, 4, '')).toBe('80880001');
  });

  it('parses it back, with no padding, extension or CSRCs', () => {
    expect(parseRtp(pkt, 0)).toMatchObject({ version: 2, padding: false, extension: false, csrcCount: 0, marker: false, payloadType: 0, seq: 0x1234, timestamp: 0x89abcdef, ssrc: 0xdeadbeef, payloadStart: 12, payloadEnd: 172, padLength: 0 });
    // Padding: P set and the last byte counts the filler.
    const padded = Uint8Array.from([...pkt, 0, 0, 3]);
    padded[0] = 0xa0;
    expect(parseRtp(padded, 0)).toMatchObject({ padding: true, payloadEnd: 172, padLength: 3 });
    const withCsrc = Uint8Array.from([0x81, 0, 0, 1, 0, 0, 0, 160, 1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd, 0xff, 0xff]);
    expect(parseRtp(withCsrc, 0)).toMatchObject({ csrcCount: 1, csrcs: [0xaabbccdd], payloadStart: 16, payloadEnd: 18 });
  });

  it('rides in UDP to port 5004 and is decoded there, every field explained', () => {
    const udp = buildUdp(40000, 5004, pkt, '192.168.1.23', '198.51.100.42');
    const ip = buildIpv4({ id: 9, df: true, ttl: 64, protocol: IPPROTO_UDP, src: '192.168.1.23', dst: '198.51.100.42' }, udp);
    const layers = decodePdu(ip, 'ipv4');
    expect(layers.map((l) => l.protocol)).toEqual(['ipv4', 'udp', 'rtp']);
    const rtp = layers[2]!;
    expect(rtp.summary).toBe('RTP PCMU seq 4660 · ts 2309737967 · 160 B audio (20 ms)');
    expect(rtp.headerEnd - rtp.start).toBe(12);
    const fields = describeRtp(pkt, 0, pkt.length).fields;
    expect(fields.map((f) => f.key)).toEqual(['rtp.version', 'rtp.padding', 'rtp.extension', 'rtp.cc', 'rtp.marker', 'rtp.pt', 'rtp.seq', 'rtp.timestamp', 'rtp.ssrc', 'rtp.payload']);
    for (const f of allFields([rtp])) expect(f.explain.length, f.key).toBeGreaterThan(10);
    expect(fields.find((f) => f.key === 'rtp.version')).toMatchObject({ bits: { start: 0, count: 2 }, display: '2' });
    expect(fields.find((f) => f.key === 'rtp.pt')).toMatchObject({ bits: { start: 1, count: 7 }, display: '0 (PCMU)' });
    // The same bytes from the other side come back from port 5004.
    expect(decodePdu(buildUdp(5004, 40000, pkt, '198.51.100.42', '203.0.113.7'), 'udp', { srcIp: '198.51.100.42', dstIp: '203.0.113.7' }).map((l) => l.protocol)).toEqual(['udp', 'rtp']);
  });
});

describe('DHCP', () => {
  const zero = { ciaddr: '0.0.0.0', yiaddr: '0.0.0.0', siaddr: '0.0.0.0', giaddr: '0.0.0.0' };
  const discover: DhcpMessage = {
    op: BOOTREQUEST,
    xid: 0x1a2b3c4d,
    secs: 0,
    broadcast: false,
    ...zero,
    chaddr: '3c:22:fb:5a:10:e4',
    options: { type: DHCP_DISCOVER, clientId: '3c:22:fb:5a:10:e4', hostName: 'laptop', paramRequest: [1, 3, 6, 15, 28, 51, 54] },
  };
  const offer: DhcpMessage = {
    op: BOOTREPLY,
    xid: 0x1a2b3c4d,
    secs: 0,
    broadcast: false,
    ...zero,
    yiaddr: '192.168.1.23',
    siaddr: '192.168.1.1',
    chaddr: '3c:22:fb:5a:10:e4',
    options: { type: DHCP_OFFER, serverId: '192.168.1.1', leaseTime: 86400, subnetMask: '255.255.255.0', routers: ['192.168.1.1'], dns: ['1.1.1.1'] },
  };

  it('lays out the BOOTP fixed part, the magic cookie at 236 and the message type right after it', () => {
    const b = buildDhcp(discover);
    expect(b.length).toBe(300); // padded to the BOOTP minimum
    expect(hexBytes(b, 0, 8, '')).toBe('010106001a2b3c4d'); // op 1, Ethernet, 6-byte MAC, no hops, xid
    expect(hexBytes(b, 8, 12, '')).toBe('00000000'); // secs 0, flags 0
    expect(hexBytes(b, 28, 34, '')).toBe('3c22fb5a10e4'); // chaddr
    expect(hexBytes(b, 34, 236, '')).toBe('00'.repeat(202)); // chaddr padding, sname, file
    expect(hexBytes(b, 236, 240, '')).toBe('63825363');
    expect(hexBytes(b, 240, 243, '')).toBe('350101'); // option 53, length 1, DISCOVER
    expect(hexBytes(b, 243, 252, '')).toBe('3d07013c22fb5a10e4'); // option 61, length 7: hardware type 1 + MAC
    expect(b.indexOf(0xff, 240)).toBeGreaterThan(252);
  });

  it('parses what it built, the server options included', () => {
    const d = parseDhcp(buildDhcp(discover), 0);
    expect(d).toMatchObject({ op: 1, htype: 1, hlen: 6, xid: 0x1a2b3c4d, secs: 0, broadcast: false, chaddr: '3c:22:fb:5a:10:e4', cookieValid: true });
    expect(d.options).toEqual({ type: DHCP_DISCOVER, clientId: '3c:22:fb:5a:10:e4', hostName: 'laptop', paramRequest: [1, 3, 6, 15, 28, 51, 54] });
    expect(d.raw.map((r) => r.code)).toEqual([53, 61, 12, 55, 255]);
    const o = parseDhcp(buildDhcp(offer), 0);
    expect(o).toMatchObject({ op: 2, yiaddr: '192.168.1.23', siaddr: '192.168.1.1' });
    expect(o.options).toEqual({ type: DHCP_OFFER, serverId: '192.168.1.1', leaseTime: 86400, subnetMask: '255.255.255.0', routers: ['192.168.1.1'], dns: ['1.1.1.1'] });
    const req = parseDhcp(buildDhcp({ ...discover, options: { ...discover.options, type: DHCP_REQUEST, requestedIp: '192.168.1.23', serverId: '192.168.1.1' } }), 0);
    expect(req.options).toMatchObject({ type: DHCP_REQUEST, requestedIp: '192.168.1.23', serverId: '192.168.1.1' });
    expect(parseDhcp(buildDhcp({ ...offer, broadcast: true, options: { ...offer.options, type: DHCP_ACK } }), 0)).toMatchObject({ flags: 0x8000, broadcast: true, options: { type: DHCP_ACK } });
  });

  it('decodes inside UDP from 0.0.0.0 to the broadcast address with a valid checksum, every field explained', () => {
    const udp = buildUdp(68, 67, buildDhcp(discover), '0.0.0.0', '255.255.255.255');
    const ip = buildIpv4({ id: 1, df: false, ttl: 64, protocol: IPPROTO_UDP, src: '0.0.0.0', dst: '255.255.255.255' }, udp);
    const layers = decodePdu(ip, 'ipv4');
    expect(layers.map((l) => l.protocol)).toEqual(['ipv4', 'udp', 'dhcp']);
    expect(layers[2]!.summary).toBe('DHCP DISCOVER · xid 0x1a2b3c4d');
    const fields = allFields(layers);
    for (const c of fields.filter((f) => f.key.endsWith('checksum'))) expect(c.display).toContain('✓');
    for (const f of fields) expect(f.explain.length, f.key).toBeGreaterThan(10);
    expect(fields.find((f) => f.key === 'dhcp.cookie')?.offset).toBe(28 + 236);
    expect(fields.find((f) => f.key === 'dhcp.opt.53')).toMatchObject({ offset: 28 + 240, length: 3, display: '1 (DISCOVER)', importance: 'key' });
    expect(fields.find((f) => f.key === 'dhcp.pad')).toBeTruthy();
    const reply = decodePdu(buildDhcp(offer), 'dhcp')[0]!;
    expect(reply.summary).toBe('DHCP OFFER 192.168.1.23 · xid 0x1a2b3c4d');
    expect(reply.fields.find((f) => f.key === 'dhcp.opt.51')?.display).toBe('86400 s (1 day)');
    expect(reply.fields.find((f) => f.key === 'dhcp.opt.6')?.display).toBe('1.1.1.1');
  });
});

describe('the captured walk root → TLD → authoritative (real referral bytes)', () => {
  const hops = (host: string) => DNS_TRACES[host]!.hops.map((h) => ({ ...h, q: parseDns(fromBase64(h.query), 0), r: parseDns(fromBase64(h.response), 0) }));
  const example = hops('example.com');

  it('the questions are what a resolver asks: RD=0, one A question, no EDNS, and ours are byte-identical', () => {
    for (const host of Object.keys(DNS_TRACES)) {
      for (const h of hops(host)) {
        expect(h.q.flags).toBe(0);
        expect(h.q.questions).toEqual([{ name: host, type: DNS_TYPE_A, cls: 1 }]);
        expect(h.q.additional).toHaveLength(0);
        expect(buildDnsQuery(h.q.id, host, false)).toEqual(fromBase64(h.query));
        expect(h.r.id).toBe(h.q.id);
      }
    }
  });

  it('the root refers example.com to the 13 .com servers, with the glue that fit in 512 bytes (truncated)', () => {
    const [root] = example;
    expect(root!.server).toEqual({ name: 'a.root-servers.net', ip: '198.41.0.4' });
    const r = root!.r;
    expect([r.answers.length, r.authority.length, r.additional.length]).toEqual([0, 13, 11]);
    expect(r.truncated).toBe(true);
    expect(r.authority[0]).toMatchObject({ name: 'com', type: DNS_TYPE_NS, target: 'l.gtld-servers.net', ttl: 172800 });
    expect(r.authority.every((a) => a.type === DNS_TYPE_NS && a.name === 'com')).toBe(true);
    expect(r.additional.find((a) => a.name === 'l.gtld-servers.net' && a.type === DNS_TYPE_A)?.ip).toBe('192.41.162.30');
    expect(r.additional.filter((a) => a.type === DNS_TYPE_AAAA).length).toBeGreaterThan(0);
    const ref = dnsReferral(r)!;
    expect(ref.zone).toBe('com');
    expect(ref.servers[0]).toEqual({ name: 'l.gtld-servers.net', ip: '192.41.162.30' });
    expect(example[1]!.server.ip).toBe(ref.servers.find((s) => s.ip)!.ip);
  });

  it('the .com server refers to the site’s own servers, with their addresses', () => {
    const r = example[1]!.r;
    expect([r.answers.length, r.authority.length, r.additional.length]).toEqual([0, 2, 12]);
    expect(dnsReferral(r)).toMatchObject({ zone: 'example.com', servers: [{ name: 'hera.ns.cloudflare.com', ip: '108.162.192.162' }, { name: 'elliott.ns.cloudflare.com' }] });
    expect(example[2]!.server).toEqual({ name: 'hera.ns.cloudflare.com', ip: '108.162.192.162' });
  });

  it('the authoritative server answers with AA set and the addresses', () => {
    const r = example[2]!.r;
    expect(r.flags).toBe(0x8400);
    expect(dnsReferral(r)).toBeUndefined();
    expect(dnsAddresses(r)).toEqual(['104.20.23.154', '172.66.147.243']);
    expect(r.answers[0]!.ttl).toBe(300);
  });

  it('info.cern.ch is an alias: a CNAME, then the address under the real name', () => {
    const r = hops('info.cern.ch')[2]!.r;
    expect(r.answers.map((a) => a.type)).toEqual([DNS_TYPE_CNAME, DNS_TYPE_A]);
    expect(r.answers[0]!.target).toBe('webafs902.cern.ch');
    expect(r.answers[1]).toMatchObject({ name: 'webafs902.cern.ch', ip: '188.184.67.127' });
    expect(dnsAddresses(r)).toEqual(['188.184.67.127']);
  });

  it('a name under a domain: .com refers to the domain\'s servers, and the first of them answers for the name', () => {
    const [, com, auth] = hops('connection-lab.rangner.com');
    const ref = dnsReferral(com!.r)!;
    expect(ref.zone).toBe('rangner.com');
    expect(ref.servers).toEqual([{ name: 'ns01.one.com', ip: '195.206.121.10' }, { name: 'ns02.one.com', ip: '185.10.11.10' }]);
    expect(auth!.server.ip).toBe('195.206.121.10');
    expect(dnsAddresses(auth!.r)).toEqual(['46.30.215.38']);
  });

  it('describes every record of every section with an explanation, and sums a referral up as who to ask', () => {
    for (const host of Object.keys(DNS_TRACES)) {
      for (const h of hops(host)) {
        for (const bytes of [fromBase64(h.query), fromBase64(h.response)]) {
          const [dns] = decodePdu(bytes, 'dns');
          for (const f of allFields([dns!])) {
            expect(f.explain.length, `${f.key} needs an explanation`).toBeGreaterThan(10);
            expect(f.display).not.toBe('');
          }
        }
      }
    }
    const [dns] = decodePdu(fromBase64(example[0]!.response), 'dns');
    expect(dns!.summary).toMatch(/^DNS referral 0x[0-9a-f]{4}: example\.com → com NS l\.gtld-servers\.net, j\.gtld-servers\.net, …$/);
    expect(dns!.fields.filter((f) => f.key === 'dns.authority')).toHaveLength(13);
    expect(dns!.fields.filter((f) => f.key === 'dns.additional')).toHaveLength(11);
    expect(allFields([dns!]).find((f) => f.key === 'dns.rr.addr6')?.display).toBe('2001:500:d937::30');
    expect(decodePdu(fromBase64(example[2]!.response), 'dns')[0]!.summary).toMatch(/^DNS response 0x[0-9a-f]{4}: example\.com A 104\.20\.23\.154, 172\.66\.147\.243$/);
  });

  it('writes IPv6 addresses the usual way', () => {
    expect(bytesToIp6(Uint8Array.from([0x20, 0x01, 0x05, 0x00, 0xd9, 0x37, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x30]), 0)).toBe('2001:500:d937::30');
    expect(bytesToIp6(new Uint8Array(16), 0)).toBe('::');
    expect(bytesToIp6(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 0)).toBe('::1');
    expect(bytesToIp6(Uint8Array.from([0x20, 0x01, 0xd, 0xb8, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 3]), 0)).toBe('2001:db8:1:0:2::3');
  });
});

describe('TCP', () => {
  it('lays out Linux SYN options in 20 bytes (data offset 10)', () => {
    const opts = encodeOptions([
      { kind: 'mss', mss: 1460 },
      { kind: 'sackPerm' },
      { kind: 'ts', val: 1, ecr: 0 },
      { kind: 'nop' },
      { kind: 'ws', shift: 7 },
    ]);
    expect(opts.length).toBe(20);
    expect(hexBytes(Uint8Array.from(opts), 0, 4, '')).toBe('020405b4');
  });

  it('builds a SYN with a valid checksum and parses the options back', () => {
    const seg = buildTcp(
      {
        srcPort: 41879,
        dstPort: 80,
        seq: 0xdeadbeef,
        ack: 0,
        flags: TCP_SYN,
        window: 64240,
        options: [{ kind: 'mss', mss: 536 }, { kind: 'sackPerm' }, { kind: 'ts', val: 5, ecr: 0 }, { kind: 'nop' }, { kind: 'ws', shift: 7 }],
      },
      new Uint8Array(0),
      '192.168.1.23',
      '104.20.23.154',
    );
    const t = parseTcp(seg, 0);
    expect(t.headerLen).toBe(40);
    expect(t.seq).toBe(0xdeadbeef);
    expect(t.options.find((o) => o.kind === 'mss')).toEqual({ kind: 'mss', mss: 536 });
    const ip = buildIpv4({ id: 1, df: true, ttl: 64, protocol: IPPROTO_TCP, src: '192.168.1.23', dst: '104.20.23.154' }, seg);
    const layers = decodePdu(ip, 'ipv4');
    expect(allFields(layers).find((f) => f.key === 'tcp.checksum')?.display).toContain('✓');
  });

  it('decodes an HTTP request carried in a segment', () => {
    const req = ascii('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
    const seg = buildTcp({ srcPort: 41879, dstPort: 80, seq: 1, ack: 1, flags: 0x18, window: 502, options: [] }, req, '192.168.1.23', '104.20.23.154');
    const ip = buildIpv4({ id: 2, df: true, ttl: 64, protocol: IPPROTO_TCP, src: '192.168.1.23', dst: '104.20.23.154' }, seg);
    const frame = buildEthernet({ dst: 'a4:91:b1:7d:02:01', src: '3c:22:fb:5a:10:e4', type: ETHERTYPE_IPV4 }, ip);
    const layers = decodePdu(frame, 'ethernet');
    expect(layers.map((l) => l.protocol)).toEqual(['ethernet', 'ipv4', 'tcp', 'http']);
    expect(layers[3]!.summary).toBe('HTTP GET / HTTP/1.1');
  });
});

describe('ICMP (RFC 792)', () => {
  const data = pingData(12.345678);
  const echo = buildIcmp({ type: ICMP_ECHO, id: 0x1234, seq: 1, data });

  it('builds an echo request: type 8, code 0, checksum, id, seq, then ping’s 56 data bytes', () => {
    expect(echo.length).toBe(64);
    expect(hexBytes(echo, 0, 2, '')).toBe('0800');
    expect(hexBytes(echo, 4, 8, '')).toBe('12340001');
    // The inverse-sum rule: with the checksum in place the whole message sums to all ones, so the sum comes out 0.
    expect(internetChecksum(echo)).toBe(0);
    expect(internetChecksum(echo, 0, 2) === 0).toBe(false);
    // Hand-checked: an empty echo request is 08 00 00 00 … → the only word is 0x0800, so the checksum is ~0x0800 = 0xf7ff.
    expect(hexBytes(buildIcmp({ type: ICMP_ECHO, id: 0, seq: 0, data: new Uint8Array(0) }), 0, 8, '')).toBe('0800f7ff00000000');
    expect(hexBytes(buildIcmp({ type: ICMP_ECHO_REPLY, id: 0, seq: 0, data: new Uint8Array(0) }), 0, 4, '')).toBe('0000ffff');
    const p = parseIcmp(echo, 0, echo.length);
    expect(p).toMatchObject({ type: 8, code: 0, checksumValid: true, id: 0x1234, seq: 1, dataStart: 8 });
  });

  it('ping’s data: a little-endian struct timeval of the sending time, then the bytes 0x10 … 0x37', () => {
    expect(data.length).toBe(56);
    expect(hexBytes(data, 0, 16, '')).toBe('0c00000000000000' + '4e46050000000000'); // 12 s, 345678 µs = 0x0000000000054 64e
    expect([...data.subarray(16)]).toEqual(Array.from({ length: 40 }, (_, i) => 0x10 + i));
    expect(pingTimestamp(data)).toBeCloseTo(12.345678, 6);
  });

  it('a Time Exceeded quotes the offending datagram’s IP header and its first 8 bytes, and decodes with every field explained', () => {
    const probe = buildIpv4({ id: 9, df: true, ttl: 1, protocol: IPPROTO_UDP, src: '203.0.113.7', dst: '104.20.23.154' }, buildUdp(24186, 33434, new Uint8Array(32), '203.0.113.7', '104.20.23.154'));
    const err = buildIcmp({ type: ICMP_TIME_EXCEEDED, code: ICMP_TTL_EXCEEDED, original: probe });
    expect(err.length).toBe(8 + 20 + 8);
    expect(hexBytes(err, 0, 2, '')).toBe('0b00');
    expect(hexBytes(err, 4, 8, '')).toBe('00000000');
    expect(err.slice(8)).toEqual(probe.slice(0, 28));
    expect(internetChecksum(err)).toBe(0);
    const p = parseIcmp(err, 0, err.length);
    expect(p.quoted).toMatchObject({ start: 8, srcPort: 24186, dstPort: 33434 });
    expect(p.quoted!.ip).toMatchObject({ src: '203.0.113.7', dst: '104.20.23.154', ttl: 1, protocol: IPPROTO_UDP });
    const ip = buildIpv4({ id: 1, df: false, ttl: 64, protocol: IPPROTO_ICMP, src: '203.0.113.1', dst: '203.0.113.7' }, err);
    expect(ip.length).toBe(56);
    const layers = decodePdu(ip, 'ipv4');
    expect(layers.map((l) => l.protocol)).toEqual(['ipv4', 'icmp']);
    expect(layers[1]!.summary).toBe('ICMP time exceeded: TTL expired in transit · about UDP 203.0.113.7:24186 → 104.20.23.154:33434');
    const fields = allFields(layers);
    expect(fields.map((f) => f.key)).toEqual(expect.arrayContaining(['icmp.type', 'icmp.code', 'icmp.checksum', 'icmp.unused', 'icmp.original', 'icmp.orig.src', 'icmp.orig.dst', 'icmp.orig.ttl', 'icmp.orig.proto', 'icmp.orig.sport', 'icmp.orig.dport']));
    for (const f of fields) {
      expect(f.explain.length, f.key).toBeGreaterThan(10);
      expect(f.display, f.key).not.toContain('✗');
    }
    const port = buildIcmp({ type: ICMP_DEST_UNREACHABLE, code: ICMP_PORT_UNREACHABLE, original: probe });
    expect(decodePdu(port, 'icmp')[0]!.summary).toMatch(/^ICMP destination unreachable: port unreachable · about UDP/);
    const echoLayers = decodePdu(buildIpv4({ id: 1, df: true, ttl: 64, protocol: IPPROTO_ICMP, src: '192.168.1.23', dst: '104.20.23.154' }, echo), 'ipv4');
    expect(allFields(echoLayers).map((f) => f.key)).toEqual(expect.arrayContaining(['icmp.id', 'icmp.seq', 'icmp.data', 'icmp.timestamp', 'icmp.pattern']));
    for (const f of allFields(echoLayers)) expect(f.explain.length, f.key).toBeGreaterThan(10);
  });

  it('NAT translates an echo’s identifier like a port, and an error’s quoted header back, keeping every checksum right', () => {
    const inside = { ip: '192.168.1.23', port: 41879 };
    const outside = { ip: '203.0.113.7', port: 24186 };
    const request = buildIpv4({ id: 3, df: true, ttl: 64, protocol: IPPROTO_ICMP, src: inside.ip, dst: '104.20.23.154' }, buildIcmp({ type: ICMP_ECHO, id: 0x9977, seq: 2, data }));
    const out = natRewrite(request, { src: { ip: outside.ip, port: 0x5e7a } });
    expect(parseIpv4(out, 0)).toMatchObject({ src: outside.ip, checksumValid: true });
    expect(parseIcmp(out, 20, out.length)).toMatchObject({ id: 0x5e7a, seq: 2, checksumValid: true });
    expect(out.slice(28)).toEqual(request.slice(28));

    // A probe leaves the home: its ports and checksums change. A router's error about it quotes the outside header; the
    // home router turns the quote back into the probe as the laptop sent it, byte for byte, UDP checksum included.
    const probe = buildIpv4({ id: 9, df: true, ttl: 2, protocol: IPPROTO_UDP, src: inside.ip, dst: '104.20.23.154' }, buildUdp(inside.port, 33437, Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i), inside.ip, '104.20.23.154'));
    const translated = natRewrite(probe, { src: outside });
    expect(translated.slice(0, 28)).not.toEqual(probe.slice(0, 28));
    const err = buildIpv4({ id: 1, df: false, ttl: 64, protocol: IPPROTO_ICMP, src: '203.0.113.1', dst: outside.ip }, buildIcmp({ type: ICMP_TIME_EXCEEDED, code: ICMP_TTL_EXCEEDED, original: translated }));
    const back = natRewrite(err, { dst: inside });
    expect(parseIpv4(back, 0)).toMatchObject({ src: '203.0.113.1', dst: inside.ip, checksumValid: true });
    const m = parseIcmp(back, 20, back.length);
    expect(m.checksumValid).toBe(true);
    expect(m.quoted).toMatchObject({ srcPort: inside.port, dstPort: 33437 });
    expect(back.slice(28)).toEqual(probe.slice(0, 28));
    expect(parseIpv4(back, 28).checksumValid).toBe(true);
  });
});

describe('Wi-Fi (IEEE 802.11)', () => {
  const phone = 'f0:5c:77:3e:91:2a';
  const ap = 'a4:91:b1:7d:02:03';
  const data = (retry: boolean) => buildWifi({ toAp: true, addr1: ap, addr2: phone, addr3: ap, seq: 7, type: ETHERTYPE_IPV4, retry }, Uint8Array.from([0x45, 0, 0, 0]));

  it('an Ack is 14 bytes: Frame Control d4 00, Duration 0, the receiver, a CRC-32 like Ethernet', () => {
    const ack = buildWifiAck(phone);
    expect(ack.length).toBe(WIFI_ACK_LEN);
    // CRC-32 of d4 00 00 00 f0 5c 77 3e 91 2a is 0x36fd5ea4, little-endian on air.
    expect(hexBytes(ack, 0, 14, '')).toBe('d4000000f05c773e912aa45efd36');
    expect(wifiFrameKind(ack)).toBe('ack');
    expect(parseWifiAck(ack)).toEqual({ ra: phone, fcsValid: true });
    const damaged = ack.slice();
    damaged[5] = (damaged[5] ?? 0) ^ 0x01;
    expect(parseWifiAck(damaged).fcsValid).toBe(false);
    const [layer, ...rest] = decodePdu(ack, 'wifi');
    expect(rest).toEqual([]);
    expect(layer).toMatchObject({ protocol: 'wifi', layer: 2, headerEnd: 10, payloadEnd: 10, end: 14, summary: `Wi-Fi ACK → ${phone}` });
    expect(layer!.fields.map((f) => [f.key, f.offset, f.length])).toEqual([['wifi.fc', 0, 2], ['wifi.duration', 2, 2], ['wifi.ra', 4, 6], ['wifi.fcs', 10, 4]]);
    expect(layer!.fields.find((f) => f.key === 'wifi.fc')?.display).toBe('0xd400 (control, Ack)');
    for (const f of allFields([layer!])) expect(f.explain.length, f.key).toBeGreaterThan(10);
  });

  it('the Retry bit is bit 3 of the second Frame Control byte, and a retried frame keeps its sequence number', () => {
    const first = data(false);
    const again = data(true);
    expect([first[0], first[1]]).toEqual([0x08, 0x01]);
    expect([again[0], again[1]]).toEqual([0x08, 0x09]);
    expect(wifiFrameKind(first)).toBe('data');
    expect(parseWifi(first)).toMatchObject({ retry: false, seq: 7, toAp: true, fcsValid: true });
    expect(parseWifi(again)).toMatchObject({ retry: true, seq: 7, toAp: true, fcsValid: true, addr1: ap, addr2: phone, dst: ap, src: phone });
    // Only that bit and the FCS differ.
    expect(hexBytes(first, 2, first.length - 4)).toBe(hexBytes(again, 2, again.length - 4));
    expect(hexBytes(first, first.length - 4)).not.toBe(hexBytes(again, again.length - 4));
    const retryField = (frame: Uint8Array) => decodePdu(frame, 'wifi')[0]!.fields.find((f) => f.key === 'wifi.retry')!;
    expect(retryField(first)).toMatchObject({ offset: 1, length: 1, bits: { start: 12, count: 1 }, display: '0', importance: 'detail' });
    expect(retryField(again)).toMatchObject({ display: '1 (sent again)', importance: 'key' });
    expect(retryField(again).explain).toContain('no acknowledgement');
    expect(decodePdu(again, 'wifi')[0]!.summary).toContain('retry');
    expect(decodePdu(first, 'wifi')[0]!.summary).not.toContain('retry');
    for (const f of allFields(decodePdu(again, 'wifi'))) expect(f.explain.length, f.key).toBeGreaterThan(10);
  });
});
