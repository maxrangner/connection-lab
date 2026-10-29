import type { Ip4 } from '../bytes/addr';
import { ByteWriter, hex, setU16, u16, u32, u8 } from '../bytes/bytes';
import { transportChecksum } from '../bytes/checksum';
import { IPPROTO_TCP } from './ipv4';
import { bitField, FieldList, type Field, type LayerPdu } from './types';
import { portName } from './udp';

export const TCP_FIN = 0x001;
export const TCP_SYN = 0x002;
export const TCP_RST = 0x004;
export const TCP_PSH = 0x008;
export const TCP_ACK = 0x010;
export const TCP_URG = 0x020;
export const TCP_ECE = 0x040;
export const TCP_CWR = 0x080;
export const TCP_AE = 0x100;

const FLAG_NAMES: [number, string][] = [
  [TCP_AE, 'AE'],
  [TCP_CWR, 'CWR'],
  [TCP_ECE, 'ECE'],
  [TCP_URG, 'URG'],
  [TCP_ACK, 'ACK'],
  [TCP_PSH, 'PSH'],
  [TCP_RST, 'RST'],
  [TCP_SYN, 'SYN'],
  [TCP_FIN, 'FIN'],
];

export function flagNames(flags: number): string {
  return FLAG_NAMES.filter(([bit]) => flags & bit)
    .map(([, n]) => n)
    .reverse()
    .join(', ');
}

export type TcpOption =
  | { kind: 'nop' }
  | { kind: 'eol' }
  | { kind: 'mss'; mss: number }
  | { kind: 'ws'; shift: number }
  | { kind: 'sackPerm' }
  | { kind: 'sack'; blocks: [number, number][] }
  | { kind: 'ts'; val: number; ecr: number };

export function encodeOptions(opts: TcpOption[]): number[] {
  const w = new ByteWriter();
  for (const o of opts) {
    switch (o.kind) {
      case 'nop':
        w.u8(1);
        break;
      case 'eol':
        w.u8(0);
        break;
      case 'mss':
        w.u8(2).u8(4).u16(o.mss);
        break;
      case 'ws':
        w.u8(3).u8(3).u8(o.shift);
        break;
      case 'sackPerm':
        w.u8(4).u8(2);
        break;
      case 'sack':
        w.u8(5).u8(2 + 8 * o.blocks.length);
        for (const [l, r] of o.blocks) w.u32(l).u32(r);
        break;
      case 'ts':
        w.u8(8).u8(10).u32(o.val).u32(o.ecr);
        break;
    }
  }
  while (w.length % 4) w.u8(0);
  return Array.from(w.toBytes());
}

export interface TcpHeader {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  options: TcpOption[];
}

export function buildTcp(h: TcpHeader, payload: Uint8Array, srcIp: Ip4, dstIp: Ip4): Uint8Array {
  const opts = encodeOptions(h.options);
  const headerLen = 20 + opts.length;
  const out = new ByteWriter()
    .u16(h.srcPort)
    .u16(h.dstPort)
    .u32(h.seq >>> 0)
    .u32(h.ack >>> 0)
    .u16(((headerLen / 4) << 12) | (h.flags & 0x1ff))
    .u16(h.window)
    .u16(0) // checksum placeholder
    .u16(0) // urgent pointer
    .bytes(opts)
    .bytes(payload)
    .toBytes();
  setU16(out, 16, transportChecksum(srcIp, dstIp, IPPROTO_TCP, out));
  return out;
}

export interface ParsedTcp extends TcpHeader {
  headerLen: number;
  checksum: number;
  payloadStart: number;
}

interface LocatedOption {
  opt: TcpOption;
  offset: number;
  length: number;
}

function parseOptionsLocated(b: Uint8Array, start: number, end: number): LocatedOption[] {
  const out: LocatedOption[] = [];
  let i = start;
  while (i < end) {
    const kind = u8(b, i);
    if (kind === 0) {
      out.push({ opt: { kind: 'eol' }, offset: i, length: end - i });
      break;
    }
    if (kind === 1) {
      out.push({ opt: { kind: 'nop' }, offset: i, length: 1 });
      i += 1;
      continue;
    }
    const len = u8(b, i + 1);
    if (len < 2) break;
    if (kind === 2) out.push({ opt: { kind: 'mss', mss: u16(b, i + 2) }, offset: i, length: len });
    else if (kind === 3) out.push({ opt: { kind: 'ws', shift: u8(b, i + 2) }, offset: i, length: len });
    else if (kind === 4) out.push({ opt: { kind: 'sackPerm' }, offset: i, length: len });
    else if (kind === 5) {
      const blocks: [number, number][] = [];
      for (let k = i + 2; k + 8 <= i + len; k += 8) blocks.push([u32(b, k), u32(b, k + 4)]);
      out.push({ opt: { kind: 'sack', blocks }, offset: i, length: len });
    } else if (kind === 8) out.push({ opt: { kind: 'ts', val: u32(b, i + 2), ecr: u32(b, i + 6) }, offset: i, length: len });
    i += len;
  }
  return out;
}

