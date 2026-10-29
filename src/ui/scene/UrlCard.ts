import { clamp01, easeInOut, easeOut, lerp } from '../iso/project';
import type { IsoScene } from '../iso/IsoScene';
import { el, text } from './svg';

type State = 'assembling' | 'idle' | 'dragging' | 'gliding' | 'snapping' | 'absorbing' | 'gone';

const W = 236;
const H = 82;
const CELL = 2.4;

/**
 * The thing the user drags into the laptop. Its bit pattern is the real ASCII encoding of the URL (8 bits per
 * character, most significant bit on top). Physics: pointer drag with release velocity, friction, wall bounces and
 * a critically-damped spring into the drop target.
 */
export class UrlCard {
  readonly g: SVGGElement;
  private state: State = 'assembling';
  private pos = { x: 0, y: 0 };
  private vel = { x: 0, y: 0 };
  private samples: { t: number; x: number; y: number }[] = [];
  private grab = { x: 0, y: 0 };
  private age = 0;
  private bits: { el: SVGRectElement; tx: number; ty: number; sx: number; sy: number; delay: number }[] = [];
  private hint: SVGGElement;
  private body: SVGGElement;
  private absorbT = 0;

  constructor(
    private readonly scene: IsoScene,
    readonly url: string,
    private readonly targetId: string,
    start: { x: number; y: number },
    private readonly onDrop: () => void,
  ) {
    this.pos = { ...start };
    this.g = el('g', { class: 'url-card' }, scene.gOverlay);
    this.hint = el('g', { class: 'drop-hint' }, scene.gOverlay);
    el('path', { class: 'hint-arrow' }, this.hint);
    text(this.hint, 0, 0, 'drag me into the laptop', 'hint-text', { 'text-anchor': 'middle' });
    this.body = el('g', {}, this.g);
    el('rect', { class: 'url-bg', x: -W / 2, y: -H / 2, width: W, height: H, rx: 12 }, this.body);
    text(this.body, -W / 2 + 14, -H / 2 + 24, url, 'url-text');
    text(this.body, -W / 2 + 14, H / 2 - 10, `${url.length} bytes · ASCII · ${url.length * 8} bits`, 'url-sub');
    const bitsG = el('g', {}, this.body);
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const x0 = -W / 2 + 14;
    const y0 = -H / 2 + 34;
    for (let i = 0; i < url.length; i++) {
      const c = url.charCodeAt(i);
      for (let b = 0; b < 8; b++) {
        const on = (c >> (7 - b)) & 1;
        const tx = x0 + i * (CELL * 4.6);
        const ty = y0 + b * (CELL + 0.6);
        const r = el('rect', { width: CELL * 3.6, height: CELL, rx: 0.6, class: on ? 'bit on' : 'bit off' }, bitsG);
        this.bits.push({ el: r, tx, ty, sx: (rnd() - 0.5) * 900, sy: (rnd() - 0.5) * 600, delay: rnd() * 0.9 + i * 0.03 });
      }
    }
    this.g.addEventListener('pointerdown', (e) => this.down(e));
    this.g.addEventListener('pointermove', (e) => this.move(e));
    this.g.addEventListener('pointerup', (e) => this.up(e));
    this.g.addEventListener('pointercancel', (e) => this.up(e));
  }

  get done(): boolean {
    return this.state === 'gone';
  }

  /** Skip straight to the absorbed state (e.g. "Start" button or keyboard). */
  autoDrop(): void {
    if (this.state === 'gone' || this.state === 'absorbing' || this.state === 'snapping') return;
    this.state = 'snapping';
    this.vel = { x: 0, y: 0 };
  }

  private down(e: PointerEvent): void {
    if (this.state === 'gone' || this.state === 'absorbing') return;
    e.stopPropagation();
    this.g.setPointerCapture(e.pointerId);
    const p = this.scene.toScene(e.clientX, e.clientY);
    this.grab = { x: p.x - this.pos.x, y: p.y - this.pos.y };
    this.state = 'dragging';
    this.samples = [{ t: performance.now(), ...p }];
    this.g.classList.add('dragging');
  }

  private move(e: PointerEvent): void {
    if (this.state !== 'dragging') return;
    const p = this.scene.toScene(e.clientX, e.clientY);
    this.pos = { x: p.x - this.grab.x, y: p.y - this.grab.y };
    this.samples.push({ t: performance.now(), ...p });
    if (this.samples.length > 6) this.samples.shift();
  }

