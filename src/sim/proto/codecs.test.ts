import { describe, expect, it } from 'vitest';
import { ascii, hexBytes, setU16 } from '../bytes/bytes';
import { transportChecksum } from '../bytes/checksum';
import { natRewrite } from '../stack/Router';
import { buildArp, parseArp } from './arp';
import { decodePdu } from './decode';
import { BOOTREPLY, BOOTREQUEST, buildDhcp, DHCP_ACK, DHCP_DISCOVER, DHCP_OFFER, DHCP_REQUEST, parseDhcp, type DhcpMessage } from './dhcp';
import { buildDnsQuery, buildDnsResponse, parseDns } from './dns';
import { buildEthernet, ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEthernet } from './ethernet';
import { buildIpv4, IPPROTO_TCP, IPPROTO_UDP, parseIpv4 } from './ipv4';
import { buildTcp, encodeOptions, parseTcp, TCP_SYN } from './tcp';
import type { Field, LayerPdu } from './types';
import { buildUdp, parseUdp } from './udp';

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