export function parseTcp(b: Uint8Array, o: number): ParsedTcp {
  const headerLen = (u8(b, o + 12) >>> 4) * 4;
  return {
    srcPort: u16(b, o),
    dstPort: u16(b, o + 2),
    seq: u32(b, o + 4),
    ack: u32(b, o + 8),
    flags: u16(b, o + 12) & 0x1ff,
    window: u16(b, o + 14),
    checksum: u16(b, o + 16),
    headerLen,
    payloadStart: o + headerLen,
    options: parseOptionsLocated(b, o + 20, o + headerLen).map((l) => l.opt),
  };
}

function describeOption(l: LocatedOption): Field {
  const o = l.opt;
  const base = { offset: l.offset, length: l.length, importance: 'detail' as const };
  switch (o.kind) {
    case 'nop':
      return { ...base, key: 'tcp.opt.nop', name: 'NOP', display: 'No-Operation', explain: 'One-byte filler so the following option starts on a 4-byte boundary.' };
    case 'eol':
      return { ...base, key: 'tcp.opt.eol', name: 'End of options', display: '', explain: 'Marks the end of the option list.' };
    case 'mss':
      return { ...base, importance: 'key', key: 'tcp.opt.mss', name: 'Maximum Segment Size', display: `${o.mss} bytes`, explain: 'Largest chunk of data this side is willing to receive in one segment. 1460 = a 1500-byte Ethernet MTU minus 20 bytes IP and 20 bytes TCP header. 536 is the conservative IPv4 default.' };
    case 'ws':
      return { ...base, key: 'tcp.opt.ws', name: 'Window scale', display: `shift ${o.shift} (×${2 ** o.shift})`, explain: 'The 16-bit window field can only say 65 535 bytes. This multiplies it by 2^shift for the rest of the connection.' };
    case 'sackPerm':
      return { ...base, key: 'tcp.opt.sackperm', name: 'SACK permitted', display: 'yes', explain: 'Offers Selective Acknowledgment: the receiver may report exactly which out-of-order blocks it already has, so only missing data is resent.' };
    case 'sack':
      return { ...base, importance: 'key', key: 'tcp.opt.sack', name: 'SACK blocks', display: o.blocks.map(([a, b]) => `${a}–${b}`).join(', '), explain: 'Byte ranges that arrived after a gap. The sender can now retransmit only what is actually missing.' };
    case 'ts':
      return { ...base, key: 'tcp.opt.ts', name: 'Timestamps', display: `TSval ${o.val}, TSecr ${o.ecr}`, explain: "TSval is the sender's clock; TSecr echoes the latest TSval received. Used to measure round-trip time and to reject very old duplicate segments." };
  }
}

