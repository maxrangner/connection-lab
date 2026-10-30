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
  /** Does dropping it at this point put it to work? */
  hits(p: Pt): boolean;
  canMove(): boolean;
  /** Follows the view instead of lying on the table (so it stays in reach), at this size. */
  pinned?(): { scale: number } | null;
  /** Out of the way for now. */
  hidden?(): boolean;
  onChange(on: boolean): void;
}

export class Prop {
  on: boolean;
  private readonly g: SVGGElement;
  private readonly fx: SVGGElement;
  private readonly name: SVGTextElement;
  private pos: Pt;
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
      const p = this.toSvg(e);
      this.drag = { dx: this.pos.sx - p.sx, dy: this.pos.sy - p.sy, x0: e.clientX, y0: e.clientY, moved: false };
      this.g.setPointerCapture(e.pointerId);
      this.g.classList.add('held');
    });
    this.g.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      if (Math.hypot(e.clientX - this.drag.x0, e.clientY - this.drag.y0) > 6) this.drag.moved = true;
      const p = this.toSvg(e);
      this.pos = { sx: p.sx + this.drag.dx, sy: p.sy + this.drag.dy };
      this.g.classList.toggle('over', spec.hits(this.pos));
    });
    this.g.addEventListener('pointerup', () => {
      if (!this.drag) return;
      const tapped = !this.drag.moved;
      this.drag = null;
      this.g.classList.remove('held', 'over');
      this.set(tapped ? !this.on : spec.hits(this.pos));
    });
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.spec.onChange(on);
  }

  private toSvg(e: PointerEvent): Pt {
    const m = this.svg.getScreenCTM();
    if (!m) return { sx: 0, sy: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { sx: p.x, sy: p.y };
  }

  update(dt: number, time: number): void {
    const target = this.on ? this.spec.active() : this.spec.parked();
    const pin = this.spec.pinned?.() ?? null;
    if (!this.drag) {
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
  }
}

/** A puffy cloud from circles on a flat base. */
export function drawCloud(g: SVGGElement): void {
  for (const [x, y, r] of [[-30, 2, 17], [-9, -11, 22], [17, -6, 19], [34, 4, 13]] as const) el('circle', { cx: x, cy: y, r, class: 'cloud-puff' }, g);
  el('rect', { x: -42, y: 2, width: 86, height: 16, rx: 8, class: 'cloud-puff' }, g);
}

/** Rain while it is working, in little jumps like the crackle on the cables. */
export function rain(g: SVGGElement, time: number, on: boolean): void {
  g.replaceChildren();
  if (!on) return;
  const tick = (time * 14) % 1;
  for (let i = 0; i < 9; i++) {
    const x = -36 + i * 9;
    const y = 22 + ((i * 37) % 19) + tick * 16;
    el('line', { x1: x, y1: y, x2: x - 3, y2: y + 11, class: 'rain' }, g);
  }
}

/** A small satellite, the same boxes and panels as a device, drawn around the origin. */
export function drawSatellite(g: SVGGElement): void {
  rbox(g, { cx: 0, cy: 0, z: -0.35, len: 0.7, wid: 0.7, h: 0.7, angle: 0, color: '#cfc6b8' });
  for (const s of [-1, 1]) tile(g, -0.45 + s * 1.15, -0.35, 0.9, 0.7, 0, { class: 'panel' });
}
