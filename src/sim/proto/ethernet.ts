import { bytesToMac, macToBytes, BROADCAST_MAC, type Mac } from '../bytes/addr';
import { ByteWriter, hex, u16 } from '../bytes/bytes';
import { crc32 } from '../bytes/checksum';
import { FieldList, type LayerPdu } from './types';

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const ETH_HEADER_LEN = 14;
export const ETH_FCS_LEN = 4;
/** Minimum payload so the frame (header + payload + FCS) is at least 64 bytes. */
export const ETH_MIN_PAYLOAD = 46;

/** 7 bytes of preamble + 1 start-of-frame delimiter, sent before every frame on the wire (layer 1). */
export const ETH_PREAMBLE = [0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0xd5];

export interface EthernetHeader {
  dst: Mac;
  src: Mac;
  type: number;
}

export function etherTypeName(t: number): string {
  if (t === ETHERTYPE_IPV4) return 'IPv4';
  if (t === ETHERTYPE_ARP) return 'ARP';
  return 'unknown';
}

/** Builds an Ethernet II frame: header + payload (+ zero padding to 46 B) + FCS (CRC-32, little-endian). */
export function buildEthernet(h: EthernetHeader, payload: Uint8Array): Uint8Array {
  const w = new ByteWriter().bytes(macToBytes(h.dst)).bytes(macToBytes(h.src)).u16(h.type).bytes(payload);
  if (payload.length < ETH_MIN_PAYLOAD) w.zeros(ETH_MIN_PAYLOAD - payload.length);
  const body = w.toBytes();
  const fcs = crc32(body);
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  out[body.length] = fcs & 0xff;
  out[body.length + 1] = (fcs >>> 8) & 0xff;
  out[body.length + 2] = (fcs >>> 16) & 0xff;
  out[body.length + 3] = (fcs >>> 24) & 0xff;
  return out;
}

export interface ParsedEthernet extends EthernetHeader {
  payloadStart: number;
  /** End of payload incl. any padding (frame length minus FCS). */
  payloadEnd: number;
  fcsValid: boolean;
}

export function parseEthernet(frame: Uint8Array): ParsedEthernet {
  const payloadEnd = frame.length - ETH_FCS_LEN;
  return {
    dst: bytesToMac(frame, 0),
    src: bytesToMac(frame, 6),
    type: u16(frame, 12),
    payloadStart: ETH_HEADER_LEN,
    payloadEnd,
    fcsValid: readFcs(frame) === crc32(frame, 0, payloadEnd),
  };
}

function readFcs(frame: Uint8Array): number {
  const n = frame.length;
  return (
    ((frame[n - 4] ?? 0) | ((frame[n - 3] ?? 0) << 8) | ((frame[n - 2] ?? 0) << 16) | ((frame[n - 1] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Describes an Ethernet frame. `innerEnd` is where the carried packet really ends (from its own length field);
 * anything between it and the FCS is padding.
 */
export function describeEthernet(frame: Uint8Array, innerEnd?: number): LayerPdu {
  const p = parseEthernet(frame);
  const f = new FieldList();
  const dstBroadcast = p.dst === BROADCAST_MAC;
  f.add(
    'eth.dst',
    'Destination MAC',
    0,
    6,
    p.dst + (dstBroadcast ? ' (broadcast)' : ''),
    'key',
    dstBroadcast
      ? 'All ones means broadcast: every device on this local network segment receives and reads the frame.'
      : 'Hardware address of the next device on this link, not the final destination. It is rewritten at every hop.',
  );
  f.add(
    'eth.src',
    'Source MAC',
    6,
    6,
    p.src,
    'key',
    "Hardware address of the network card that put this frame on the wire. Also rewritten by each router.",
  );
  f.add(
    'eth.type',
    'EtherType',
    12,
    2,
    `${hex(p.type, 4)} (${etherTypeName(p.type)})`,
    'detail',
    'Tells the receiver which protocol is inside the payload, so it knows which software to hand the bytes to.',
  );
  const padStart = innerEnd ?? p.payloadEnd;
  if (padStart < p.payloadEnd) {
    f.add(
      'eth.padding',
      'Padding',
      padStart,
      p.payloadEnd - padStart,
      `${p.payloadEnd - padStart} zero bytes`,
      'detail',
      'Ethernet frames must be at least 64 bytes long so collisions can be detected on shared media; short payloads are padded with zeros.',
    );
  }
  f.add(
    'eth.fcs',
    'Frame Check Sequence',
    p.payloadEnd,
    4,
    `${hex(readFcs(frame), 8)} ${p.fcsValid ? '✓' : '✗ corrupt'}`,
    'detail',
    'CRC-32 over the whole frame, sent least-significant byte first. The receiving NIC recomputes it and silently drops damaged frames. NICs normally strip it, so packet captures often do not show it.',
  );
  return {
    protocol: 'ethernet',
    layer: 2,
    start: 0,
    headerEnd: ETH_HEADER_LEN,
    payloadEnd: padStart,
    end: frame.length,
    summary: `Ethernet ${p.src} → ${p.dst} · ${etherTypeName(p.type)}`,
    fields: f.list,
  };
}