  private up(e: PointerEvent): void {
    if (this.state !== 'dragging') return;
    this.g.releasePointerCapture(e.pointerId);
    this.g.classList.remove('dragging');
    const a = this.samples[0]!;
    const b = this.samples[this.samples.length - 1]!;
    const dt = Math.max(0.016, (b.t - a.t) / 1000);
    this.vel = { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
    this.state = 'gliding';
  }

  private target(): { x: number; y: number } {
    return this.scene.deviceCenter(this.targetId);
  }

  update(dt: number): void {
    this.age += dt;
    const tgt = this.target();
    const dist = Math.hypot(this.pos.x - tgt.x, this.pos.y - tgt.y);
    switch (this.state) {
      case 'assembling': {
        let done = true;
        for (const b of this.bits) {
          const k = easeOut(clamp01((this.age - b.delay) / 0.9));
          if (k < 1) done = false;
          b.el.setAttribute('x', lerp(b.tx + b.sx, b.tx, k).toFixed(1));
          b.el.setAttribute('y', lerp(b.ty + b.sy, b.ty, k).toFixed(1));
          b.el.style.opacity = clamp01(k * 3).toFixed(2);
        }
        (this.body.firstElementChild as SVGElement).style.opacity = clamp01(this.age / 1.4).toFixed(2);
        if (done) this.state = 'idle';
        break;
      }
      case 'idle':
        break;
      case 'dragging':
        break;
      case 'gliding': {
        const R = this.scene.sceneBounds;
        const B = { x: R.x0, y: R.y0, w: R.x1 - R.x0, h: R.y1 - R.y0 };
        this.pos.x += this.vel.x * dt;
        this.pos.y += this.vel.y * dt;
        const fr = Math.pow(0.04, dt); // strong friction: ~4% of speed left after 1 s
        this.vel.x *= fr;
        this.vel.y *= fr;
        if (this.pos.x < B.x + W / 2 || this.pos.x > B.x + B.w - W / 2) {
          this.vel.x *= -0.6;
          this.pos.x = Math.max(B.x + W / 2, Math.min(B.x + B.w - W / 2, this.pos.x));
        }
        if (this.pos.y < B.y + H / 2 || this.pos.y > B.y + B.h - H / 2) {
          this.vel.y *= -0.6;
          this.pos.y = Math.max(B.y + H / 2, Math.min(B.y + B.h - H / 2, this.pos.y));
        }
        if (dist < 120) this.state = 'snapping';
        else if (Math.hypot(this.vel.x, this.vel.y) < 5) this.state = 'idle';
        break;
      }
      case 'snapping': {
        // Critically damped spring towards the laptop.
        const k = 140;
        const c = 2 * Math.sqrt(k);
        for (const axis of ['x', 'y'] as const) {
          const a = -k * (this.pos[axis] - tgt[axis]) - c * this.vel[axis];
          this.vel[axis] += a * dt;
          this.pos[axis] += this.vel[axis] * dt;
        }
        if (dist < 3 && Math.hypot(this.vel.x, this.vel.y) < 20) {
          this.state = 'absorbing';
          this.absorbT = 0;
        }
        break;
      }
      case 'absorbing': {
        this.absorbT += dt;
        const k = easeInOut(clamp01(this.absorbT / 0.55));
        this.body.setAttribute('transform', `scale(${(1 - 0.85 * k).toFixed(3)})`);
        this.g.style.opacity = (1 - k).toFixed(3);
        if (k >= 1) {
          this.state = 'gone';
          this.g.style.display = 'none';
          this.onDrop();
        }
        break;
      }
      case 'gone':
        return;
    }
    this.g.setAttribute('transform', `translate(${this.pos.x.toFixed(1)},${this.pos.y.toFixed(1)})`);
    this.g.classList.toggle('near', dist < 200 && this.state === 'dragging');
    // Hint arrow from the card to the laptop while idle.
    const showHint = this.state === 'idle';
    this.hint.style.display = showHint ? '' : 'none';
    if (showHint) {
      const sx = this.pos.x;
      const sy = this.pos.y + H / 2 + 6;
      const ex = tgt.x;
      const ey = tgt.y - 46;
      const pulse = 0.55 + 0.45 * Math.sin(this.age * 3);
      this.hint.querySelector('path')!.setAttribute('d', `M${sx} ${sy} Q${(sx + ex) / 2 + 40} ${(sy + ey) / 2} ${ex} ${ey}`);
      this.hint.style.opacity = pulse.toFixed(2);
      const t = this.hint.querySelector('text')!;
      t.setAttribute('x', ((sx + ex) / 2 + 70).toFixed(1));
      t.setAttribute('y', ((sy + ey) / 2).toFixed(1));
    }
  }

  destroy(): void {
    this.g.remove();
    this.hint.remove();
  }
}
