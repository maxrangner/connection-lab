import { fromBase64, hex, u16 } from '../bytes/bytes';
import { aes128GcmDecrypt, hkdfExpandLabel } from '../crypto/crypto';
import { FieldList, type LayerPdu } from './types';

/**
 * TLS 1.3 records (RFC 8446 §5): type (1) · legacy version (2) · length (2) · body. After the hellos every
 * record looks like "application data" (type 23) from the outside; only the two ends, holding the session's keys,
 * can open one and see what it really carries (handshake messages, the HTTP request or response, an alert).
 */

export const TLS_HANDSHAKE = 22;
export const TLS_CHANGE_CIPHER_SPEC = 20;
export const TLS_ALERT = 21;
export const TLS_APPLICATION_DATA = 23;
export const TLS_RECORD_HEADER = 5;

const TYPE_NAME: Record<number, string> = { 20: 'ChangeCipherSpec', 21: 'Alert', 22: 'Handshake', 23: 'Application data' };
const HANDSHAKE_NAME: Record<number, string> = { 1: 'ClientHello', 2: 'ServerHello', 4: 'NewSessionTicket', 8: 'EncryptedExtensions', 11: 'Certificate', 15: 'CertificateVerify', 20: 'Finished' };

/** A captured TLS 1.3 session the sim replays byte for byte (see scripts/capture-tls.mjs). */
export interface TlsSession {
  host: string;
  flights: readonly { from: 'client' | 'server'; base64: string }[];
  secrets: { clientHandshake: string; serverHandshake: string; clientApp: string; serverApp: string };
}

export interface TlsRecord {
  offset: number;
  type: number;
  length: number;
}

/** Splits a byte stream into whole records; a trailing partial record is left out. */
export function splitRecords(stream: Uint8Array): TlsRecord[] {
  const out: TlsRecord[] = [];
  let o = 0;
  while (o + TLS_RECORD_HEADER <= stream.length) {
    const length = u16(stream, o + 3);
    if (o + TLS_RECORD_HEADER + length > stream.length) break;
    out.push({ offset: o, type: stream[o]!, length: TLS_RECORD_HEADER + length });
    o += TLS_RECORD_HEADER + length;
  }
  return out;
}

const hexToBytes = (h: string): Uint8Array => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

interface Keys {
  key: Uint8Array;
  iv: Uint8Array;
  seq: number;
}

function keysFrom(secretHex: string): Keys {
  const secret = hexToBytes(secretHex);
  return { key: hkdfExpandLabel(secret, 'key', 16), iv: hkdfExpandLabel(secret, 'iv', 12), seq: 0 };
}

export interface OpenedRecord {
  offset: number;
  /** The real content type inside (22 handshake, 23 application data, 21 alert), or the outer one if not encrypted. */
  inner: number;
  plaintext: Uint8Array;
  /** Handshake message names inside, if any. */
  handshakes: string[];
}

/**
 * Opens every record one side sent, as the other side would: handshake keys until the sender's Finished, then
 * application keys. Throws if a record does not authenticate (it would mean the bytes or keys are wrong).
 */
export function openRecords(session: TlsSession, from: 'client' | 'server', stream: Uint8Array): OpenedRecord[] {
  const s = session.secrets;
  const hs = keysFrom(from === 'client' ? s.clientHandshake : s.serverHandshake);
  const app = keysFrom(from === 'client' ? s.clientApp : s.serverApp);
  let keys = hs;
  const out: OpenedRecord[] = [];
  for (const r of splitRecords(stream)) {
    const body = stream.subarray(r.offset + TLS_RECORD_HEADER, r.offset + r.length);
    if (r.type !== TLS_APPLICATION_DATA) {
      const handshakes = r.type === TLS_HANDSHAKE ? [HANDSHAKE_NAME[body[0]!] ?? `handshake ${body[0]}`] : [];
      out.push({ offset: r.offset, inner: r.type, plaintext: body, handshakes });
      continue;
    }
    // Per-record nonce: the IV with the record's sequence number XORed into its last bytes.
    const nonce = keys.iv.slice();
    for (let i = 0; i < 6; i++) nonce[11 - i]! ^= Math.floor(keys.seq / 256 ** i) & 0xff;
    const plain = aes128GcmDecrypt(keys.key, nonce, stream.subarray(r.offset, r.offset + TLS_RECORD_HEADER), body);
    if (!plain) throw new Error(`TLS record at ${r.offset} from the ${from} did not decrypt`);
    keys.seq++;
    // Strip zero padding; the last non-zero byte is the real content type.
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    const inner = plain[end]!;
    const content = plain.subarray(0, end);
    const handshakes: string[] = [];
    if (inner === TLS_HANDSHAKE) {
      for (let p = 0; p + 4 <= content.length; ) {
        const t = content[p]!;
        handshakes.push(HANDSHAKE_NAME[t] ?? `handshake ${t}`);
        p += 4 + ((content[p + 1]! << 16) | (content[p + 2]! << 8) | content[p + 3]!);
        if (t === 20) keys = app;
      }
    }
    out.push({ offset: r.offset, inner, plaintext: content, handshakes });
  }
  return out;
}

