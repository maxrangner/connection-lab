import { flagNames, PROTOCOL_LAYER, type Field, type LayerPdu, type PacketInfo, type PduSnapshot, type Protocol } from '../../sim';
import { LAYER_COLOR, protocolColor } from '../content/layers';
import { U } from '../iso/project';

/**
 * A packet as a gizmo of machine parts. Each part covers a contiguous byte range of the PDU and its length is
 * proportional to its byte count, so the finished gizmo is an honest picture of what goes on the wire.
 */
export type PartKind =
  | 'core' // application data (DNS / HTTP bytes)
  | 'module' // TCP chassis, ARP block
  | 'bracket' // UDP
  | 'plate' // IPv4 navigation plate
  | 'shellFront' // Ethernet header cap
  | 'shellBack' // Ethernet FCS seal
  | 'frame' // Ethernet shell rails (zero bytes)
  | 'filler' // Ethernet padding
  | 'pilot'; // preamble + SFD on the wire only

export interface PartLabel {
  key: string;
  text: string;
  offset: number;
  length: number;
}

export interface Part {
  id: string;
  kind: PartKind;
  protocol: Protocol | 'padding' | 'preamble';
  /** Layer index in pdu.layers (0 = outermost); -1 for padding/preamble. */
  depth: number;
  byteStart: number;
  byteEnd: number;
  /** Position and length along the gizmo's axis, in tiles. */
  x: number;
  len: number;
  /** Height in tiles. */
  h: number;
  collapsed: boolean;
  color: string;
  name: string;
  labels: PartLabel[];
}

export interface GizmoLayout {
  parts: Part[];
  /** Total length in tiles (frame excluded, it spans the others). */
  length: number;
  /** x (tiles) of every byte's block, -1 inside a collapsed run. */
  byteX: Float32Array;
  /** Ids of the parts that belong to the outermost layer (what grows/shrinks on (de)encapsulation). */
  outerIds: string[];
  /** Length of the outermost front part(s), the amount inner parts shift when it bolts on. */
  outerFrontLen: number;
}

/** Scene px per byte, converted to tiles below. */
export const BYTE_PX = 2.2;
export const BYTE_TILE = BYTE_PX / U;
const COLLAPSE_OVER = 64;

export const PART_H: Record<PartKind, number> = {
  core: 0.9,
  module: 1.1,
  bracket: 0.6,
  plate: 0.5,
  shellFront: 1.35,
  shellBack: 1.35,
  frame: 1.35,
  filler: 0.45,
  pilot: 0.5,
};

export const PADDING_COLOR = '#64748b';

export function collapsedTiles(n: number): number {
  return (36 + 9 * Math.log2(n / COLLAPSE_OVER)) / U;
}

function isApp(p: Protocol): boolean {
  return PROTOCOL_LAYER[p] === 5;
}

function findField(l: LayerPdu, key: string): Field | undefined {
  const stack = [...l.fields];
  while (stack.length) {
    const f = stack.shift()!;
    if (f.key === key) return f;
    if (f.children) stack.push(...f.children);
  }
  return undefined;
}

function label(l: LayerPdu, key: string, text?: string): PartLabel | undefined {
  const f = findField(l, key);
  if (!f) return undefined;
  return { key, text: text ?? f.display, offset: f.offset, length: f.length };
}

function compactMac(mac: string): string {
  return mac.replace(' (broadcast)', ' (all)');
}

