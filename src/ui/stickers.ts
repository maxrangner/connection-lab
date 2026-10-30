import { el } from './svg';
import { lerp } from './project';

/**
 * The start-screen configurator: round stickers on a sheet beside the site card. Drag one onto the card (or tap
 * it) to switch that feature on; drag it off the card (or tap it there) to switch it off again.
 */

export type Feature = 'https' | 'big' | 'again' | 'slow';
export type Features = Record<Feature, boolean>;

const DEFS: { id: Feature; label: string; color: string }[] = [
  { id: 'https', label: 'Secure', color: '#3d4654' },
  { id: 'big', label: 'Bigger page', color: '#3d7ea6' },
  { id: 'again', label: 'Visit again', color: '#5f8a2e' },
  { id: 'slow', label: 'Satellite', color: '#7a5aa6' },
];

interface Sticker {
  id: Feature;
  g: SVGGElement;
  label: SVGTextElement;
  pos: { sx: number; sy: number };
  /** Wall-clock seconds since it last snapped onto the card (for the bounce). */
  since: number;
  drag: { dx: number; dy: number; moved: boolean; x0: number; y0: number } | null;
}

/** Icons drawn from simple shapes, centred on 0,0, about 24 px across. */
function icon(g: SVGGElement, id: Feature, color: string): void {
  if (id === 'https') {
    // A padlock: shackle and body with a keyhole.
    el('path', { d: 'M-5 -2 V-6 A5 5 0 0 1 5 -6 V-2', fill: 'none', stroke: color, 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
    el('rect', { x: -8, y: -2, width: 16, height: 13, rx: 2.5, fill: color }, g);
    el('circle', { cx: 0, cy: 3.5, r: 1.8, fill: '#fff' }, g);
    el('rect', { x: -0.8, y: 4, width: 1.6, height: 4, fill: '#fff' }, g);
  } else if (id === 'big') {
    // A tall page with a folded corner and lines of text.
    el('path', { d: 'M-8 -12 H4 L9 -7 V12 H-8 Z', fill: '#fff', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, g);
    el('path', { d: 'M4 -12 V-7 H9', fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, g);
    for (let i = 0; i < 4; i++) el('line', { x1: -5, x2: i % 2 ? 3 : 6, y1: -3 + i * 4, y2: -3 + i * 4, stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, g);
  } else if (id === 'slow') {
    // A little satellite: a body with a solar panel either side.
    el('rect', { x: -4, y: -4, width: 8, height: 8, rx: 1.5, fill: '#fff', stroke: color, 'stroke-width': 2 }, g);
    for (const s of [-1, 1]) el('rect', { x: s < 0 ? -13 : 6, y: -3.5, width: 7, height: 7, fill: color, stroke: color, 'stroke-width': 1 }, g);
    el('path', { d: 'M3 -6 Q8 -11 12 -8', fill: 'none', stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round' }, g);
  } else {
    // A circular arrow: around once more.
    el('path', { d: 'M9 -3 A9.5 9.5 0 1 0 6 7', fill: 'none', stroke: color, 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
    el('path', { d: 'M3 -6 L10 -4 L10 -11 Z', fill: color, stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, g);
  }
}

export class Stickers {
  readonly features: Features;
  private readonly stickers: Sticker[] = [];
  private readonly root: SVGGElement;

  constructor(
    private readonly svg: SVGSVGElement,
    initial: Partial<Features>,
    private readonly onChange: (f: Features) => void,
  ) {
    this.features = { https: false, big: false, again: false, slow: false, ...initial };
    this.root = el('g', { class: 'stickers' }, svg);
    for (const d of DEFS) {
      const g = el('g', { class: 'sticker' }, this.root);
      const body = el('g', { class: 'sticker-body' }, g);
      el('circle', { r: 24, class: 'sticker-bg', stroke: d.color }, body);
      icon(body, d.id, d.color);
      const label = el('text', { y: 40, 'text-anchor': 'middle', class: 'sticker-label' }, g);
      label.textContent = d.label;
      const s: Sticker = { id: d.id, g, label, pos: { sx: 0, sy: 0 }, since: 9, drag: null };
      this.stickers.push(s);
      g.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        const p = this.toSvg(e);
        s.drag = { dx: s.pos.sx - p.sx, dy: s.pos.sy - p.sy, moved: false, x0: e.clientX, y0: e.clientY };
        g.setPointerCapture(e.pointerId);
        g.classList.add('held');
      });
      g.addEventListener('pointermove', (e) => {
        if (!s.drag) return;
        if (Math.hypot(e.clientX - s.drag.x0, e.clientY - s.drag.y0) > 6) s.drag.moved = true;
        const p = this.toSvg(e);
        s.pos = { sx: p.sx + s.drag.dx, sy: p.sy + s.drag.dy };
      });
      g.addEventListener('pointerup', () => {
        if (!s.drag) return;
        const tapped = !s.drag.moved;
        s.drag = null;
        g.classList.remove('held');
        // A tap flips it; a drag counts where it was let go: on the card means on.
        const on = tapped ? !this.features[s.id] : Math.hypot(s.pos.sx - this.card.sx, s.pos.sy - this.card.sy) < 110;
        if (on !== this.features[s.id]) {
          this.features[s.id] = on;
          if (on) s.since = 0;
          this.onChange({ ...this.features });
        }
      });
    }
  }

  private card = { sx: 0, sy: 0 };

  set(f: Feature, on: boolean): void {
    if (this.features[f] === on) return;
    this.features[f] = on;
    if (on) {
      const s = this.stickers.find((x) => x.id === f);
      if (s) s.since = 0;
    }
    this.onChange({ ...this.features });
  }

  private toSvg(e: PointerEvent): { sx: number; sy: number } {
    const m = this.svg.getScreenCTM();
    if (!m) return { sx: 0, sy: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { sx: p.x, sy: p.y };
  }

  /**
   * Places the stickers for this frame. `home` is the card's resting point (the sheet sits above it), `card` where
   * the card is now, and `cardScale`/`cardOpacity` let stickers on the card shrink into the laptop with it.
   */
  update(dt: number, home: { sx: number; sy: number }, card: { sx: number; sy: number }, cardScale: number, cardOpacity: number, show: boolean): void {
    this.card = card;
    this.root.style.display = show ? '' : 'none';
    let onCard = 0;
    this.stickers.forEach((s, i) => {
      const on = this.features[s.id];
      s.since += dt;
      let target: { sx: number; sy: number };
      let scale: number;
      if (on) {
        // Stuck along the card's top edge, slightly askew like real stickers.
        target = { sx: card.sx + (34 + onCard * 30) * cardScale, sy: card.sy - 22 * cardScale };
        scale = 0.6 * cardScale;
        onCard++;
      } else {
        target = { sx: home.sx + (i - (DEFS.length - 1) / 2) * 76, sy: home.sy - 96 };
        scale = 1;
      }
      if (!s.drag) {
        const ease = Math.min(1, dt * 14);
        s.pos = { sx: lerp(s.pos.sx, target.sx, ease), sy: lerp(s.pos.sy, target.sy, ease) };
      }
      if (s.drag) scale = 1.12;
      // Snap-on bounce.
      if (on && !s.drag && s.since < 0.5) scale *= 1 + 0.35 * Math.sin((s.since / 0.5) * Math.PI) * (1 - s.since / 0.5);
      const tilt = on ? ([-10, 6, -4, 8][i] ?? 0) : 0;
      s.g.setAttribute('transform', `translate(${s.pos.sx.toFixed(1)} ${s.pos.sy.toFixed(1)}) rotate(${tilt}) scale(${scale.toFixed(3)})`);
      s.g.setAttribute('opacity', (on ? cardOpacity : 1).toFixed(3));
      s.label.style.display = on || s.drag ? 'none' : '';
    });
  }
}
