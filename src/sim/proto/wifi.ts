import { bytesToMac, macToBytes, BROADCAST_MAC, type Mac } from '../bytes/addr';
import { ByteWriter, hex, u16 } from '../bytes/bytes';
import { crc32, FCS_LEN, readFcs, withFcs } from '../bytes/checksum';
import { etherTypeName } from './ethernet';
import { FieldList, type LayerPdu } from './types';

/**
 * IEEE 802.11 frames, the way Wi-Fi carries IP between a phone and its access point.
 *
 * Data frame: Frame Control (2) · Duration (2) · Address 1 (6) · Address 2 (6) · Address 3 (6) · Sequence Control (2)
 * · LLC/SNAP (8: AA AA 03 00 00 00 + EtherType) · payload · FCS (4, CRC-32 like Ethernet).
 * Ack frame (IEEE 802.11-2020 §9.3.1.4): Frame Control (2: type 1 control, subtype 13) · Duration (2) · RA (6) · FCS (4), 14 bytes.
 * Little-endian fields (Frame Control, Duration, Sequence Control) as on air.
 *
 * Simplifications: an open network (real home Wi-Fi encrypts the body with WPA2/WPA3, which adds a CCMP header
 * and an 8-byte MIC); no QoS field. The Ack the receiver sends back after every unicast data frame is real, but a
 * link with no `noise` leaves it out (today's simplification), so only a noisy link shows it.
 */
export const WIFI_HEADER_LEN = 24;
export const LLC_SNAP_LEN = 8;
/** An Ack control frame: Frame Control, Duration, RA, FCS. */
export const WIFI_ACK_LEN = 14;
/** Microseconds reserved for the link-layer ACK that follows a data frame (SIFS + ACK at 24 Mbit/s). */
export const WIFI_DURATION_US = 44;
/** Frame Control byte 0 of a data frame (type 2, subtype 0) and of an Ack (type 1, subtype 13). */
export const WIFI_FC_DATA = 0x08;
export const WIFI_FC_ACK = 0xd4;
/** Frame Control byte 1 flags: To DS, From DS and Retry (bit 11 of the field: this frame is a copy of one sent before). */
const FC_TO_DS = 0x01;
const FC_FROM_DS = 0x02;
const FC_RETRY = 0x08;

/*
 * 2.4 GHz timings (IEEE 802.11-2020 Table 15-5 / §10.3): SIFS 10 µs, slot 9 µs, DIFS = SIFS + 2 slots = 28 µs; at
 * 5 GHz SIFS is 16 µs. The Ack timeout is SIFS + slot + the PHY's delay, about 50 µs. A frame that was not acknowledged
 * goes again after a backoff of slot × a random count up to the contention window, which doubles from 15 to 1023 on each
 * failure, at most dot11ShortRetryLimit (7) times.
 */
export const WIFI_SIFS = 10e-6;
export const WIFI_SLOT = 9e-6;
export const WIFI_DIFS = WIFI_SIFS + 2 * WIFI_SLOT;
export const WIFI_ACK_TIMEOUT = 50e-6;
export const WIFI_CW_MIN = 15;
export const WIFI_CW_MAX = 1023;
export const WIFI_RETRY_LIMIT = 7;

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
  /** Sent again because no acknowledgement came for the first copy. */
  retry?: boolean;
}

export function buildWifi(h: WifiHeader, payload: Uint8Array): Uint8Array {
  const w = new ByteWriter()
    .u8(WIFI_FC_DATA) // type 2 (data), subtype 0, protocol version 0
    .u8((h.toAp ? FC_TO_DS : FC_FROM_DS) | (h.retry ? FC_RETRY : 0))
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
  return withFcs(w.toBytes());
}

/** The 14-byte Ack control frame a receiver sends back after SIFS to whoever transmitted a unicast frame to it (`ra`). */
export function buildWifiAck(ra: Mac): Uint8Array {
  const w = new ByteWriter().u8(WIFI_FC_ACK).u8(0x00).u8(0x00).u8(0x00).bytes(macToBytes(ra));
  return withFcs(w.toBytes());
}

