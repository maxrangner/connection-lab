import { bytesToIp, ipToBytes, type Ip4 } from '../bytes/addr';
import { ByteWriter, hex, setU16, u16, u8 } from '../bytes/bytes';
import { internetChecksum } from '../bytes/checksum';
import { bitField, FieldList, type LayerPdu } from './types';

export const IPPROTO_ICMP = 1;
export const IPPROTO_TCP = 6;
export const IPPROTO_UDP = 17;
export const IPV4_HEADER_LEN = 20;

export function ipProtoName(p: number): string {
  if (p === IPPROTO_TCP) return 'TCP';
  if (p === IPPROTO_UDP) return 'UDP';
  if (p === IPPROTO_ICMP) return 'ICMP';
  return `proto ${p}`;
}

export interface Ipv4Header {
  id: number;
  df: boolean;
  ttl: number;
  protocol: number;
  src: Ip4;
  dst: Ip4;
  dscp?: number;
}

/** Builds a 20-byte IPv4 header (no options) + payload and fills in total length and header checksum. */
export function buildIpv4(h: Ipv4Header, payload: Uint8Array): Uint8Array {
  const total = IPV4_HEADER_LEN + payload.length;
  const w = new ByteWriter()
    .u8(0x45) // version 4, IHL 5 (x 4 = 20 bytes)
    .u8((h.dscp ?? 0) << 2) // DSCP + ECN
    .u16(total)
    .u16(h.id)
    .u16(h.df ? 0x4000 : 0) // flags + fragment offset
    .u8(h.ttl)
    .u8(h.protocol)
    .u16(0) // checksum placeholder
    .bytes(ipToBytes(h.src))
    .bytes(ipToBytes(h.dst))
    .bytes(payload);
  const out = w.toBytes();
  setU16(out, 10, internetChecksum(out, 0, IPV4_HEADER_LEN));
  return out;
}

export interface ParsedIpv4 extends Ipv4Header {
  ihl: number;
  totalLength: number;
  checksum: number;
  checksumValid: boolean;
  headerLen: number;
}

export function parseIpv4(b: Uint8Array, o: number): ParsedIpv4 {
  const ihl = u8(b, o) & 0x0f;
  const headerLen = ihl * 4;
  return {
    ihl,
    headerLen,
    dscp: u8(b, o + 1) >>> 2,
    totalLength: u16(b, o + 2),
    id: u16(b, o + 4),
    df: (u16(b, o + 6) & 0x4000) !== 0,
    ttl: u8(b, o + 8),
    protocol: u8(b, o + 9),
    checksum: u16(b, o + 10),
    checksumValid: internetChecksum(b, o, o + headerLen) === 0,
    src: bytesToIp(b, o + 12),
    dst: bytesToIp(b, o + 16),
  };
}

/** In-place edit of an IPv4 header field set, followed by a fresh header checksum. Returns a copy. */
export function rewriteIpv4(
  packet: Uint8Array,
  edit: { ttl?: number; src?: Ip4; dst?: Ip4 },
): Uint8Array {
  const out = packet.slice();
  if (edit.ttl !== undefined) out[8] = edit.ttl;
  if (edit.src) out.set(ipToBytes(edit.src), 12);
  if (edit.dst) out.set(ipToBytes(edit.dst), 16);
  setU16(out, 10, 0);
  setU16(out, 10, internetChecksum(out, 0, (u8(out, 0) & 0x0f) * 4));
  return out;
}

export function describeIpv4(b: Uint8Array, o: number): LayerPdu {
  const p = parseIpv4(b, o);
  const f = new FieldList();
  f.add('ipv4.verihl', 'Version / IHL', o, 1, `4 / ${p.ihl} (${p.headerLen} bytes)`, 'detail', 'High nibble: IP version 4. Low nibble: header length in 32-bit words; 5 means a plain 20-byte header without options.', {
    children: [
      bitField('ipv4.version', 'Version', o, 1, 0, 4, 4, 'detail', 'Always 4 for IPv4.'),
      bitField('ipv4.ihl', 'Header length', o, 1, 4, 4, p.ihl, 'detail', 'Header length in 4-byte words.'),
    ],
  });
  f.add('ipv4.dscp', 'DSCP / ECN', o + 1, 1, hex(u8(b, o + 1), 2), 'detail', 'Traffic class for quality-of-service and explicit congestion notification bits. 0 means ordinary best-effort traffic.');
  f.add('ipv4.len', 'Total length', o + 2, 2, `${p.totalLength} bytes`, 'detail', 'Length of the whole IP packet, header plus payload. Lets the receiver ignore any Ethernet padding after it.');
  f.add('ipv4.id', 'Identification', o + 4, 2, `${hex(p.id, 4)} (${p.id})`, 'detail', 'Labels this packet so fragments of it could be reassembled. Each sender picks its own values.');
  const flagsWord = u16(b, o + 6);
  f.add('ipv4.flags', 'Flags / Fragment offset', o + 6, 2, `${hex(flagsWord, 4)}${p.df ? " (Don't Fragment)" : ''}`, 'detail', "Don't Fragment asks routers to drop the packet rather than split it; the sender uses this to discover the path MTU. Offset 0: this is not a fragment.", {
    children: [
      bitField('ipv4.flags.rb', 'Reserved', o + 6, 2, 0, 1, (flagsWord >>> 15) & 1, 'detail', 'Must be zero.'),
      bitField('ipv4.flags.df', "Don't Fragment", o + 6, 2, 1, 1, (flagsWord >>> 14) & 1, 'detail', 'If set, a router that cannot forward the packet whole drops it and reports back.'),
      bitField('ipv4.flags.mf', 'More Fragments', o + 6, 2, 2, 1, (flagsWord >>> 13) & 1, 'detail', 'Set on every fragment except the last.'),
      bitField('ipv4.frag', 'Fragment offset', o + 6, 2, 3, 13, flagsWord & 0x1fff, 'detail', 'Where this fragment belongs, in 8-byte units.'),
    ],
  });
  f.add('ipv4.ttl', 'Time to Live', o + 8, 1, p.ttl, 'key', 'Every router subtracts 1 and drops the packet at 0, so a routing loop cannot circulate a packet forever. Linux sends with 64.');
  f.add('ipv4.proto', 'Protocol', o + 9, 1, `${p.protocol} (${ipProtoName(p.protocol)})`, 'key', 'What is inside: 6 is TCP, 17 is UDP, 1 is ICMP (ping and the error messages routers send back).');
  f.add('ipv4.checksum', 'Header checksum', o + 10, 2, `${hex(p.checksum, 4)} ${p.checksumValid ? '✓' : '✗'}`, 'detail', "Ones' complement sum over the header only. Because TTL changes at every hop, every router recomputes it.");
  f.add('ipv4.src', 'Source IP', o + 12, 4, p.src, 'key', 'Address of the sender. A home router doing NAT replaces a private source address with its own public one.');
  f.add('ipv4.dst', 'Destination IP', o + 16, 4, p.dst, 'key', 'Final destination. Routers read it to choose the next hop; it normally stays the same end to end.');
  return {
    protocol: 'ipv4',
    layer: 3,
    start: o,
    headerEnd: o + p.headerLen,
    payloadEnd: o + p.totalLength,
    end: o + p.totalLength,
    summary: `IPv4 ${p.src} → ${p.dst} · TTL ${p.ttl} · ${ipProtoName(p.protocol)}`,
    fields: f.list,
  };
}
