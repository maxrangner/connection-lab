import type { PacketInfo, PduSnapshot } from '../../sim';
import { el } from '../scene/svg';
import { PART_D } from '../iso/layout';
import { box, type BoxEl } from '../iso/prims';
import { clamp01, easeOutBack, iso, lerp, type Vec3 } from '../iso/project';
import { layoutGizmo, type GizmoLayout, type Part } from './Gizmo';

/** Longest gizmo that fits a floor slot, in tiles; longer ones are compressed along their axis. */
export const MAX_LEN = 4.6;

interface PartView {
  part: Part;
  g: SVGGElement;
  boxes: BoxEl[];
  label?: SVGGElement;
}

export interface GizmoPose {
  /** World position of the gizmo's left-front-bottom corner. */
  origin: Vec3;
  /** 0 → the outer layer is detached (off to the machine side), 1 → bolted on. */
  grow: number;
  /** Parts fly apart toward the port (+1 right, −1 left); 0 = assembled. */
  scatter: number;
  scatterDir: 1 | -1;
  /** Strength of the "changed bytes" highlight. */
  diff: number;
  diffBytes?: number[];
  opacity: number;
  /** Fraction of the core already cut away (stream tracks). */
  consumed: number;
}

/**
 * The SVG for one PDU as a gizmo. Built once at the origin (parts along +x), then posed per frame by
 * translating part groups. Scrubbing-safe: every visual is a function of the pose.
 */
export class GizmoView {
  readonly g: SVGGElement;
  readonly layout: GizmoLayout;
  readonly k: number;
  private views: PartView[] = [];
  private seams: SVGGElement;

  constructor(readonly pdu: PduSnapshot, pk: PacketInfo | undefined) {
    this.layout = layoutGizmo(pdu, pk);
    this.k = Math.min(1, MAX_LEN / Math.max(1e-6, this.layout.length));
    this.g = el('g', { class: 'gizmo', 'data-pdu': pdu.id });
    this.seams = el('g', { class: 'seams' });
    // Draw order: frame rails first (behind), then parts by x, then seams and labels.
    const ordered = [...this.layout.parts].sort((a, b) => (a.kind === 'frame' ? -1 : b.kind === 'frame' ? 1 : a.x - b.x));
    for (const part of ordered) this.views.push(this.buildPart(part));
    this.g.appendChild(this.seams);
    for (const v of this.views) if (v.label) this.g.appendChild(v.label);
    // Bolt discs on every seam, built relative to the gizmo origin (iso() is linear, so a translate places them).
    for (const part of this.layout.parts) {
      if (part.kind === 'frame' || part.x === 0) continue;
      const c = iso(part.x * this.k, PART_D * 0.5, Math.min(part.h, 0.6));
      el('circle', { cx: c.sx.toFixed(1), cy: c.sy.toFixed(1), r: 1.8, class: 'seam-bolt' }, this.seams);
    }
  }

  private buildPart(part: Part): PartView {
    const g = el('g', { class: `part part-${part.kind}`, 'data-part': part.id }, this.g);
    const len = part.len * this.k;
    const boxes: BoxEl[] = [];
    if (part.kind === 'frame') {
      // Two thin rails along the top edges of the shell.
      boxes.push(box(g, { x: 0, y: 0, z: part.h - 0.1, w: len, d: 0.1, h: 0.1, color: part.color }));
      boxes.push(box(g, { x: 0, y: PART_D - 0.1, z: part.h - 0.1, w: len, d: 0.1, h: 0.1, color: part.color }));
      boxes.push(box(g, { x: 0, y: 0, z: 0, w: len, d: 0.08, h: 0.08, color: part.color, faces: { top: 0.7, left: 0.6, right: 0.5 } }));
      return { part, g, boxes };
    }
    const d = part.kind === 'plate' ? PART_D - 0.1 : PART_D;
    const b = box(g, { x: 0, y: (PART_D - d) / 2, z: 0, w: len, d, h: part.h, color: part.color, cls: part.collapsed ? 'collapsed' : '' });
    boxes.push(b);
    if (part.collapsed) {
      // Hatching on the top face says "there is more here than we draw".
      const hatch = el('g', { class: 'hatch' }, g);
      for (let x = 0.25; x < len; x += 0.45) {
        const a = iso(x, 0.1, part.h);
        const c = iso(Math.min(len, x + 0.3), d - 0.1, part.h);
        el('line', { x1: a.sx, y1: a.sy, x2: c.sx, y2: c.sy, class: 'hatch-line' }, hatch);
      }
    }
    if (part.kind === 'module' || part.kind === 'plate') {
      // A small dial/connector detail so modules read as machine parts, not bricks.
      const c = iso(len * 0.5, PART_D * 0.5, part.h);
      el('ellipse', { cx: c.sx, cy: c.sy, rx: Math.min(6, len * 6), ry: Math.min(3, len * 3), class: 'part-dial' }, g);
    }
    if (part.kind === 'shellFront' || part.kind === 'shellBack') {
      const c = iso(len * 0.5, PART_D * 0.5, part.h);
      el('circle', { cx: c.sx, cy: c.sy, r: 2.2, class: 'part-rivet' }, g);
    }
    let label: SVGGElement | undefined;
    if (part.labels.length && part.kind !== 'filler') {
      const text = part.labels.map((l) => l.text).join(' · ');
      const c = iso(len * 0.5, PART_D * 0.5, part.h);
      // Inner layers get higher labels (stair-step) with a leader, so neighbouring labels never collide.
      const step = part.kind === 'shellBack' || part.kind === 'pilot' ? 0 : Math.max(0, part.depth);
      const dy = -8 - 13 * step;
      label = el('g', { class: 'part-label-g', 'data-part': part.id });
      el('line', { x1: c.sx.toFixed(1), y1: (c.sy - 1).toFixed(1), x2: c.sx.toFixed(1), y2: (c.sy + dy + 3).toFixed(1), class: 'part-leader' }, label);
      const t = el('text', { x: c.sx.toFixed(1), y: (c.sy + dy).toFixed(1), class: `part-label${step > 0 ? ' inner' : ''}`, 'text-anchor': 'middle' }, label);
      t.textContent = text;
    }
    return { part, g, boxes, label };
  }

