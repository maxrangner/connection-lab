import { ipToBytes, type Ip4 } from './addr';

/**
 * RFC 1071 Internet checksum: ones' complement of the ones' complement sum of 16-bit words.
 * Used by IPv4 (header only), UDP and TCP (with pseudo-header).
 */
export function internetChecksum(data: Uint8Array, start = 0, end = data.length): number {
  let sum = 0;
  let i = start;
  for (; i + 1 < end; i += 2) sum += ((data[i] ?? 0) << 8) | (data[i + 1] ?? 0);
  if (i < end) sum += (data[i] ?? 0) << 8; // odd length: pad with a zero byte
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** The 12-byte IPv4 pseudo-header that UDP and TCP checksums cover (RFC 768 / RFC 9293). */
export function pseudoHeader(src: Ip4, dst: Ip4, protocol: number, length: number): number[] {
  return [...ipToBytes(src), ...ipToBytes(dst), 0, protocol, (length >>> 8) & 0xff, length & 0xff];
}

/**
 * Checksum over pseudo-header + transport segment (segment's checksum field as stored).
 * Returns the value to store when the field is zero; returns 0 for a segment whose stored checksum is valid.
 */
export function transportChecksum(src: Ip4, dst: Ip4, protocol: number, segment: Uint8Array): number {
  const ph = pseudoHeader(src, dst, protocol, segment.length);
  const buf = new Uint8Array(ph.length + segment.length);
  buf.set(ph, 0);
  buf.set(segment, ph.length);
  return internetChecksum(buf);
}

let crcTable: Uint32Array | undefined;

/** IEEE 802.3 CRC-32 (reflected, polynomial 0xEDB88320), as used by the Ethernet FCS. */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crcTable[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
