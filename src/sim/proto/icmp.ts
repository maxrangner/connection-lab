import { ByteWriter, hex, setU16, u16, u8 } from '../bytes/bytes';
import { internetChecksum } from '../bytes/checksum';
import { IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP, ipProtoName, parseIpv4, type ParsedIpv4 } from './ipv4';
import { FieldList, type Field, type LayerPdu } from './types';

/** RFC 792 message types used here. */
export const ICMP_ECHO_REPLY = 0;
export const ICMP_DEST_UNREACHABLE = 3;
export const ICMP_ECHO = 8;
export const ICMP_TIME_EXCEEDED = 11;
/** Codes. */
export const ICMP_PORT_UNREACHABLE = 3;
export const ICMP_TTL_EXCEEDED = 0;

export const ICMP_HEADER_LEN = 8;
/** Linux ping sends 56 data bytes: the classic 64-byte ICMP message, 84 bytes of IP. */
export const PING_DATA_LEN = 56;
/** The timestamp at the start of ping's data: a struct timeval, two 8-byte little-endian integers on x86-64. */
const TIMEVAL_LEN = 16;
/** An ICMP error quotes the offending datagram's IP header plus this many bytes after it (RFC 792). */
export const ICMP_QUOTE_LEN = 8;

export type IcmpMessage =
  | { type: typeof ICMP_ECHO | typeof ICMP_ECHO_REPLY; id: number; seq: number; data: Uint8Array }
  /** An error about `original`, a whole IP datagram: its header and the first 8 bytes after it are quoted. */
  | { type: typeof ICMP_DEST_UNREACHABLE | typeof ICMP_TIME_EXCEEDED; code: number; original: Uint8Array };

export function isIcmpError(type: number): boolean {
  return type === ICMP_DEST_UNREACHABLE || type === ICMP_TIME_EXCEEDED;
}

/** Builds an ICMP message with its checksum filled in (RFC 1071 over the whole message, no pseudo-header). */
export function buildIcmp(m: IcmpMessage): Uint8Array {
  const w = new ByteWriter().u8(m.type);
  if ('id' in m) {
    w.u8(0).u16(0).u16(m.id).u16(m.seq).bytes(m.data);
  } else {
    const ip = parseIpv4(m.original, 0);
    w.u8(m.code).u16(0).u32(0).bytes(m.original.subarray(0, ip.headerLen + ICMP_QUOTE_LEN));
  }
  const out = w.toBytes();
  setU16(out, 2, internetChecksum(out));
  return out;
}

/**
 * The 56 data bytes Linux ping sends: the time of sending as a struct timeval (seconds, then microseconds, each 8 bytes
 * little-endian as on x86-64: the sender alone reads it back from the reply to time the round trip), then one byte per
 * offset, 0x10 up to 0x37, so a garbled reply would show.
 */
export function pingData(now: number): Uint8Array {
  const sec = Math.floor(now);
  const usec = Math.round((now - sec) * 1e6);
  const out = new Uint8Array(PING_DATA_LEN);
  for (let i = 0; i < 8; i++) {
    out[i] = Math.floor(sec / 2 ** (8 * i)) & 0xff;
    out[8 + i] = Math.floor(usec / 2 ** (8 * i)) & 0xff;
  }
  for (let i = TIMEVAL_LEN; i < PING_DATA_LEN; i++) out[i] = i;
  return out;
}

/** Reads ping's timeval back (seconds), or undefined when the data is too short to hold one. */
export function pingTimestamp(data: Uint8Array): number | undefined {
  if (data.length < TIMEVAL_LEN) return undefined;
  let sec = 0;
  let usec = 0;
  for (let i = 7; i >= 0; i--) {
    sec = sec * 256 + (data[i] ?? 0);
    usec = usec * 256 + (data[8 + i] ?? 0);
  }
  return sec + usec / 1e6;
}

export interface ParsedIcmp {
  type: number;
  code: number;
  checksum: number;
  checksumValid: boolean;
  /** Echo request / reply. */
  id?: number;
  seq?: number;
  /** Where the echo data starts. */
  dataStart: number;
  /** An error's quoted datagram: where its IP header starts, what it says, and the transport words after it. */
  quoted?: {
    start: number;
    ip: ParsedIpv4;
    /** For UDP and TCP the ports; for a quoted echo its identifier (and 0). */
    srcPort: number;
    dstPort: number;
  };
  end: number;
}

export function parseIcmp(b: Uint8Array, o: number, end: number): ParsedIcmp {
  const type = u8(b, o);
  const p: ParsedIcmp = {
    type,
    code: u8(b, o + 1),
    checksum: u16(b, o + 2),
    checksumValid: internetChecksum(b, o, end) === 0,
    dataStart: o + ICMP_HEADER_LEN,
    end,
  };
  if (type === ICMP_ECHO || type === ICMP_ECHO_REPLY) {
    p.id = u16(b, o + 4);
    p.seq = u16(b, o + 6);
  } else if (isIcmpError(type) && end - o >= ICMP_HEADER_LEN + 20) {
    const start = o + ICMP_HEADER_LEN;
    const ip = parseIpv4(b, start);
    const l4 = start + ip.headerLen;
    const echo = ip.protocol === IPPROTO_ICMP;
    p.quoted = { start, ip, srcPort: echo ? u16(b, l4 + 4) : u16(b, l4), dstPort: echo ? 0 : u16(b, l4 + 2) };
  }
  return p;
}

