/** MAC addresses are lower-case "aa:bb:cc:dd:ee:ff"; IPv4 addresses are dotted quads. */
export type Mac = string;
export type Ip4 = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';
export const ZERO_MAC: Mac = '00:00:00:00:00:00';

export function macToBytes(mac: Mac): number[] {
  const parts = mac.split(':');
  if (parts.length !== 6) throw new Error(`bad MAC ${mac}`);
  return parts.map((p) => parseInt(p, 16));
}

export function bytesToMac(b: Uint8Array, off: number): Mac {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push((b[off + i] ?? 0).toString(16).padStart(2, '0'));
  return out.join(':');
}

export function ipToBytes(ip: Ip4): number[] {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) throw new Error(`bad IPv4 ${ip}`);
  return parts;
}

export function bytesToIp(b: Uint8Array, off: number): Ip4 {
  return [b[off], b[off + 1], b[off + 2], b[off + 3]].map((x) => x ?? 0).join('.');
}

export function ipToInt(ip: Ip4): number {
  const [a, b, c, d] = ipToBytes(ip) as [number, number, number, number];
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

export function prefixMask(prefixLen: number): number {
  return prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
}

export function inSubnet(ip: Ip4, network: Ip4, prefixLen: number): boolean {
  const m = prefixMask(prefixLen);
  return ((ipToInt(ip) & m) >>> 0) === ((ipToInt(network) & m) >>> 0);
}
