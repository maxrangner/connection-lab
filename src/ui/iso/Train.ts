import { ETH_PREAMBLE, type PacketInfo, type PduSnapshot } from '../../sim';
import { el } from '../scene/svg';
import { layoutGizmo, pilotPart, type Part } from '../gizmo/Gizmo';
import { cablePointAt, type CableGeom } from './layout';
import { box } from './prims';
import { clamp01, iso, U } from './project';

const CAR_D = 0.55;
const GAP = 0.18;
const MAX_CAR_LEN = 2.2;

interface Car {
  part: Part;
  len: number;
  /** Offset of the car's leading end behind the train head. */
  offset: number;
  gX: SVGGElement;
  gY: SVGGElement;
  bits: number[];
}

/**
 * A frame on a cable: the gizmo unbolted into cars riding in byte order, preamble first. Each car carries a
 * pulse of its own real bits. Cars exist in two orientations because cables bend once.
 */
export class Train {
  readonly g: SVGGElement;
  readonly length: number;
  private cars: Car[] = [];
  private pulses: SVGPathElement[] = [];
  private lostMark: SVGGElement;
  private sparks: SVGGElement;

  constructor(
    readonly pdu: PduSnapshot,
    pk: PacketInfo | undefined,
    readonly cable: CableGeom,
    readonly wireBytes: number,
  ) {
    this.g = el('g', { class: 'train' });
    const layout = layoutGizmo(pdu, pk);
    const parts = [pilotPart(), ...layout.parts.filter((p) => p.kind !== 'frame')];
    let offset = 0;
    const bytesWithPreamble = new Uint8Array(ETH_PREAMBLE.length + pdu.bytes.length);
    bytesWithPreamble.set(ETH_PREAMBLE, 0);
    bytesWithPreamble.set(pdu.bytes, ETH_PREAMBLE.length);
    for (const part of parts) {
      const len = Math.min(MAX_CAR_LEN, Math.max(0.35, part.len));
      const gX = el('g', { class: 'car car-x' }, this.g);
      const gY = el('g', { class: 'car car-y' }, this.g);
      box(gX, { x: -len, y: -CAR_D / 2, z: 0.12, w: len, d: CAR_D, h: Math.min(0.55, part.h * 0.55), color: part.color });
      box(gY, { x: -CAR_D / 2, y: -len, z: 0.12, w: CAR_D, d: len, h: Math.min(0.55, part.h * 0.55), color: part.color });
      // Real bits of this car (LSB first per byte, as Ethernet sends them), decimated.
      const b0 = part.byteStart + 8;
      const b1 = part.byteEnd + 8;
      const total = (b1 - b0) * 8;
      const cells = Math.max(6, Math.min(24, Math.round(len * 10)));
      const bits: number[] = [];
      for (let k = 0; k < cells; k++) {
        const idx = part.kind === 'pilot' && k < 12 ? k : Math.floor((k * total) / cells);
        const byte = bytesWithPreamble[b0 + (idx >> 3)] ?? 0;
        bits.push((byte >> (idx & 7)) & 1);
      }
      for (const [g, axis] of [[gX, 'x'] as const, [gY, 'y'] as const]) {
        const path = el('path', { class: 'pulse', stroke: part.color }, g);
        path.setAttribute('d', pulsePath(bits, len, axis));
        this.pulses.push(path);
      }
      this.cars.push({ part, len, offset, gX, gY, bits });
      offset += len + GAP;
    }
    this.length = offset - GAP;
    this.lostMark = el('g', { class: 'lost-mark' }, this.g);
    el('text', { class: 'lost-text', 'text-anchor': 'middle' }, this.lostMark).textContent = '✕ lost';
    this.sparks = el('g', { class: 'sparks' }, this.g);
    this.lostMark.style.display = 'none';
    el('rect', { class: 'train-hit', x: -10, y: -14, width: 20, height: 28 }, this.g);
  }

  /**
   * @param s distance of the train head along the cable (tiles, measured from the cable's first point).
   * @param dir +1 when travelling from the cable's first point to its last, −1 the other way; the tail follows
   *   `length` behind the head in the direction of travel.
   * @param lost 0 = fine; > 0 = seconds since the frame was lost (cars tip off the cable).
   */
  pose(s: number, dir: 1 | -1, v: number, lost: number, opacity: number): void {
    const c = this.cable;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]!;
      const head = s - dir * car.offset;
      const tail = head - dir * car.len;
      const visible = Math.max(head, tail) > 0 && Math.min(head, tail) < c.length;
      const cp = cablePointAt(c, Math.max(0, Math.min(c.length, head)));
      const useX = cp.axis === 'x';
      const g = useX ? car.gX : car.gY;
      const other = useX ? car.gY : car.gX;
      other.style.display = 'none';
      if (!visible) {
        g.style.display = 'none';
        continue;
      }
      g.style.display = '';
      // Cars are built with their body behind the head along +x / +y; flip for the other way.
      const flip = cp.dir * dir < 0 ? -1 : 1;
      let p = iso(cp.p.x, cp.p.y, 0);
      let tilt = 0;

