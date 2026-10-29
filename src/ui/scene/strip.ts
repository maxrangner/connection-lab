import { PROTOCOL_LAYER, type PduSnapshot, type Protocol } from '../../sim';
import { protocolColor } from '../content/layers';
import { el } from './svg';

/** Scene units per byte block. One block is always one real byte (except collapsed application data). */
export const BYTE_W = 2.4;
export const BLOCK_W = 1.9;
export const STRIP_H = 14;
const COLLAPSE_OVER = 64;

export interface StripSeg {
  protocol: Protocol;
  depth: number;
  kind: 'header' | 'trailer' | 'data';
  start: number;
  end: number;
  x: number;
  w: number;
  collapsed: boolean;
}

export interface StripLayout {
  segs: StripSeg[];
  width: number;
  /** Widths of the outermost layer's header and trailer (they grow/shrink during (de)encapsulation). */
  ohW: number;
  otW: number;
  otX: number;
  /** x of each byte's block, or -1 if the byte is inside a collapsed run. */
  byteX: Float32Array;
}

function isApp(p: Protocol): boolean {
  return PROTOCOL_LAYER[p] === 5;
}

export function collapsedWidth(n: number): number {
  return Math.round(40 + 10 * Math.log2(n / COLLAPSE_OVER));
}

export function layoutStrip(pdu: PduSnapshot): StripLayout {
  const L = pdu.layers;
  const n = pdu.bytes.length;
  const owner = (i: number): { d: number; kind: StripSeg['kind'] } => {
    for (let d = L.length - 1; d >= 0; d--) {
      const l = L[d]!;
      if (i >= l.start && i < l.headerEnd) return { d, kind: isApp(l.protocol) ? 'data' : 'header' };
      if (i >= l.payloadEnd && i < l.end) return { d, kind: 'trailer' };
    }
    return { d: 0, kind: 'trailer' };
  };
  const runs: { d: number; kind: StripSeg['kind']; start: number; end: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = owner(i);
    const last = runs[runs.length - 1];
    if (last && last.d === o.d && last.kind === o.kind) last.end = i + 1;
    else runs.push({ ...o, start: i, end: i + 1 });
  }
  const segs: StripSeg[] = [];
  const byteX = new Float32Array(n).fill(-1);
  let x = 0;
  for (const r of runs) {
    const len = r.end - r.start;
    const collapsed = r.kind === 'data' && len > COLLAPSE_OVER;
    const w = collapsed ? collapsedWidth(len) : len * BYTE_W;
    if (!collapsed) for (let i = r.start; i < r.end; i++) byteX[i] = x + (i - r.start) * BYTE_W;
    segs.push({ protocol: L[r.d]?.protocol ?? 'ethernet', depth: r.d, kind: r.kind, start: r.start, end: r.end, x, w, collapsed });
    x += w;
  }
  const oh = segs.filter((s) => s.depth === 0 && s.kind === 'header');
  const ot = segs.filter((s) => s.depth === 0 && s.kind === 'trailer');
  const ohW = oh.reduce((a, s) => a + s.w, 0);
  const otW = ot.reduce((a, s) => a + s.w, 0);
  // When the outer layer is itself application data (a bare DNS/HTTP message) nothing grows.
  const outerIsApp = L[0] ? isApp(L[0].protocol) : false;
  return {
    segs,
    width: x,
    ohW: outerIsApp ? 0 : ohW,
    otW: outerIsApp ? 0 : otW,
    otX: ot[0]?.x ?? x,
    byteX,
  };
}

function blocksPath(x: number, count: number): string {
  let d = '';
  for (let i = 0; i < count; i++) d += `M${(x + i * BYTE_W).toFixed(2)} 0h${BLOCK_W}v${STRIP_H}h-${BLOCK_W}z`;
  return d;
}

export interface StripEl {
  g: SVGGElement;
  oh: SVGGElement;
  inner: SVGGElement;
  ot: SVGGElement;
  diff: SVGGElement;
  data: SVGGElement | null;
  layout: StripLayout;
  pduId: string;
}