export function icmpTypeName(type: number, code: number): string {
  switch (type) {
    case ICMP_ECHO_REPLY:
      return 'echo reply';
    case ICMP_ECHO:
      return 'echo request';
    case ICMP_TIME_EXCEEDED:
      return code === ICMP_TTL_EXCEEDED ? 'time exceeded: TTL expired in transit' : 'time exceeded: fragment reassembly';
    case ICMP_DEST_UNREACHABLE:
      return `destination unreachable: ${['net', 'host', 'protocol', 'port'][code] ?? `code ${code}`} unreachable`;
    default:
      return `type ${type}`;
  }
}

/** "UDP 203.0.113.7:40000 → 104.16.1.2:33434", what an error says it is about. */
export function quotedSummary(q: NonNullable<ParsedIcmp['quoted']>): string {
  const proto = ipProtoName(q.ip.protocol);
  if (q.ip.protocol === IPPROTO_ICMP) return `${proto} echo id ${hex(q.srcPort, 4)} ${q.ip.src} → ${q.ip.dst}`;
  return `${proto} ${q.ip.src}:${q.srcPort} → ${q.ip.dst}:${q.dstPort}`;
}

function describeQuoted(b: Uint8Array, q: NonNullable<ParsedIcmp['quoted']>): Field[] {
  const o = q.start;
  const l4 = o + q.ip.headerLen;
  const out: Field[] = [
    { key: 'icmp.orig.src', name: 'Source IP', offset: o + 12, length: 4, display: q.ip.src, importance: 'key', explain: 'Who sent the packet that went wrong: this error goes back to that address. Behind NAT it is the public address the router wrote in, so the router must translate it back before the inside host recognises its own packet.' },
    { key: 'icmp.orig.dst', name: 'Destination IP', offset: o + 16, length: 4, display: q.ip.dst, importance: 'key', explain: 'Where the packet was going when it ran into trouble.' },
    { key: 'icmp.orig.ttl', name: 'Time to Live', offset: o + 8, length: 1, display: String(q.ip.ttl), importance: 'key', explain: 'The TTL as the router received it. 1 means this hop was the last one allowed: the router may not forward it, so it reports back instead. That is exactly what traceroute counts on.' },
    { key: 'icmp.orig.proto', name: 'Protocol', offset: o + 9, length: 1, display: `${q.ip.protocol} (${ipProtoName(q.ip.protocol)})`, importance: 'detail', explain: 'What the quoted packet carried, so the 8 bytes after the header can be read as ports or as an echo identifier.' },
  ];
  if (q.ip.protocol === IPPROTO_UDP || q.ip.protocol === IPPROTO_TCP) {
    out.push(
      { key: 'icmp.orig.sport', name: 'Source port', offset: l4, length: 2, display: String(u16(b, l4)), importance: 'key', explain: 'The port the packet was sent from. The sender matches it to the socket that sent the packet, so the right program hears about the error.' },
      { key: 'icmp.orig.dport', name: 'Destination port', offset: l4 + 2, length: 2, display: String(u16(b, l4 + 2)), importance: 'key', explain: 'The port the packet was sent to. traceroute gives each probe its own port (33434 and up), so the port here says which probe this error answers.' },
    );
  } else if (q.ip.protocol === IPPROTO_ICMP) {
    out.push(
      { key: 'icmp.orig.id', name: 'Identifier', offset: l4 + 4, length: 2, display: hex(u16(b, l4 + 4), 4), importance: 'key', explain: 'The identifier of the quoted echo request, so ping knows the error is about one of its own.' },
      { key: 'icmp.orig.seq', name: 'Sequence number', offset: l4 + 6, length: 2, display: String(u16(b, l4 + 6)), importance: 'key', explain: 'Which echo request went wrong.' },
    );
  }
  return out;
}