/** What kind of frame this is, from Frame Control: a data frame, an Ack, or something this sim never sends. */
export function wifiFrameKind(frame: Uint8Array): 'data' | 'ack' | 'other' {
  const fc = frame[0] ?? 0;
  if (fc === WIFI_FC_ACK) return 'ack';
  return (fc & 0x0c) === 0x08 ? 'data' : 'other';
}

export interface ParsedWifi extends WifiHeader {
  /** Who the frame is finally for, and who first sent it (from the To DS / From DS flags). */
  dst: Mac;
  src: Mac;
  retry: boolean;
  payloadStart: number;
  payloadEnd: number;
  fcsValid: boolean;
}

export function parseWifi(frame: Uint8Array): ParsedWifi {
  const flags = frame[1] ?? 0;
  const toAp = (flags & FC_TO_DS) !== 0;
  const addr1 = bytesToMac(frame, 4);
  const addr2 = bytesToMac(frame, 10);
  const addr3 = bytesToMac(frame, 16);
  const payloadEnd = frame.length - FCS_LEN;
  return {
    toAp,
    addr1,
    addr2,
    addr3,
    seq: ((frame[22] ?? 0) | ((frame[23] ?? 0) << 8)) >> 4,
    type: u16(frame, WIFI_HEADER_LEN + 6),
    retry: (flags & FC_RETRY) !== 0,
    dst: toAp ? addr3 : addr1,
    src: toAp ? addr2 : addr3,
    payloadStart: WIFI_HEADER_LEN + LLC_SNAP_LEN,
    payloadEnd,
    fcsValid: readFcs(frame) === crc32(frame, 0, payloadEnd),
  };
}

export interface ParsedWifiAck {
  /** Receiver address: the transmitter of the frame being acknowledged. */
  ra: Mac;
  fcsValid: boolean;
}

export function parseWifiAck(frame: Uint8Array): ParsedWifiAck {
  return { ra: bytesToMac(frame, 4), fcsValid: frame.length === WIFI_ACK_LEN && readFcs(frame) === crc32(frame, 0, WIFI_ACK_LEN - FCS_LEN) };
}

