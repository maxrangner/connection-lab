import type { PacketInfo, PduSnapshot } from '../../sim';
import { el } from '../scene/svg';
import { PART_D } from '../iso/layout';
import { box } from '../iso/prims';
import { clamp01, easeOut, easeOutBack, iso, type Vec3 } from '../iso/project';
import { layoutGizmo, placeParts, type GizmoLayout, type Part } from './Gizmo';

/** Longest gizmo that fits a floor slot, in tiles; longer ones are compressed along their axis. */
export const MAX_LEN = 4.6;
/** Gap between parts on the wire, in tiles. */
export const WIRE_GAP = 0.32;

interface PartView {
  part: Part;
  g: SVGGElement;
}

export interface GizmoPose {
  /** World position of the leading face's bottom-front corner (byte 0 is here). */
  lead: Vec3;
  /** 0 → the outer layer is detached (off toward the station), 1 → bolted on. */
  grow: number;
  /** 0 = closed up; 1 = parts spread apart as on the wire. */
  spread: number;
  /** 0 → only flying byte cubes, 1 → solid core (data being assembled). */
  assemble: number;
  /** Strength of the "changed bytes" highlight. */
  diff: number;
  diffBytes?: number[];
  opacity: number;
  /** Fraction of the core already cut away (application stream being handed to TCP). */
  consumed: number;
  /** Seconds since the frame was lost (parts tip off the cable), 0 if not lost. */
  lost: number;
}

/** Where the station stands relative to the slot: outer parts and byte cubes come from here. */
const FROM_STATION = { y: -2.0, z: 0.9 };

/**
 * One packet's gizmo, drawn once and then posed every frame. The same view is used on the sending floor, on the
 * cable and on the receiving floor, so the packet is literally one object for the whole hop.
 */
export class GizmoView {
  readonly g: SVGGElement;
  readonly layout: GizmoLayout;
  readonly k: number;
  private views: PartView[] = [];
  private byId = new Map<string, PartView>();
  private labelG: SVGGElement | undefined;
  private lines: { el: SVGTextElement; parts: Part[] }[] = [];
  private cubes: SVGGElement | undefined;
  private cubeData: { g: SVGGElement; from: Vec3; to: Vec3; delay: number }[] = [];

  constructor(
    readonly pdu: PduSnapshot,
    pk: PacketInfo | undefined,
    readonly dir: 1 | -1,
  ) {
    this.layout = layoutGizmo(pdu, pk);
    this.k = Math.min(1, MAX_LEN / Math.max(1e-6, this.layout.length));
    this.g = el('g', { class: 'gizmo', 'data-pdu': pdu.id });
    // Rails first (behind), then parts, then labels on top.
    const ordered = [...this.layout.parts].sort((a, b) => (a.kind === 'frame' ? -1 : b.kind === 'frame' ? 1 : 0));
    for (const part of ordered) {
      const v = this.buildPart(part);
      this.views.push(v);
      this.byId.set(part.id, v);
    }
    this.buildLabels();
  }

  /**
   * One tidy label stack in front of the gizmo: a line per layer (outermost first), in the layer's colour. Lines for
   * an outer layer fade in and out with its parts.
   */
  private buildLabels(): void {
    this.labelG = el('g', { class: 'gizmo-labels' }, this.g);
    const byProto = new Map<string, { protocol: string; color: string; texts: string[]; parts: Part[]; first: number }>();
    for (const part of [...this.layout.parts].sort((a, b) => a.byteStart - b.byteStart)) {
      if (part.kind === 'frame' || part.kind === 'filler' || !part.labels.length) continue;
      const key = part.protocol;
      let line = byProto.get(key);
      if (!line) {
        line = { protocol: key, color: part.color, texts: [], parts: [], first: part.byteStart };
        byProto.set(key, line);
      }
      line.texts.push(...part.labels.map((l) => l.text));
      line.parts.push(part);
    }
    const lines = [...byProto.values()].sort((a, b) => a.first - b.first);
    lines.forEach((ln, i) => {
      const t = el('text', { class: 'gl-line', x: 0, y: 12 + i * 12, 'text-anchor': 'middle', fill: ln.color }, this.labelG!);
      t.textContent = ln.texts.join(' · ');
      this.lines.push({ el: t, parts: ln.parts });
    });
  }