export function describeTcp(b: Uint8Array, o: number, end: number, srcIp?: Ip4, dstIp?: Ip4): LayerPdu {
  const p = parseTcp(b, o);
  const valid = srcIp && dstIp ? transportChecksum(srcIp, dstIp, IPPROTO_TCP, b.subarray(o, end)) === 0 : undefined;
  const f = new FieldList();
  const dataLen = end - p.payloadStart;
  f.add('tcp.srcport', 'Source port', o, 2, `${p.srcPort}${portName(p.srcPort)}`, 'key', 'Port of the sending program. Together with the IP addresses and the destination port it identifies this one connection.');
  f.add('tcp.dstport', 'Destination port', o + 2, 2, `${p.dstPort}${portName(p.dstPort)}`, 'key', 'Port of the receiving program. Web servers listen on 80 for plain HTTP.');
  f.add('tcp.seq', 'Sequence number', o + 4, 4, p.seq, 'key', p.flags & TCP_SYN
    ? 'Initial sequence number, chosen at random so old or forged segments are unlikely to fit. The SYN itself uses up one number.'
    : 'Position of the first data byte of this segment in the sender\'s byte stream. The receiver uses it to put segments back in order.');
  f.add('tcp.ack', 'Acknowledgment number', o + 8, 4, p.ack, 'key', p.flags & TCP_ACK
    ? 'The next byte this side expects from the other. It confirms everything before it arrived.'
    : 'Not valid yet because the ACK flag is off.');
  const flagsWord = u16(b, o + 12);
  f.add('tcp.hdrlen', 'Header length', o + 12, 1, `${p.headerLen} bytes (${p.headerLen / 4} words)`, 'detail', 'Data offset in 32-bit words. 20 bytes is the fixed header; anything more is options.', {
    bits: { start: 0, count: 4 },
  });
  const flagChildren = FLAG_NAMES.slice()
    .reverse()
    .map(([bit, name], i) =>
      bitField(`tcp.flags.${name.toLowerCase()}`, name, o + 12, 2, 15 - i, 1, flagsWord & bit ? 1 : 0, 'detail', FLAG_EXPLAIN[name] ?? ''),
    );
  f.add('tcp.flags', 'Flags', o + 12, 2, `${hex(p.flags, 3)} (${flagNames(p.flags)})`, 'key', describeFlagCombo(p.flags, dataLen), {
    bits: { start: 4, count: 12 },
    children: flagChildren,
  });
  f.add('tcp.window', 'Window', o + 14, 2, p.window, 'key', p.flags & TCP_SYN
    ? 'Receive buffer space in bytes. Not scaled in SYN segments.'
    : 'How many more bytes the sender of this segment can accept, before applying the negotiated window-scale multiplier. This is flow control.');
  f.add('tcp.checksum', 'Checksum', o + 16, 2, `${hex(p.checksum, 4)}${valid === undefined ? '' : valid ? ' ✓' : ' ✗'}`, 'detail', "Covers TCP header, data and an IP pseudo-header. Any router doing NAT must recompute it.");
  f.add('tcp.urgent', 'Urgent pointer', o + 18, 2, u16(b, o + 18), 'detail', 'Only meaningful with the URG flag, which modern software practically never uses.');
  const located = parseOptionsLocated(b, o + 20, o + p.headerLen);
  if (located.length) {
    f.add('tcp.options', 'Options', o + 20, p.headerLen - 20, `${p.headerLen - 20} bytes`, located.some((l) => l.opt.kind === 'mss' || l.opt.kind === 'sack') ? 'key' : 'detail', 'Extensions negotiated in the handshake and carried on later segments.', {
      children: located.map(describeOption),
    });
  }
  return {
    protocol: 'tcp',
    layer: 4,
    start: o,
    headerEnd: o + p.headerLen,
    payloadEnd: end,
    end,
    summary: `TCP ${p.srcPort} → ${p.dstPort} [${flagNames(p.flags)}] seq ${p.seq}${p.flags & TCP_ACK ? ` ack ${p.ack}` : ''} · ${dataLen} B data`,
    fields: f.list,
  };
}

const FLAG_EXPLAIN: Record<string, string> = {
  FIN: 'Sender has no more data. Starts closing its direction of the connection.',
  SYN: 'Synchronize sequence numbers. Only set on the first segment from each side.',
  RST: 'Abort the connection immediately.',
  PSH: 'Push: hand the data to the application now instead of waiting for more.',
  ACK: 'The acknowledgment number is valid. Set on every segment after the first SYN.',
  URG: 'The urgent pointer is valid.',
  ECE: 'ECN echo: the network signalled congestion.',
  CWR: 'Congestion window reduced in response to ECN.',
  AE: 'Accurate ECN (formerly the NS bit).',
};

function describeFlagCombo(flags: number, dataLen: number): string {
  if (flags === TCP_SYN) return 'SYN: step 1 of the three-way handshake. "I want to talk; my byte numbering starts here."';
  if (flags === (TCP_SYN | TCP_ACK)) return 'SYN-ACK: step 2. "I got your SYN, and here is my own starting number."';
  if (flags & TCP_FIN) return 'FIN: this side has finished sending. Each direction is closed separately.';
  if (flags & TCP_RST) return 'RST: abort the connection.';
  if (dataLen > 0) return 'Carries data. ACK is set on every segment after the handshake; PSH asks the receiver to deliver it now.';
  return 'A pure acknowledgment with no data.';
}
