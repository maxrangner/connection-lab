import { bytesToMac, macToBytes, BROADCAST_MAC, type Mac } from '../bytes/addr';
import { ByteWriter, hex, u16 } from '../bytes/bytes';
import { crc32 } from '../bytes/checksum';
import { etherTypeName } from './ethernet';
import { FieldList, type LayerPdu } from './types';

/**
 * IEEE 802.11 data frames, the way Wi-Fi carries IP between a phone and its access point.
 *
 * Layout: Frame Control (2) · Duration (2) · Address 1 (6) · Address 2 (6) · Address 3 (6) · Sequence Control (2)
 * · LLC/SNAP (8: AA AA 03 00 00 00 + EtherType) · payload · FCS (4, CRC-32 like Ethernet).
 * Little-endian fields (Frame Control, Duration, Sequence Control) as on air.
 *
 * Simplifications: an open network (real home Wi-Fi encrypts the body with WPA2/WPA3, which adds a CCMP header
 * and an 8-byte MIC); no QoS field; the link-layer ACK the receiver sends back after every frame is not shown.
 */
export const WIFI_HEADER_LEN = 24;
export const LLC_SNAP_LEN = 8;
export const WIFI_FCS_LEN = 4;
/** Microseconds reserved for the link-layer ACK that follows a data frame (SIFS + ACK at 24 Mbit/s). */
export const WIFI_DURATION_US = 44;

export interface WifiHeader {
  /** Station → access point (to the distribution system) or access point → station. */
  toAp: boolean;
  /** Receiver: the access point (BSSID) going up, the station coming down. */
  addr1: Mac;
  /** Transmitter: the station going up, the BSSID coming down. */
  addr2: Mac;
  /** Going up: the final destination MAC. Coming down: the original source MAC. */
  addr3: Mac;
  seq: number;
  type: number;
}

export function buildWifi(h: WifiHeader, payload: Uint8Array): Uint8Array {
  const w = new ByteWriter()
    .u8(0x08) // type 2 (data), subtype 0, protocol version 0
    .u8(h.toAp ? 0x01 : 0x02) // flags: To DS or From DS
    .u8(WIFI_DURATION_US & 0xff)
    .u8(WIFI_DURATION_US >> 8)
    .bytes(macToBytes(h.addr1))
    .bytes(macToBytes(h.addr2))
    .bytes(macToBytes(h.addr3))
    .u8((h.seq << 4) & 0xff)
    .u8((h.seq >> 4) & 0xff)
    .bytes([0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00])
    .u16(h.type)
    .bytes(payload);
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

export interface ParsedWifi extends WifiHeader {
  /** Who the frame is finally for, and who first sent it (from the To DS / From DS flags). */
  dst: Mac;
  src: Mac;
  payloadStart: number;
  payloadEnd: number;
  fcsValid: boolean;
}

export function parseWifi(frame: Uint8Array): ParsedWifi {
  const toAp = ((frame[1] ?? 0) & 0x01) !== 0;
  const addr1 = bytesToMac(frame, 4);
  const addr2 = bytesToMac(frame, 10);
  const addr3 = bytesToMac(frame, 16);
  const payloadEnd = frame.length - WIFI_FCS_LEN;
  return {
    toAp,
    addr1,
    addr2,
    addr3,
    seq: ((frame[22] ?? 0) | ((frame[23] ?? 0) << 8)) >> 4,
    type: u16(frame, WIFI_HEADER_LEN + 6),
    dst: toAp ? addr3 : addr1,
    src: toAp ? addr2 : addr3,
    payloadStart: WIFI_HEADER_LEN + LLC_SNAP_LEN,
    payloadEnd,
    fcsValid: readFcs(frame) === crc32(frame, 0, payloadEnd),
  };
}

function readFcs(frame: Uint8Array): number {
  const n = frame.length;
  return (((frame[n - 4] ?? 0) | ((frame[n - 3] ?? 0) << 8) | ((frame[n - 2] ?? 0) << 16) | ((frame[n - 1] ?? 0) << 24)) >>> 0);
}

export function describeWifi(frame: Uint8Array, innerEnd?: number): LayerPdu {
  const p = parseWifi(frame);
  const f = new FieldList();
  f.add('wifi.fc', 'Frame Control', 0, 2, `${hex(u16(frame, 0), 4)} (data, ${p.toAp ? 'To DS' : 'From DS'})`, 'detail',
    p.toAp
      ? 'Type 2 is a data frame. The To DS flag says it is going up from a station to the access point, to be passed on into the wired network.'
      : 'Type 2 is a data frame. The From DS flag says it is coming down from the access point to a station.');
  f.add('wifi.duration', 'Duration', 2, 2, `${WIFI_DURATION_US} µs`, 'detail',
    'How long the air stays reserved after this frame, for the short acknowledgement the receiver sends back. Other devices that hear it wait that long before talking.');
  const bcast = (m: Mac): string => (m === BROADCAST_MAC ? ' (broadcast)' : '');
  f.add('wifi.addr1', p.toAp ? 'Receiver (access point)' : 'Receiver (station)', 4, 6, p.addr1 + bcast(p.addr1), 'key',
    p.toAp ? 'The access point this phone is connected to (its BSSID). Only it acts on the frame.' : 'The phone this frame is for.');
  f.add('wifi.addr2', p.toAp ? 'Transmitter (station)' : 'Transmitter (access point)', 10, 6, p.addr2, 'key',
    p.toAp ? 'The phone that sent the frame through the air.' : 'The access point that sent the frame through the air (its BSSID).');
  f.add('wifi.addr3', p.toAp ? 'Destination' : 'Source', 16, 6, p.addr3 + bcast(p.addr3), 'key',
    p.toAp
      ? 'Who the frame is really for beyond the access point. Wi-Fi needs this third address because the radio receiver and the final destination can differ; here the access point is built into the router, so they are the same box.'
      : 'Who originally sent the frame; here the router, which is also the access point.');
  f.add('wifi.seq', 'Sequence number', 22, 2, String(p.seq), 'detail',
    'Counts frames from this sender so a receiver can spot a duplicate when a frame is sent again after its acknowledgement was lost.');
  f.add('wifi.llc', 'LLC/SNAP', WIFI_HEADER_LEN, LLC_SNAP_LEN, `aa aa 03 00 00 00 · ${hex(p.type, 4)} (${etherTypeName(p.type)})`, 'detail',
    'Wi-Fi frames have no EtherType of their own, so this small header carries one: it says which protocol is inside, just as Ethernet does.');
  const padStart = innerEnd ?? p.payloadEnd;
  f.add('wifi.fcs', 'Frame Check Sequence', p.payloadEnd, 4, `${hex(readFcs(frame), 8)} ${p.fcsValid ? '✓' : '✗ corrupt'}`, 'detail',
    'CRC-32 over the whole frame, like Ethernet. Radio is noisy: a frame that arrives damaged is dropped and sent again.');
  return {
    protocol: 'wifi',
    layer: 2,
    start: 0,
    headerEnd: WIFI_HEADER_LEN + LLC_SNAP_LEN,
    payloadEnd: padStart,
    end: frame.length,
    summary: `Wi-Fi ${p.src} → ${p.dst} · ${etherTypeName(p.type)}`,
    fields: f.list,
  };
}