export function describeIcmp(b: Uint8Array, o: number, end: number): LayerPdu {
  const p = parseIcmp(b, o, end);
  const f = new FieldList();
  const echo = p.type === ICMP_ECHO || p.type === ICMP_ECHO_REPLY;
  const name = icmpTypeName(p.type, p.code);
  f.add('icmp.type', 'Type', o, 1, `${p.type} (${name.split(':')[0]})`, 'key',
    p.type === ICMP_ECHO ? 'Echo Request: "are you there? send this back." Ping sends these.'
    : p.type === ICMP_ECHO_REPLY ? 'Echo Reply: the answer to an Echo Request, carrying the same identifier, sequence number and data.'
    : p.type === ICMP_TIME_EXCEEDED ? 'Time Exceeded: a router had to throw the packet away because its TTL reached zero. Sent to the packet\'s source so it learns where its packet died; traceroute makes packets die on purpose, one hop further each time.'
    : p.type === ICMP_DEST_UNREACHABLE ? 'Destination Unreachable: the packet arrived somewhere it could not be delivered. The code says why.'
    : 'What kind of ICMP message this is. ICMP carries the Internet\'s control and error messages inside IP, protocol 1.');
  f.add('icmp.code', 'Code', o + 1, 1, echo ? `${p.code}` : `${p.code} (${name.split(': ')[1] ?? ''})`, echo ? 'detail' : 'key',
    echo ? 'Always 0 for echo messages.'
    : p.type === ICMP_TIME_EXCEEDED ? 'Code 0: the TTL ran out in transit, at this router. (Code 1 would mean a fragment reassembly timed out.)'
    : p.code === ICMP_PORT_UNREACHABLE ? 'Code 3: the host is there, but no program listens on that UDP port. traceroute sends to ports nobody uses, so this answer means "you reached the destination".'
    : 'Why the packet could not be delivered: 0 network, 1 host, 2 protocol, 3 port unreachable.');
  f.add('icmp.checksum', 'Checksum', o + 2, 2, `${hex(p.checksum, 4)} ${p.checksumValid ? '✓' : '✗'}`, 'detail',
    "Ones' complement sum over the whole ICMP message, header and data (RFC 1071), the same sum IPv4 uses for its header. There is no pseudo-header, so NAT only recomputes it when it changes the message itself: the identifier, or a quoted header.");
  if (echo) {
    f.add('icmp.id', 'Identifier', o + 4, 2, `${hex(p.id ?? 0, 4)} (${p.id})`, 'key', 'Tells echo replies apart by program: Linux ping uses its process id, so two pings running at once each get their own replies. A NAT router uses it the way it uses a port, and may rewrite it.');
    f.add('icmp.seq', 'Sequence number', o + 6, 2, String(p.seq), 'key', 'Counts the requests 1, 2, 3 … The reply carries the same number, so ping knows which request it answers and sees which ones never came back.');
    const dataLen = end - p.dataStart;
    const ts = pingTimestamp(b.subarray(p.dataStart, end));
    f.add('icmp.data', 'Data', p.dataStart, dataLen, `${dataLen} bytes`, 'key',
      p.type === ICMP_ECHO ? 'Whatever the sender likes; the reply must send it back unchanged. Linux ping sends 56 bytes: when it sent the request, then a pattern.' : 'The request\'s data, sent back unchanged. Ping reads its own timestamp out of it to measure the round trip.', {
      children: dataLen >= TIMEVAL_LEN ? [
        { key: 'icmp.timestamp', name: 'Timestamp', offset: p.dataStart, length: TIMEVAL_LEN, display: `${(ts ?? 0).toFixed(6)} s`, importance: 'detail', explain: 'When ping sent the request: a struct timeval, seconds then microseconds, each 8 bytes little-endian as on an x86-64 machine (only the sender reads it back, so it need not be in network order). The reply echoes it; the difference from the clock on arrival is the round-trip time. Here the clock is the simulation\'s, counting from the start of the run.' },
        { key: 'icmp.pattern', name: 'Pattern', offset: p.dataStart + TIMEVAL_LEN, length: dataLen - TIMEVAL_LEN, display: `${hex(u8(b, p.dataStart + TIMEVAL_LEN), 2)} … ${hex(u8(b, end - 1), 2)}`, importance: 'detail', explain: 'One byte per position, 0x10 up to 0x37: each byte is its own offset in the data, so a reply that came back garbled would show at once.' },
      ] : [],
    });
  } else if (p.quoted) {
    f.add('icmp.unused', 'Unused', o + 4, 4, hex(u16(b, o + 4) * 65536 + u16(b, o + 6), 8), 'detail', 'Four bytes RFC 792 leaves at zero. Later RFCs use them for other codes, for example the next-hop MTU when a packet is too big.');
    f.add('icmp.original', 'Original datagram', p.quoted.start, end - p.quoted.start, quotedSummary(p.quoted), 'key',
      'The start of the packet this error is about: its IP header and the first 8 bytes after it, enough for the ports. The sender uses it to tell which of its packets went wrong, and a NAT router to find whose packet it was. RFC 792 quotes 8 bytes, the classic; Linux actually quotes up to 576 bytes as RFC 1812 allows.',
      { children: describeQuoted(b, p.quoted) });
  }
  const summary = echo
    ? `ICMP ${name} · id ${hex(p.id ?? 0, 4)} seq ${p.seq} · ${end - p.dataStart} B data`
    : `ICMP ${name}${p.quoted ? ` · about ${quotedSummary(p.quoted)}` : ''}`;
  return {
    protocol: 'icmp',
    layer: 3,
    start: o,
    headerEnd: o + ICMP_HEADER_LEN,
    payloadEnd: end,
    end,
    summary,
    fields: f.list,
  };
}