function labelsFor(l: LayerPdu, kind: PartKind, pk?: PacketInfo): PartLabel[] {
  const out: (PartLabel | undefined)[] = [];
  switch (l.protocol) {
    case 'ethernet':
      if (kind === 'shellFront') {
        const dst = findField(l, 'eth.dst');
        const src = findField(l, 'eth.src');
        if (dst) out.push({ key: 'eth.dst', text: `→ ${compactMac(dst.display)}`, offset: dst.offset, length: dst.length });
        if (src) out.push({ key: 'eth.src', text: `from ${src.display}`, offset: src.offset, length: src.length });
      } else if (kind === 'shellBack') {
        const fcs = findField(l, 'eth.fcs');
        if (fcs) out.push({ key: 'eth.fcs', text: fcs.display.includes('✗') ? 'CRC ✗' : 'CRC ✓', offset: fcs.offset, length: fcs.length });
      }
      break;
    case 'ipv4': {
      const src = findField(l, 'ipv4.src');
      const dst = findField(l, 'ipv4.dst');
      if (src && dst) out.push({ key: 'ipv4.src', text: `${src.display} → ${dst.display}`, offset: src.offset, length: src.length + dst.length });
      out.push(label(l, 'ipv4.ttl', `TTL ${findField(l, 'ipv4.ttl')?.display ?? ''}`));
      break;
    }
    case 'udp': {
      const s = findField(l, 'udp.srcport');
      const d = findField(l, 'udp.dstport');
      if (s && d) out.push({ key: 'udp.ports', text: `UDP ${s.display.split(' ')[0]} → ${d.display.split(' ')[0]}`, offset: s.offset, length: 4 });
      break;
    }
    case 'tcp': {
      const s = findField(l, 'tcp.srcport');
      const d = findField(l, 'tcp.dstport');
      if (s && d) out.push({ key: 'tcp.ports', text: `TCP ${s.display.split(' ')[0]} → ${d.display.split(' ')[0]}`, offset: s.offset, length: 4 });
      const fl = findField(l, 'tcp.flags');
      const seq = findField(l, 'tcp.seq');
      if (fl && pk?.tcp) {
        const names = flagNames(pk.tcp.flags);
        const ackOn = (pk.tcp.flags & 0x10) !== 0;
        out.push({ key: 'tcp.flags', text: `[${names}]`, offset: fl.offset, length: fl.length });
        if (seq) out.push({ key: 'tcp.seq', text: `seq ${pk.tcp.relSeq}${ackOn ? ` ack ${pk.tcp.relAck}` : ''}`, offset: seq.offset, length: 8 });
      }
      break;
    }
    case 'arp': {
      const req = l.summary.startsWith('ARP who');
      const tpa = findField(l, 'arp.tpa');
      const spa = findField(l, 'arp.spa');
      const sha = findField(l, 'arp.sha');
      if (req && tpa) out.push({ key: 'arp.tpa', text: `who has ${tpa.display}?`, offset: tpa.offset, length: tpa.length });
      if (!req && spa && sha) out.push({ key: 'arp.sha', text: `${spa.display} is at ${sha.display}`, offset: sha.offset, length: sha.length });
      break;
    }
    case 'dns': {
      const q = findField(l, 'dns.question');
      const a = findField(l, 'dns.answer');
      if (a?.children) {
        const ip = a.children.find((c) => c.key === 'dns.rr.addr');
        if (ip) out.push({ key: 'dns.rr.addr', text: `= ${ip.display}`, offset: ip.offset, length: ip.length });
      } else if (q) out.push({ key: 'dns.question', text: `${q.display.split(' ')[0]} A?`, offset: q.offset, length: q.length });
      break;
    }
    case 'http': {
      const rl = findField(l, 'http.request_line') ?? findField(l, 'http.status_line');
      if (rl) out.push({ key: rl.key, text: rl.display.replace(' HTTP/1.1', '').replace('HTTP/1.1 ', ''), offset: rl.offset, length: rl.length });
      break;
    }
  }
  return out.filter((x): x is PartLabel => !!x);
}

const NAME: Record<Protocol, string> = {
  ethernet: 'Ethernet shell',
  arp: 'ARP block',
  ipv4: 'IP plate',
  udp: 'UDP bracket',
  tcp: 'TCP chassis',
  dns: 'DNS message',
  http: 'HTTP data',
};

