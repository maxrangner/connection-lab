import { hex } from '../bytes/bytes';
import { chachaPolyOpen, chachaPolySeal } from '../crypto/crypto';
import { FieldList, type LayerPdu } from './types';

/**
 * WireGuard transport messages (the WireGuard paper, §5.4.6): type 4 (1) · reserved (3) · receiver index (4, LE) ·
 * counter (8, LE) · the whole inner IP packet, zero-padded to a multiple of 16, sealed with ChaCha20-Poly1305 · tag (16).
 * The Noise handshake that really produces the keys is left out: the tunnel is already up when the story starts.
 */
export const WG_PORT = 51820;
export const WG_TYPE_DATA = 4;
export const WG_HEADER_LEN = 16;
export const WG_TAG_LEN = 16;

const NO_AAD = new Uint8Array(0);

/** 4 zero bytes, then the counter as a 64-bit little-endian number. */
function nonceFor(counter: number): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter), true);
  return n;
}

export function buildWgData(key: Uint8Array, receiver: number, counter: number, inner: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(inner.length / 16) * 16);
  padded.set(inner);
  const sealed = chachaPolySeal(key, nonceFor(counter), NO_AAD, padded);
  const out = new Uint8Array(WG_HEADER_LEN + sealed.length);
  const v = new DataView(out.buffer);
  out[0] = WG_TYPE_DATA;
  v.setUint32(4, receiver, true);
  v.setBigUint64(8, BigInt(counter), true);
  out.set(sealed, WG_HEADER_LEN);
  return out;
}

/** The padded inner packet, or null if it does not authenticate. */
export function openWgData(key: Uint8Array, msg: Uint8Array): Uint8Array | null {
  const counter = new DataView(msg.buffer, msg.byteOffset, msg.length).getBigUint64(8, true);
  return chachaPolyOpen(key, nonceFor(Number(counter)), NO_AAD, msg.subarray(WG_HEADER_LEN));
}

export function describeWireguard(b: Uint8Array, o: number, end: number): LayerPdu {
  const v = new DataView(b.buffer, b.byteOffset, b.length);
  const f = new FieldList();
  f.add('wg.type', 'Message type', o, 1, `${b[o]} (transport data)`, 'key', 'Type 4 is ordinary traffic. Types 1 to 3 belong to the handshake that sets up the keys.');
  f.add('wg.reserved', 'Reserved', o + 1, 3, '0', 'detail', 'Always zero; kept so the fields that follow line up on four-byte boundaries.');
  f.add('wg.receiver', 'Receiver index', o + 4, 4, hex(v.getUint32(o + 4, true), 8), 'key', 'A number the other end picked for this tunnel, so it can find the right keys straight away without trying them all.');
  f.add('wg.counter', 'Counter', o + 8, 8, String(v.getBigUint64(o + 8, true)), 'key', 'Goes up by one with every message. It is part of the encryption, so the same data never looks the same twice, and a recorded message cannot be replayed.');
  f.add('wg.sealed', 'Encrypted packet', o + WG_HEADER_LEN, end - o - WG_HEADER_LEN - WG_TAG_LEN, `${end - o - WG_HEADER_LEN - WG_TAG_LEN} bytes`, 'key', 'The whole original IP packet, its addresses included, padded to a multiple of 16 bytes and encrypted with ChaCha20. Only the other end of the tunnel can read it.');
  f.add('wg.tag', 'Authentication tag', end - WG_TAG_LEN, WG_TAG_LEN, '16 bytes', 'detail', 'A Poly1305 check over the encrypted bytes. If anyone changes a single bit on the way, the other end throws the message away.');
  return { protocol: 'wireguard', layer: 5, start: o, headerEnd: o + WG_HEADER_LEN, payloadEnd: end, end, summary: `WireGuard data, counter ${v.getBigUint64(o + 8, true)}`, fields: f.list };
}
