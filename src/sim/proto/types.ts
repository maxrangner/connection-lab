export type Protocol = 'ethernet' | 'wifi' | 'arp' | 'ipv4' | 'udp' | 'tcp' | 'dns' | 'http';

/**
 * Layer numbers in the 5-layer TCP/IP model: 1 physical, 2 link, 3 network, 4 transport, 5 application.
 * The UI maps these to OSI names (5 → 7, with 5/6 shown as pass-through) when that setting is on.
 */
export type LayerNum = 1 | 2 | 3 | 4 | 5;

export const PROTOCOL_LAYER: Record<Protocol, LayerNum> = {
  ethernet: 2,
  wifi: 2,
  arp: 2, // ARP rides directly in Ethernet; it serves layer 3 but is carried as a link-layer payload.
  ipv4: 3,
  udp: 4,
  tcp: 4,
  dns: 5,
  http: 5,
};

export interface Field {
  /** Stable id, e.g. "ipv4.ttl". Used for highlighting and to look up docs. */
  key: string;
  /** Human name, e.g. "Time to Live". */
  name: string;
  /** Formatted value, e.g. "64" or "0x0800 (IPv4)". */
  display: string;
  /** Absolute byte offset within the PDU's bytes. */
  offset: number;
  /** Number of bytes the field touches (for bit fields: the containing bytes). */
  length: number;
  /** For bit fields: first bit (0 = most significant bit of byte `offset`) and bit count. */
  bits?: { start: number; count: number };
  /** "key" fields are shown in the clean view; "detail" only in full/hex views. */
  importance: 'key' | 'detail';
  /** One or two sentences: what the field is for and why it has this value. */
  explain: string;
  /** Sub-fields, e.g. individual TCP flags or DNS records. */
  children?: Field[];
}

export interface LayerPdu {
  protocol: Protocol;
  layer: LayerNum;
  /** Header occupies [start, headerEnd); payload [headerEnd, payloadEnd); trailer [payloadEnd, end). */
  start: number;
  headerEnd: number;
  payloadEnd: number;
  end: number;
  /** One line, e.g. "IPv4 192.168.1.23 → 1.1.1.1 · TTL 64 · UDP". */
  summary: string;
  fields: Field[];
}

/** Collects fields while a describer walks a header. */
export class FieldList {
  readonly list: Field[] = [];

  add(
    key: string,
    name: string,
    offset: number,
    length: number,
    display: string | number,
    importance: 'key' | 'detail',
    explain: string,
    extra: Partial<Pick<Field, 'bits' | 'children'>> = {},
  ): Field {
    const f: Field = { key, name, offset, length, display: String(display), importance, explain, ...extra };
    this.list.push(f);
    return f;
  }
}

export function bitField(
  key: string,
  name: string,
  offset: number,
  length: number,
  start: number,
  count: number,
  display: string | number,
  importance: 'key' | 'detail',
  explain: string,
): Field {
  return { key, name, offset, length, bits: { start, count }, display: String(display), importance, explain };
}