  /** Builds a part at the origin, extending along +x. Posing translates it. */
  private buildPart(part: Part): PartView {
    const g = el('g', { class: `part part-${part.kind}`, 'data-part': part.id }, this.g);
    const len = part.len * this.k;
    if (part.kind === 'frame') {
      box(g, { x: 0, y: 0, z: part.h - 0.1, w: len, d: 0.1, h: 0.1, color: part.color });
      box(g, { x: 0, y: PART_D - 0.1, z: part.h - 0.1, w: len, d: 0.1, h: 0.1, color: part.color });
      return { part, g };
    }
    const d = part.kind === 'plate' ? PART_D - 0.1 : PART_D;
    box(g, { x: 0, y: (PART_D - d) / 2, z: 0, w: len, d, h: part.h, color: part.color, cls: part.collapsed ? 'collapsed' : '' });
    if (part.collapsed) {
      const hatch = el('g', { class: 'hatch' }, g);
      for (let x = 0.25; x < len; x += 0.45) {
        const a = iso(x, 0.1, part.h);
        const c = iso(Math.min(len, x + 0.3), d - 0.1, part.h);
        el('line', { x1: a.sx, y1: a.sy, x2: c.sx, y2: c.sy, class: 'hatch-line' }, hatch);
      }
    }
    return { part, g };
  }

  /** Byte index → the part that owns it. */
  partAt(byte: number): Part | undefined {
    return this.layout.parts.find((p) => p.kind !== 'frame' && byte >= p.byteStart && byte < p.byteEnd);
  }

  /** Total length on a floor (closed up). */
  get lengthTiles(): number {
    return this.layout.length * this.k;
  }

  /** Total length on the wire (spread). */
  get wireLength(): number {
    const n = this.layout.parts.filter((p) => p.kind !== 'frame').length;
    return this.lengthTiles + Math.max(0, n - 1) * WIRE_GAP;
  }

  pose(p: GizmoPose): void {
    const L = this.layout;
    const outer = new Set(L.outerIds);
    const grow = clamp01(p.grow);
    const gBack = easeOutBack(grow);
    const placed = placeParts(L, this.dir, WIRE_GAP * clamp01(p.spread), this.k);
    // While the outer header is detached, everything inside slides up to the leading face (where it sat before).
    const headerLen = L.outerFrontLen * this.k;
    const innerShift = this.dir * headerLen * (1 - grow);
    const diffParts = new Set<string>();
    if (p.diff > 0.01 && p.diffBytes) {
      for (const b of p.diffBytes) {
        const part = this.partAt(b);
        if (part) diffParts.add(part.id);
      }
    }
    const lostK = clamp01(p.lost / 0.9);
    for (const pl of placed) {
      const v = this.byId.get(pl.id)!;
      const part = v.part;
      const isOuter = outer.has(part.id);
      let x = p.lead.x + pl.x0;
      let y = p.lead.y;
      let z = p.lead.z;
      let op = p.opacity;
      if (isOuter) {
        // Outer parts come out of the station behind the slot and settle with a small overshoot.
        y += FROM_STATION.y * (1 - gBack);
        z += FROM_STATION.z * (1 - gBack);
        op *= clamp01(grow * 3);
      } else {
        x += innerShift;
      }
      if (part.kind === 'frame') op *= 1 - clamp01(p.spread * 3);
      if (part.kind === 'core') op *= p.assemble >= 1 ? 1 : clamp01((p.assemble - 0.7) / 0.3);
      let s = iso(x, y, z);
      let scale = '';
      if (part.kind === 'core' && p.consumed > 0) {
        // Bytes handed to TCP leave from the leading end: the core shrinks toward its back.
        const len = part.len * this.k;
        if (this.dir < 0) s = iso(x + len * p.consumed, y, z);
        scale = ` scale(${(1 - p.consumed).toFixed(3)},1)`;
        if (p.consumed > 0.98) op = 0;
      }
      if (lostK > 0) {
        const wob = (pl.order % 2 ? 1 : -1) * 7 * lostK;
        s = { sx: s.sx + wob, sy: s.sy + 46 * lostK * lostK };
        op *= 1 - clamp01(p.lost / 1.2);
      }
      v.g.setAttribute('transform', `translate(${s.sx.toFixed(2)},${s.sy.toFixed(2)})${scale}`);
      v.g.style.opacity = op.toFixed(3);
      const hot = diffParts.has(part.id) ? p.diff : 0;
      v.g.classList.toggle('hot', hot > 0.05);
    }
    this.poseLabels(p, outer, grow, diffParts);
    this.poseCubes(p);
  }