export function describeWifi(frame: Uint8Array, innerEnd?: number): LayerPdu {
  if (wifiFrameKind(frame) === 'ack') return describeWifiAck(frame);
  const p = parseWifi(frame);
  const f = new FieldList();
  f.add('wifi.fc', 'Frame Control', 0, 2, `${hex(u16(frame, 0), 4)} (data, ${p.toAp ? 'To DS' : 'From DS'}${p.retry ? ', retry' : ''})`, 'detail',
    p.toAp
      ? 'Type 2 is a data frame. The To DS flag says it is going up from a station to the access point, to be passed on into the wired network.'
      : 'Type 2 is a data frame. The From DS flag says it is coming down from the access point to a station.');
  f.add('wifi.retry', 'Retry', 1, 1, p.retry ? '1 (sent again)' : '0', p.retry ? 'key' : 'detail',
    p.retry
      ? 'Sent again because no acknowledgement came for the first copy: radio is noisy, and the sender tries the same frame once more. A receiver that already has it can tell by the sequence number.'
      : 'Clear: this is the first time this frame goes out. It is set on a copy sent again because no acknowledgement came.',
    { bits: { start: 12, count: 1 } });
  f.add('wifi.duration', 'Duration', 2, 2, `${WIFI_DURATION_US} µs`, 'detail',
    'How long the air stays reserved after this frame, for the short acknowledgement a receiver sends back. A broadcast gets none. Other devices that hear it wait that long before talking.');
  const bcast = (m: Mac): string => (m === BROADCAST_MAC ? ' (broadcast)' : '');
  f.add('wifi.addr1', p.toAp ? 'Receiver (access point)' : 'Receiver (station)', 4, 6, p.addr1 + bcast(p.addr1), 'key',
    p.toAp ? 'The access point this device is connected to (its BSSID). Only it acts on the frame.' : 'The device this frame is for, or everyone in range if it is a broadcast.');
  f.add('wifi.addr2', p.toAp ? 'Transmitter (station)' : 'Transmitter (access point)', 10, 6, p.addr2, 'key',
    p.toAp ? 'The device that sent the frame through the air.' : 'The access point that sent the frame through the air (its BSSID).');
  f.add('wifi.addr3', p.toAp ? 'Destination' : 'Source', 16, 6, p.addr3 + bcast(p.addr3), 'key',
    p.toAp
      ? 'Who the frame is really for beyond the access point. Wi-Fi needs this third address because the radio receiver and the final destination can differ: it may be the router the access point is built into, or another device on the network.'
      : 'Who originally sent the frame: the router the access point is built into, or another device on the network.');
  f.add('wifi.seq', 'Sequence number', 22, 2, String(p.seq), 'detail',
    'Counts frames from this sender so a receiver can spot a duplicate when a frame is sent again after its acknowledgement was lost.');
  f.add('wifi.llc', 'LLC/SNAP', WIFI_HEADER_LEN, LLC_SNAP_LEN, `aa aa 03 00 00 00 · ${hex(p.type, 4)} (${etherTypeName(p.type)})`, 'detail',
    'Wi-Fi frames have no EtherType of their own, so this small header carries one: it says which protocol is inside, just as Ethernet does.');
  const padStart = innerEnd ?? p.payloadEnd;
  f.add('wifi.fcs', 'Frame Check Sequence', p.payloadEnd, FCS_LEN, `${hex(readFcs(frame), 8)} ${p.fcsValid ? '✓' : '✗ corrupt'}`, 'detail',
    'CRC-32 over the whole frame, like Ethernet. Radio is noisy: a frame that arrives damaged is dropped and sent again.');
  return {
    protocol: 'wifi',
    layer: 2,
    start: 0,
    headerEnd: WIFI_HEADER_LEN + LLC_SNAP_LEN,
    payloadEnd: padStart,
    end: frame.length,
    summary: `Wi-Fi ${p.src} → ${p.dst} · ${etherTypeName(p.type)}${p.retry ? ' · retry' : ''}`,
    fields: f.list,
  };
}

function describeWifiAck(frame: Uint8Array): LayerPdu {
  const p = parseWifiAck(frame);
  const f = new FieldList();
  f.add('wifi.fc', 'Frame Control', 0, 2, `${hex(u16(frame, 0), 4)} (control, Ack)`, 'key',
    'Type 1 is a control frame and subtype 13 an Ack: the receiver says "got it" for the data frame that just came. It carries nothing else.');
  f.add('wifi.duration', 'Duration', 2, 2, '0 µs', 'detail',
    'Nothing follows an Ack, so it reserves no more time on the air.');
  f.add('wifi.ra', 'Receiver', 4, 6, p.ra, 'key',
    'The device whose frame is being acknowledged: it was waiting for exactly this. An Ack has no sender address; the one who sent the data knows who must have answered.');
  f.add('wifi.fcs', 'Frame Check Sequence', WIFI_ACK_LEN - FCS_LEN, FCS_LEN, `${hex(readFcs(frame), 8)} ${p.fcsValid ? '✓' : '✗ corrupt'}`, 'detail',
    'CRC-32 over the Ack. An Ack can be lost to interference too: then the sender, hearing nothing, sends its frame again, and the receiver gets it twice.');
  return {
    protocol: 'wifi',
    layer: 2,
    start: 0,
    headerEnd: WIFI_ACK_LEN - FCS_LEN,
    payloadEnd: WIFI_ACK_LEN - FCS_LEN,
    end: frame.length,
    summary: `Wi-Fi ACK → ${p.ra}`,
    fields: f.list,
  };
}