/**
 * The site name in a ClientHello's server_name extension: sent in the clear so the server knows which certificate to
 * use. Reads a record that starts at o; null if there is no complete ClientHello with a name in the bytes given.
 */
export function clientHelloSni(b: Uint8Array, o = 0): string | null {
  if (b[o] !== TLS_HANDSHAKE || b[o + 5] !== 1) return null;
  let p = o + 5 + 4 + 2 + 32; // record header, handshake header, legacy version, random
  const has = (n: number): boolean => p + n <= b.length;
  if (!has(1)) return null;
  p += 1 + b[p]!; // session id
  if (!has(2)) return null;
  p += 2 + u16(b, p); // cipher suites
  if (!has(1)) return null;
  p += 1 + b[p]!; // compression methods
  if (!has(2)) return null;
  const end = p + 2 + u16(b, p);
  p += 2;
  while (p + 4 <= end && has(4)) {
    const type = u16(b, p);
    const len = u16(b, p + 2);
    if (type === 0 && has(4 + 5)) {
      const nameLen = u16(b, p + 7);
      if (!has(9 + nameLen)) return null;
      return new TextDecoder().decode(b.subarray(p + 9, p + 9 + nameLen));
    }
    p += 4 + len;
  }
  return null;
}

/** All bytes one side sends in a session, in order. */
export function sessionStream(session: TlsSession, from: 'client' | 'server'): Uint8Array {
  const parts = session.flights.filter((f) => f.from === from).map((f) => fromBase64(f.base64));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The HTTP message one side sent, decrypted: all application data records joined. */
export function decryptHttp(session: TlsSession, from: 'client' | 'server', stream: Uint8Array): Uint8Array {
  const parts = openRecords(session, from, stream).filter((r) => r.inner === TLS_APPLICATION_DATA).map((r) => r.plaintext);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Describes the TLS records that start inside a TCP payload [o, end). A record can begin in one segment and end in
 * a later one; the bytes before the first record header here belong to a record started earlier.
 */
export function describeTls(b: Uint8Array, o: number, end: number): LayerPdu {
  const f = new FieldList();
  let p = o;
  let records = 0;
  let encrypted = 0;
  // A continuation of a record from an earlier segment has no header here; we can only tell by size.
  const first = b[p];
  const looksLikeHeader = (x: number): boolean => (b[x] === 20 || b[x] === 21 || b[x] === 22 || b[x] === 23) && b[x + 1] === 3 && x + 5 <= end;
  if (first !== undefined && !looksLikeHeader(p)) {
    f.add('tls.continued', 'Rest of a record', p, end - p, `${end - p} bytes`, 'detail',
      'These bytes continue a TLS record that started in an earlier TCP segment, and a new record may begin among them: only the stream can tell. TLS records can be bigger than one packet; TCP puts the pieces back in order.');
    p = end;
  }
  while (p + 5 <= end && looksLikeHeader(p)) {
    const type = b[p]!;
    const len = u16(b, p + 3);
    records++;
    if (type === TLS_APPLICATION_DATA) encrypted++;
    f.add(`tls.${records}.type`, 'Record type', p, 1, `${type} (${TYPE_NAME[type] ?? 'unknown'})`, 'key',
      type === TLS_APPLICATION_DATA
        ? 'From the outside every encrypted TLS 1.3 record says "application data", whatever it really carries. Only the two ends have the keys to see inside.'
        : type === TLS_HANDSHAKE
          ? 'A handshake message sent in the clear: the hellos, where the two sides agree on keys. Everything after them is encrypted.'
          : 'A one-byte "change cipher spec" kept only so old middleboxes that expect TLS 1.2 do not get confused. TLS 1.3 ignores it.');
    f.add(`tls.${records}.version`, 'Legacy version', p + 1, 2, hex(u16(b, p + 1), 4), 'detail',
      'Not the real version: 0x0303 (TLS 1.2), or 0x0301 on a first ClientHello, for compatibility with old equipment. The real one, 1.3, is agreed inside the hellos.');
    f.add(`tls.${records}.length`, 'Length', p + 3, 2, `${len} bytes`, 'detail', 'How many bytes of this record follow the header (including the 16-byte authentication tag when encrypted).');
    p += 5 + len;
  }
  return {
    protocol: 'tls',
    layer: 5,
    start: o,
    headerEnd: o,
    payloadEnd: end,
    end,
    summary: records ? `TLS ${records} record${records > 1 ? 's' : ''}${encrypted ? ` (${encrypted} encrypted)` : ''}` : 'TLS (continued record)',
    fields: f.list,
  };
}