  private poseLabels(p: GizmoPose, outer: Set<string>, grow: number, hot: Set<string>): void {
    const lg = this.labelG;
    if (!lg) return;
    const visible = p.opacity * (1 - clamp01(p.spread * 2)) * (p.lost > 0 ? 0 : 1) * clamp01((p.assemble - 0.8) / 0.2);
    lg.style.display = visible < 0.02 ? 'none' : '';
    if (visible < 0.02) return;
    // On the floor in front of the gizmo (tags from the stations rise above it, so the two never meet).
    const len = this.lengthTiles;
    const cx = p.lead.x - this.dir * len * 0.5;
    const s = iso(cx, p.lead.y + PART_D + 0.2, p.lead.z);
    lg.setAttribute('transform', `translate(${s.sx.toFixed(1)},${s.sy.toFixed(1)})`);
    lg.style.opacity = visible.toFixed(3);
    for (const ln of this.lines) {
      const isOuter = ln.parts.some((x) => outer.has(x.id));
      const op = isOuter ? clamp01((grow - 0.6) / 0.4) : 1;
      ln.el.style.opacity = op.toFixed(3);
      ln.el.classList.toggle('hot', ln.parts.some((x) => hot.has(x.id)) && p.diff > 0.05);
      const consumedAway = p.consumed > 0.95 && ln.parts.some((x) => x.kind === 'core');
      ln.el.style.display = consumedAway ? 'none' : '';
    }
  }

  /** Byte cubes flying in from the station and snapping into the core while data is assembled. */
  private poseCubes(p: GizmoPose): void {
    const core = this.layout.parts.find((x) => x.kind === 'core');
    if (!core || p.assemble >= 1 || p.consumed > 0) {
      if (this.cubes) this.cubes.style.display = 'none';
      return;
    }
    if (!this.cubes) {
      this.cubes = el('g', { class: 'cubes' });
      this.g.insertBefore(this.cubes, this.g.firstChild);
      const n = Math.max(8, Math.min(40, core.byteEnd - core.byteStart));
      const len = core.len * this.k;
      const cols = Math.max(1, Math.ceil(n / 3));
      let seed = this.pdu.id.length * 7919 + n * 31;
      const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < n; i++) {
        const cg = el('g', {}, this.cubes);
        const cube = 0.2;
        box(cg, { x: 0, y: 0, z: 0, w: cube, d: cube, h: cube, color: core.color });
        const col = i % cols;
        const row = Math.floor(i / cols);
        const to = { x: (col + 0.5) * (len / cols) - cube / 2, y: 0.15 + row * 0.32, z: 0.1 + (row % 2) * 0.25 };
        const from = { x: to.x + (rnd() - 0.5) * 2.5, y: FROM_STATION.y + (rnd() - 0.5) * 0.8, z: FROM_STATION.z + 0.4 + rnd() * 1.4 };
        this.cubeData.push({ g: cg, from, to, delay: (i / n) * 0.45 });
      }
    }
    this.cubes.style.display = '';
    // Cubes land inside the core's footprint; find the core's -x end in world space.
    const placed = placeParts(this.layout, this.dir, 0, this.k).find((x) => x.id === core.id)!;
    const base = { x: p.lead.x + placed.x0, y: p.lead.y, z: p.lead.z };
    for (const c of this.cubeData) {
      const t = easeOut(clamp01((p.assemble - c.delay) / 0.45));
      const s = iso(base.x + c.from.x + (c.to.x - c.from.x) * t, base.y + c.from.y + (c.to.y - c.from.y) * t, base.z + c.from.z + (c.to.z - c.from.z) * t);
      c.g.setAttribute('transform', `translate(${s.sx.toFixed(2)},${s.sy.toFixed(2)})`);
      c.g.style.opacity = (p.opacity * clamp01(t * 4) * (1 - clamp01((p.assemble - 0.85) / 0.15))).toFixed(3);
    }
  }
}