export function layoutGizmo(pdu: PduSnapshot, pk?: PacketInfo): GizmoLayout {
  const L = pdu.layers;
  const n = pdu.bytes.length;
  // Innermost owner of every byte: header, trailer or (for app layers) data.
  const owner = (i: number): { d: number; kind: 'header' | 'trailer' | 'data' } => {
    for (let d = L.length - 1; d >= 0; d--) {
      const l = L[d]!;
      if (i >= l.start && i < l.headerEnd) return { d, kind: isApp(l.protocol) ? 'data' : 'header' };
      if (i >= l.payloadEnd && i < l.end) return { d, kind: 'trailer' };
    }
    return { d: 0, kind: 'trailer' };
  };
  const runs: { d: number; kind: 'header' | 'trailer' | 'data'; start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = owner(i);
    const last = runs[runs.length - 1];
    if (last && last.d === o.d && last.kind === o.kind) last.end = i + 1;
    else runs.push({ ...o, start: i, end: i + 1 });
  }
  const parts: Part[] = [];
  const byteX = new Float32Array(n).fill(-1);
  let x = 0;
  let pid = 0;
  const push = (p: Omit<Part, 'id' | 'x' | 'len' | 'collapsed'> & { collapsed?: boolean }): Part => {
    const bytes = p.byteEnd - p.byteStart;
    const collapsed = !!p.collapsed;
    const len = collapsed ? collapsedTiles(bytes) : bytes * BYTE_TILE;
    if (!collapsed) for (let i = p.byteStart; i < p.byteEnd; i++) byteX[i] = x + (i - p.byteStart) * BYTE_TILE;
    const part: Part = { ...p, id: `p${pid++}`, x, len, collapsed };
    parts.push(part);
    x += len;
    return part;
  };
  for (const r of runs) {
    const l = L[r.d]!;
    const proto = l.protocol;
    if (proto === 'ethernet' && r.kind === 'trailer') {
      const fcs = findField(l, 'eth.fcs');
      const fcsStart = fcs ? fcs.offset : r.end - 4;
      if (fcsStart > r.start) {
        push({ kind: 'filler', protocol: 'padding', depth: -1, byteStart: r.start, byteEnd: fcsStart, h: PART_H.filler, color: PADDING_COLOR, name: 'padding', labels: [{ key: 'eth.padding', text: `pad ${fcsStart - r.start} B`, offset: r.start, length: fcsStart - r.start }] });
      }
      push({ kind: 'shellBack', protocol: 'ethernet', depth: r.d, byteStart: fcsStart, byteEnd: r.end, h: PART_H.shellBack, color: protocolColor('ethernet'), name: 'CRC seal', labels: labelsFor(l, 'shellBack', pk) });
      continue;
    }
    const kind: PartKind =
      proto === 'ethernet' ? 'shellFront' : proto === 'ipv4' ? 'plate' : proto === 'udp' ? 'bracket' : proto === 'tcp' || proto === 'arp' ? 'module' : 'core';
    const bytes = r.end - r.start;
    push({
      kind,
      protocol: proto,
      depth: r.d,
      byteStart: r.start,
      byteEnd: r.end,
      h: PART_H[kind],
      color: protocolColor(proto),
      name: NAME[proto],
      labels: kind === 'core' && bytes > COLLAPSE_OVER ? [{ key: 'size', text: `${bytes} B`, offset: r.start, length: bytes }, ...labelsFor(l, kind, pk)] : labelsFor(l, kind, pk),
      collapsed: kind === 'core' && bytes > COLLAPSE_OVER,
    });
  }
  const length = x;
  // The Ethernet shell's rails span from the front cap to the seal.
  const front = parts.find((p) => p.kind === 'shellFront');
  const back = parts.find((p) => p.kind === 'shellBack');
  if (front && back) {
    parts.push({ id: `p${pid++}`, kind: 'frame', protocol: 'ethernet', depth: front.depth, byteStart: front.byteStart, byteEnd: front.byteStart, x: front.x, len: back.x + back.len - front.x, h: PART_H.frame, collapsed: false, color: protocolColor('ethernet'), name: 'Ethernet shell', labels: [] });
  }
  const outerIsApp = L[0] ? isApp(L[0].protocol) : false;
  const outerIds = outerIsApp ? [] : parts.filter((p) => p.depth === 0 || p.protocol === 'padding').map((p) => p.id);
  const outerFrontLen = outerIsApp ? 0 : parts.filter((p) => p.depth === 0 && p.kind !== 'frame' && p.kind !== 'shellBack').reduce((a, p) => a + p.len, 0);
  return { parts, length, byteX, outerIds, outerFrontLen };
}

export interface PlacedPart {
  id: string;
  /** World-x extent of the part relative to the gizmo's leading face (x = 0). */
  x0: number;
  x1: number;
  /** Position in byte order among non-frame parts (0 = first byte). */
  order: number;
}

/**
 * Lays a gizmo out along world x so that byte 0 sits at the leading face and every later part trails behind it,
 * in the direction of travel: dir +1 means the gizmo moves toward +x (parts extend into −x behind the leading
 * face), dir −1 the opposite. `spread` opens a gap of that many tiles between consecutive parts (on the wire).
 * `k` compresses lengths (long gizmos are shortened to fit a floor). The frame part spans the shell.
 */
export function placeParts(layout: GizmoLayout, dir: 1 | -1, spread = 0, k = 1): PlacedPart[] {
  const real = layout.parts.filter((p) => p.kind !== 'frame').sort((a, b) => a.byteStart - b.byteStart);
  const out: PlacedPart[] = [];
  let d = 0;
  real.forEach((p, i) => {
    const len = p.len * k;
    const from = d + i * spread;
    const to = from + len;
    out.push({ id: p.id, x0: dir > 0 ? -to : from, x1: dir > 0 ? -from : to, order: i });
    d += len;
  });
  const frame = layout.parts.find((p) => p.kind === 'frame');
  if (frame) {
    const ends = out.filter((o) => layout.parts.find((p) => p.id === o.id)!.protocol === 'ethernet' || layout.parts.find((p) => p.id === o.id)!.protocol === 'padding');
    const xs = ends.flatMap((o) => [o.x0, o.x1]);
    out.push({ id: frame.id, x0: Math.min(...xs), x1: Math.max(...xs), order: -1 });
  }
  return out;
}

/** The preamble "pilot" car that leads every frame on the wire (8 bytes: 7 × 0x55 + 0xD5). */
export function pilotPart(): Part {
  return { id: 'pilot', kind: 'pilot', protocol: 'preamble', depth: -1, byteStart: -8, byteEnd: 0, x: 0, len: 8 * BYTE_TILE, h: PART_H.pilot, collapsed: false, color: LAYER_COLOR[1], name: 'preamble', labels: [{ key: 'preamble', text: '1010… sync', offset: -8, length: 8 }] };
}