/** Builds the SVG for one PDU snapshot. Groups: outer header, inner (everything else), outer trailer. */
export function buildStrip(pdu: PduSnapshot, label: string): StripEl {
  const layout = layoutStrip(pdu);
  const g = el('g', { class: 'strip', 'data-pdu': pdu.id });
  el('rect', { class: 'strip-hit', x: -4, y: -14, width: layout.width + 8, height: STRIP_H + 18 }, g);
  const t = el('text', { class: 'strip-label', x: 0, y: -4 }, g);
  t.textContent = `${label} · ${pdu.bytes.length} B`;
  const oh = el('g', { class: 'oh' }, g);
  const inner = el('g', { class: 'in' }, g);
  const ot = el('g', { class: 'ot' }, g);
  const diff = el('g', { class: 'diff' }, g);
  let dataG: SVGGElement | null = null;
  const outerIsApp = pdu.layers[0] ? isApp(pdu.layers[0].protocol) : false;
  for (const s of layout.segs) {
    const parent = !outerIsApp && s.depth === 0 ? (s.kind === 'trailer' ? ot : oh) : inner;
    const color = protocolColor(s.protocol);
    if (s.collapsed) {
      const dg = el('g', { class: 'data-run' }, parent);
      el('rect', { x: s.x, y: 0, width: s.w - 0.5, height: STRIP_H, rx: 1.5, fill: color, 'fill-opacity': 0.28, stroke: color, 'stroke-width': 0.8 }, dg);
      el('path', { d: `M${s.x + 3} ${STRIP_H - 3}l4 -7m3 7l4 -7m3 7l4 -7`, stroke: color, 'stroke-width': 0.8, fill: 'none', opacity: 0.8 }, dg);
      const tt = el('text', { class: 'data-size', x: s.x + s.w / 2 + 6, y: STRIP_H / 2 + 3 }, dg);
      tt.textContent = `${s.end - s.start} B`;
      dataG = dg;
    } else {
      el('path', { d: blocksPath(s.x, s.end - s.start), fill: color }, parent);
    }
  }
  return { g, oh, inner, ot, diff, data: dataG, layout, pduId: pdu.id };
}

/** grow = 1: full PDU. grow = 0: only what is inside the outer layer is visible, at the same x. */
export function applyGrow(s: StripEl, grow: number): void {
  const { ohW, otX } = s.layout;
  const shift = -(1 - grow) * ohW;
  s.oh.setAttribute('transform', `scale(${grow.toFixed(4)},1)`);
  s.oh.style.opacity = grow < 0.02 ? '0' : '1';
  s.inner.setAttribute('transform', `translate(${shift.toFixed(2)},0)`);
  s.ot.setAttribute('transform', `translate(${(shift + otX * (1 - grow)).toFixed(2)},0) scale(${grow.toFixed(4)},1)`);
  s.ot.style.opacity = grow < 0.02 ? '0' : '1';
}

/** Visible width for a given grow. */
export function grownWidth(s: StripEl, grow: number): number {
  return s.layout.width - (1 - grow) * (s.layout.ohW + s.layout.otW);
}

/** Highlights changed bytes (NAT / TTL). */
export function setDiff(s: StripEl, idx: number[] | undefined, strength: number): void {
  if (!idx || !idx.length || strength <= 0.01) {
    s.diff.style.display = 'none';
    return;
  }
  if (s.diff.getAttribute('data-n') !== String(idx.length)) {
    s.diff.replaceChildren();
    let d = '';
    for (const i of idx) {
      const x = s.layout.byteX[i] ?? -1;
      if (x >= 0) d += `M${(x - 0.6).toFixed(2)} -2h${BLOCK_W + 1.2}v${STRIP_H + 4}h-${BLOCK_W + 1.2}z`;
    }
    el('path', { d, class: 'diff-mark' }, s.diff);
    s.diff.setAttribute('data-n', String(idx.length));
  }
  s.diff.style.display = '';
  s.diff.style.opacity = strength.toFixed(3);
}