  /** Byte index → the part that owns it. */
  partAt(byte: number): Part | undefined {
    return this.layout.parts.find((p) => p.kind !== 'frame' && byte >= p.byteStart && byte < p.byteEnd);
  }

  pose(p: GizmoPose): void {
    const L = this.layout;
    const outer = new Set(L.outerIds);
    const gBack = easeOutBack(clamp01(p.grow));
    const shift = L.outerFrontLen * this.k * (1 - clamp01(p.grow));
    const diffParts = new Set<string>();
    if (p.diff > 0.01 && p.diffBytes) for (const b of p.diffBytes) {
      const part = this.partAt(b);
      if (part) diffParts.add(part.id);
    }
    const n = this.views.filter((v) => v.part.kind !== 'frame').length;
    let idx = 0;
    for (const v of this.views) {
      const part = v.part;
      const isOuter = outer.has(part.id);
      const isFrame = part.kind === 'frame';
      let dx = part.x * this.k;
      let dy = 0;
      let dz = 0;
      let op = 1;
      if (isOuter) {
        // Outer parts slide in from the machine side (behind) and settle with a small overshoot.
        const fromBack = part.kind === 'shellBack' ? 1.6 : -1.2;
        dx += fromBack * (1 - gBack);
        dy -= 2.2 * (1 - gBack);
        dz += 0.9 * (1 - gBack);
        op = clamp01(p.grow * 3);
      } else {
        dx -= shift;
      }
      if (p.scatter > 0 && !isFrame) {
        // Parts peel off toward the port in byte order (first part first).
        const order = idx / Math.max(1, n - 1);
        const s = clamp01((p.scatter - order * 0.35) / 0.65);
        dx += p.scatterDir * (2.4 + order * 1.2) * s;
        dz += 0.5 * Math.sin(Math.PI * s);
        op *= 1 - clamp01((s - 0.6) / 0.4);
      }
      if (part.kind === 'core' && p.consumed > 0) {
        // The stream is eaten from the left: translate right and shrink.
        const len = part.len * this.k;
        const c = iso(len * p.consumed, 0, 0);
        v.g.setAttribute('transform', `translate(${c.sx.toFixed(2)},${c.sy.toFixed(2)}) scale(${(1 - p.consumed).toFixed(3)})`);
        if (v.label) v.label.style.display = p.consumed > 0.95 ? 'none' : '';
        continue;
      }
      if (isFrame) {
        op = clamp01(p.grow * 3) * (1 - clamp01(p.scatter * 2));
        dx = part.x * this.k - 1.2 * (1 - gBack);
        dy = -2.2 * (1 - gBack);
        dz = 0.9 * (1 - gBack);
      }
      const o = { x: p.origin.x + dx, y: p.origin.y + dy, z: p.origin.z + dz };
      const s = iso(o.x, o.y, o.z);
      v.g.setAttribute('transform', `translate(${s.sx.toFixed(2)},${s.sy.toFixed(2)})`);
      v.g.style.opacity = (op * p.opacity).toFixed(3);
      const hot = diffParts.has(part.id) ? p.diff : 0;
      v.g.classList.toggle('hot', hot > 0.05);
      if (v.label) {
        v.label.setAttribute('transform', `translate(${s.sx.toFixed(2)},${s.sy.toFixed(2)})`);
        v.label.style.opacity = (op * p.opacity * (isOuter ? clamp01((p.grow - 0.7) / 0.3) : 1)).toFixed(3);
        v.label.classList.toggle('hot', hot > 0.05);
      }
      if (!isFrame) idx++;
    }
    // Bolt discs on the seams once the outer layer is home.
    const show = p.grow > 0.85 && p.scatter < 0.05 && p.consumed === 0;
    this.seams.style.display = show ? '' : 'none';
    if (show) {
      const s = iso(p.origin.x, p.origin.y, p.origin.z);
      this.seams.setAttribute('transform', `translate(${s.sx.toFixed(2)},${s.sy.toFixed(2)})`);
      this.seams.style.opacity = p.opacity.toFixed(3);
    }
    const pop = p.grow > 0.85 && p.grow < 1 ? 1 + 0.05 * Math.sin(Math.PI * (p.grow - 0.85) / 0.15) : 1;
    const c0 = iso(p.origin.x + (L.length * this.k) / 2, p.origin.y + PART_D / 2, p.origin.z);
    this.g.setAttribute('transform', pop !== 1 ? `translate(${c0.sx},${c0.sy}) scale(${pop.toFixed(3)}) translate(${-c0.sx},${-c0.sy})` : '');
    this.g.style.opacity = p.opacity.toFixed(3);
  }

  get lengthTiles(): number {
    return this.layout.length * this.k;
  }
}

export { lerp };
