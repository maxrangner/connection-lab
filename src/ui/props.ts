import { el } from './svg';
import { rbox, tile } from './prims';
import { lerp } from './project';

/**
 * Things lying on the table that change the network: pick one up and put it where it does its job, or tap it. Drag
 * it away (or tap it again) and it goes back to its parking spot.
 */

type Pt = { sx: number; sy: number };

export interface PropSpec {
  label: string;
  cls: string;
  draw(g: SVGGElement): void;
  /** Called every frame with the wall clock, e.g. for rain. */
  animate?(g: SVGGElement, time: number, on: boolean): void;
  parked(): Pt;
  /** Where it sits while it is working. */
  active(): Pt;
  /** Does holding it at this point put it to work? */
  hits(p: Pt): boolean;
  /** Handles a drop at a point, or a tap (null), itself, instead of switching on and off by `hits`. */
  dropped?(p: Pt | null): void;
  /** Leave a faint outline where it waits while it is at work; tapping that outline calls it back. */
  ghost?: boolean;
  canMove(): boolean;
  /** Follows the view instead of lying on the table (so it stays in reach), at this size. */
  pinned?(): { scale: number } | null;
  /** Size of the outline left behind. */
  waiting?(): number;
  /** Out of the way for now. */
  hidden?(): boolean;
  onChange(on: boolean): void;
}

export class Prop {
  on: boolean;
  private readonly g: SVGGElement;
  private readonly fx: SVGGElement;
  private readonly name: SVGTextElement;
  private readonly outline: SVGGElement | null = null;
  private pos: Pt;
  /** Where the pointer is, so a held prop stays under it while the camera moves. */
  private pointer = { x: 0, y: 0 };
  private drag: { dx: number; dy: number; x0: number; y0: number; moved: boolean } | null = null;
  /** Wall-clock seconds left of a "not now" shake. */
  private refuse = 0;

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly spec: PropSpec,
    on: boolean,
  ) {
    this.on = on;
    this.pos = on ? spec.active() : spec.parked();
    if (spec.ghost) {
      this.outline = el('g', { class: `prop-ghost ${spec.cls}-ghost` }, svg);
      spec.draw(this.outline);
      this.outline.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        spec.dropped?.(null);
      });
    }
    this.g = el('g', { class: `prop ${spec.cls}` }, svg);
    const body = el('g', {}, this.g);
    spec.draw(body);
    this.fx = el('g', {}, this.g);
    this.name = el('text', { y: 50, 'text-anchor': 'middle', class: 'sticker-label' }, this.g);
    this.name.textContent = spec.label;

    this.g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (!spec.canMove()) {
        this.refuse = 0.4;
        return;
      }
      this.pointer = { x: e.clientX, y: e.clientY };
      const p = this.toSvg(this.pointer);
      this.drag = { dx: this.pos.sx - p.sx, dy: this.pos.sy - p.sy, x0: e.clientX, y0: e.clientY, moved: false };
      this.g.setPointerCapture(e.pointerId);
      this.g.classList.add('held');
    });
    this.g.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      if (Math.hypot(e.clientX - this.drag.x0, e.clientY - this.drag.y0) > 6) this.drag.moved = true;
      this.pointer = { x: e.clientX, y: e.clientY };
    });
    this.g.addEventListener('pointerup', () => {
      if (!this.drag) return;
      const tapped = !this.drag.moved;
      this.drag = null;
      this.g.classList.remove('held', 'over');
      if (spec.dropped) {
        // A tap with nowhere to go: it wants to be put somewhere.
        if (tapped && !this.on) this.refuse = 0.4;
        spec.dropped(tapped ? null : this.pos);
      } else this.set(tapped ? !this.on : spec.hits(this.pos));
    });
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.spec.onChange(on);
  }

  private toSvg(e: { x: number; y: number }): Pt {
    const m = this.svg.getScreenCTM();
    if (!m) return { sx: 0, sy: 0 };
    const p = new DOMPoint(e.x, e.y).matrixTransform(m.inverse());
    return { sx: p.x, sy: p.y };
  }

  update(dt: number, time: number): void {
    const target = this.on ? this.spec.active() : this.spec.parked();
    const pin = this.spec.pinned?.() ?? null;
    if (this.drag) {
      const p = this.toSvg(this.pointer);
      this.pos = { sx: p.sx + this.drag.dx, sy: p.sy + this.drag.dy };
      this.g.classList.toggle('over', this.spec.hits(this.pos));
    } else {
      const ease = Math.min(1, dt * (pin ? 16 : 7));
      this.pos = { sx: lerp(this.pos.sx, target.sx, ease), sy: lerp(this.pos.sy, target.sy, ease) };
    }
    this.refuse = Math.max(0, this.refuse - dt);
    const shake = this.refuse > 0 ? Math.sin(this.refuse * 45) * 5 : 0;
    const bob = this.drag ? 0 : Math.sin(time * 1.6) * 3;
    const scale = (pin?.scale ?? 1) * (this.drag ? 1.1 : 1);
    this.g.setAttribute('transform', `translate(${(this.pos.sx + shake).toFixed(1)} ${(this.pos.sy + bob).toFixed(1)}) scale(${scale})`);
    this.g.classList.toggle('on', this.on);
    this.g.style.display = this.spec.hidden?.() ? 'none' : '';
    this.name.style.display = this.on || this.drag ? 'none' : '';
    this.spec.animate?.(this.fx, time, this.on);
    if (this.outline) {
      const at = this.spec.parked();
      this.outline.style.display = this.on ? '' : 'none';
      this.outline.setAttribute('transform', `translate(${at.sx.toFixed(1)} ${at.sy.toFixed(1)}) scale(${this.spec.waiting?.() ?? 1})`);
    }
  }
}

/** A puffy cloud from circles on a flat base. */
export function drawCloud(g: SVGGElement): void {
  for (const [x, y, r] of [[-30, 2, 17], [-9, -11, 22], [17, -6, 19], [34, 4, 13]] as const) el('circle', { cx: x, cy: y, r, class: 'cloud-puff' }, g);
  el('rect', { x: -42, y: 2, width: 86, height: 16, rx: 8, class: 'cloud-puff' }, g);
}

/** Rain while it is working: each drop falls and fades, about one fall a second. */
export function rain(g: SVGGElement, time: number, on: boolean): void {
  g.replaceChildren();
  if (!on) return;
  for (let i = 0; i < 9; i++) {
    const q = (time * 0.9 + i * 0.37) % 1;
    const y = 20 + q * 34;
    const x = -36 + i * 9 - q * 4;
    el('line', { x1: x, y1: y, x2: x - 2.5, y2: y + 9, class: 'rain', opacity: (1 - q * q).toFixed(2) }, g);
  }
}

/** A small satellite, the same boxes and panels as a device, drawn around the origin. */
export function drawSatellite(g: SVGGElement): void {
  rbox(g, { cx: 0, cy: 0, z: -0.35, len: 0.7, wid: 0.7, h: 0.7, angle: 0, color: '#cfc6b8' });
  for (const s of [-1, 1]) tile(g, -0.45 + s * 1.15, -0.35, 0.9, 0.7, 0, { class: 'panel' });
}

/** A magnifying glass. */
export function drawSpyglass(g: SVGGElement): void {
  el('line', { x1: 13, y1: 13, x2: 30, y2: 30, class: 'spy-handle' }, g);
  el('circle', { cx: 0, cy: 0, r: 19, class: 'spy-lens' }, g);
  el('path', { d: 'M-11 -6 A12 12 0 0 1 -4 -12', class: 'spy-shine' }, g);
}