      if (lost > 0) {
        const k = clamp01(lost / 0.9);
        const drop = 42 * k * k;
        tilt = (i % 2 ? 1 : -1) * 18 * k;
        p = { sx: p.sx + (i % 2 ? 6 : -6) * k, sy: p.sy + drop };
      }
      const glow = 0.6 + 0.4 * Math.sin(2 * Math.PI * (2.5 * v + 0.3 * i));
      g.setAttribute('transform', `translate(${p.sx.toFixed(2)},${p.sy.toFixed(2)}) rotate(${tilt.toFixed(1)}) scale(${flip},1)`);
      g.style.opacity = (opacity * (lost > 0 ? 1 - clamp01(lost / 1.2) : 1)).toFixed(3);
      const pulse = g.querySelector('.pulse') as SVGPathElement | null;
      if (pulse) pulse.style.opacity = glow.toFixed(2);
    }
    const headPt = cablePointAt(c, Math.max(0, Math.min(c.length, s - (dir * this.length) / 2)));
    const hp = iso(headPt.p.x, headPt.p.y, 0);
    const hit = this.g.querySelector('.train-hit') as SVGRectElement;
    hit.setAttribute('x', (hp.sx - this.length * U * 0.6).toFixed(1));
    hit.setAttribute('width', (this.length * U * 1.2).toFixed(1));
    hit.setAttribute('y', (hp.sy - 16).toFixed(1));
    if (lost > 0) {
      this.lostMark.style.display = '';
      this.lostMark.setAttribute('transform', `translate(${hp.sx.toFixed(1)},${(hp.sy - 26).toFixed(1)})`);
      this.lostMark.style.opacity = (1 - clamp01((lost - 1.2) / 0.8)).toFixed(2);
      this.renderSparks(hp.sx, hp.sy, lost);
    } else {
      this.lostMark.style.display = 'none';
      this.sparks.style.display = 'none';
    }
  }

  private renderSparks(x: number, y: number, age: number): void {
    if (!this.sparks.childElementCount) {
      let seed = this.pdu.id.length * 7919 + 13;
      const rnd = (): number => ((seed = (seed * 233280 + 49297) % 233280) / 233280);
      for (let i = 0; i < 14; i++) {
        el('rect', { width: 2.6, height: 2.6, fill: i % 3 ? '#f59e0b' : '#e2e8f0', 'data-vx': (rnd() - 0.5) * 90, 'data-vy': (rnd() - 0.8) * 80 }, this.sparks);
      }
    }
    this.sparks.style.display = '';
    const k = clamp01(age / 1.0);
    const e = 1 - (1 - k) ** 3;
    for (const r of Array.from(this.sparks.children) as SVGRectElement[]) {
      r.setAttribute('x', (x + Number(r.getAttribute('data-vx')) * e).toFixed(1));
      r.setAttribute('y', (y + Number(r.getAttribute('data-vy')) * e + 50 * k * k).toFixed(1));
    }
    this.sparks.style.opacity = (1 - k * 0.9).toFixed(2);
  }
}

/** Square-wave of bits along the car, drawn under it, in screen space for the given axis. */
function pulsePath(bits: number[], len: number, axis: 'x' | 'y'): string {
  const n = bits.length;
  const cell = len / n;
  const amp = 2.8;
  let d = '';
  let prev: number | null = null;
  for (let k = 0; k < n; k++) {
    const along = -(k * cell); // behind the head
    const p = axis === 'x' ? iso(along, 0, 0) : iso(0, along, 0);
    const q = axis === 'x' ? iso(along - cell, 0, 0) : iso(0, along - cell, 0);
    const y0 = bits[k] ? -amp : amp;
    if (k === 0) d += `M${p.sx.toFixed(1)} ${(p.sy + 9 + y0).toFixed(1)}`;
    else if (prev !== y0) d += `L${p.sx.toFixed(1)} ${(p.sy + 9 + y0).toFixed(1)}`;
    d += `L${q.sx.toFixed(1)} ${(q.sy + 9 + y0).toFixed(1)}`;
    prev = y0;
  }
  return d;
}
