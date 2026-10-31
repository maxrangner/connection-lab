import type { Ip4 } from '../bytes/addr';
import { ByteWriter, hex, setU16, u16 } from '../bytes/bytes';
import { transportChecksum } from '../bytes/checksum';
import { IPPROTO_UDP } from './ipv4';
import { FieldList, type LayerPdu } from './types';

export const UDP_HEADER_LEN = 8;

export function buildUdp(srcPort: number, dstPort: number, payload: Uint8Array, srcIp: Ip4, dstIp: Ip4): Uint8Array {
  const out = new ByteWriter()
    .u16(srcPort)
    .u16(dstPort)
    .u16(UDP_HEADER_LEN + payload.length)
    .u16(0)
    .bytes(payload)
    .toBytes();
  let c = transportChecksum(srcIp, dstIp, IPPROTO_UDP, out);
  if (c === 0) c = 0xffff; // RFC 768: a computed 0 is sent as all ones (0 means "no checksum")
  setU16(out, 6, c);
  return out;
}

export interface ParsedUdp {
  srcPort: number;
  dstPort: number;
  length: number;
  checksum: number;
  payloadStart: number;
  payloadEnd: number;
}

export function parseUdp(b: Uint8Array, o: number): ParsedUdp {
  const length = u16(b, o + 4);
  return {
    srcPort: u16(b, o),
    dstPort: u16(b, o + 2),
    length,
    checksum: u16(b, o + 6),
    payloadStart: o + UDP_HEADER_LEN,
    payloadEnd: o + length,
  };
}

export function portName(p: number): string {
  if (p === 53) return ' (DNS)';
  if (p === 67) return ' (DHCP server)';
  if (p === 68) return ' (DHCP client)';
  if (p === 80) return ' (HTTP)';
  if (p === 443) return ' (HTTPS)';
  if (p === 5004) return ' (RTP)';
  if (p >= 32768) return ' (ephemeral)';
  return '';
}

export function describeUdp(b: Uint8Array, o: number, srcIp?: Ip4, dstIp?: Ip4): LayerPdu {
  const p = parseUdp(b, o);
  const valid =
    srcIp && dstIp ? transportChecksum(srcIp, dstIp, IPPROTO_UDP, b.subarray(o, o + p.length)) === 0 : undefined;
  const f = new FieldList();
  f.add('udp.srcport', 'Source port', o, 2, `${p.srcPort}${portName(p.srcPort)}`, 'key', 'Port of the sending program. Clients pick a random high "ephemeral" port so replies find their way back to the right socket.');
  f.add('udp.dstport', 'Destination port', o + 2, 2, `${p.dstPort}${portName(p.dstPort)}`, 'key', 'Port of the receiving program. Well-known services listen on fixed ports, for example DNS on 53.');
  f.add('udp.len', 'Length', o + 4, 2, `${p.length} bytes`, 'detail', 'Length of the UDP header (8 bytes) plus its payload.');
  f.add('udp.checksum', 'Checksum', o + 6, 2, `${hex(p.checksum, 4)}${valid === undefined ? '' : valid ? ' ✓' : ' ✗'}`, 'detail', "Covers the UDP header, the data and a pseudo-header of source IP, destination IP, protocol and length. NAT must recompute it after changing addresses or ports.");
  return {
    protocol: 'udp',
    layer: 4,
    start: o,
    headerEnd: o + UDP_HEADER_LEN,
    payloadEnd: o + p.length,
    end: o + p.length,
    summary: `UDP ${p.srcPort} → ${p.dstPort} · ${p.length - UDP_HEADER_LEN} B data`,
    fields: f.list,
  };
}
