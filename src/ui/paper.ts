import { clamp01, easeIn, easeInOut, ISO_X, ISO_Y, lerp, type Pt } from './project';
import { el } from './svg';

/** A sheet of paper standing beside the device, filling up as the parts of what was asked for arrive. */

export const PAPER_W = 156;
export const PAPER_H = 116;
/** Bands thinner than this have no room for a torn edge or their number. */
const NUMBERED = 18;
const TEETH = 9;

export interface Parts {
  of: number;
  /** When each part landed (visual time), by number. */
  filled: Map<number, number>;
  /** When the first part set off. */
  shownFrom: number;
  /** When the last part landed, if they all did. */
  complete: number;
}

type Content = (g: SVGGElement, w: number, h: number) => void;

/** The middle of band n (1-based), where its part flies in. */
export function bandPoint(c: Pt, n: number, of: number): Pt {
  return { sx: c.sx, sy: c.sy + ((n - 0.5) / of - 0.5) * PAPER_H };
}

/** The edge of a tear from left to right at height y: a row of teeth. */
function tear(y: number, depth: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= TEETH; i++) pts.push(`${((i / TEETH - 0.5) * PAPER_W).toFixed(1)} ${(y + (i % 2 ? depth : -depth)).toFixed(1)}`);
  return pts.join('L');
}

/**
 * The whole sheet is drawn and the parts still missing cover it, so a gap shows exactly what has not come yet.
 * Once it is complete the sheet slides into the screen. It stays in the page between frames: only its place and the
 * gaps change as a run goes on.
 */
export class Paper {
  private readonly g: SVGGElement;
  private readonly content: SVGGElement;
  private readonly gaps: SVGGElement;
  /** The gaps as last drawn, to leave them alone when nothing changed. */
  private drawn = '';

  constructor(parent: SVGGElement) {
    this.g = el('g', { class: 'paper' }, parent);
    el('rect', { x: -PAPER_W / 2, y: -PAPER_H / 2, width: PAPER_W, height: PAPER_H, rx: 3, class: 'paper-sheet' }, this.g);
    this.content = el('g', {}, this.g);
    this.gaps = el('g', {}, this.g);
    this.g.style.display = 'none';
  }

  setContent(content: Content): void {
    this.content.replaceChildren();
    content(this.content, PAPER_W, PAPER_H);
  }

  /** The sheet at c, or sliding from c into the screen at `to`; no parts, or out of its time: not there. */
  draw(c: Pt, to: Pt, parts: Parts | null, v: number): void {
    const gone = parts ? clamp01((v - parts.complete - 0.3) / 0.5) : 1;
    if (!parts || v < parts.shownFrom || gone >= 1) {
      this.g.style.display = 'none';
      return;
    }
    this.g.style.display = '';
    const landed = [...parts.filled.values()].filter((at) => v >= at);
    const bump = Math.max(0, ...landed.map((at) => (v - at < 0.25 ? Math.sin(((v - at) / 0.25) * Math.PI) : 0)));
    const slide = easeInOut(gone);
    const s = lerp(1, 0.3, slide) * (1 + 0.04 * bump);
    const at = { sx: lerp(c.sx, to.sx, slide), sy: lerp(c.sy, to.sy, slide) };
    const op = clamp01((v - parts.shownFrom) / 0.4) * (1 - easeIn(clamp01((gone - 0.7) / 0.3)));
    this.g.setAttribute('opacity', op.toFixed(3));
    this.g.setAttribute('transform', `matrix(${(ISO_X * s).toFixed(3)} ${(ISO_Y * s).toFixed(3)} 0 ${s.toFixed(3)} ${at.sx.toFixed(1)} ${at.sy.toFixed(1)})`);
    this.drawGaps(parts, v);
  }

  private drawGaps(parts: Parts, v: number): void {
    const open = Array.from({ length: parts.of }, (_, i) => (1 - clamp01((v - (parts.filled.get(i + 1) ?? Infinity)) / 0.2)).toFixed(3));
    const state = open.join();
    if (state === this.drawn) return;
    this.drawn = state;
    this.gaps.replaceChildren();
    const band = PAPER_H / parts.of;
    open.forEach((op, i) => {
      if (Number(op) <= 0) return;
      const n = i + 1;
      const y0 = -PAPER_H / 2 + i * band;
      const y1 = y0 + band;
      // A thin strip has no room for a tear: it is simply not there yet.
      if (band < NUMBERED) {
        el('rect', { x: -PAPER_W / 2, y: y0, width: PAPER_W, height: band + 0.4, class: 'paper-strip', opacity: op }, this.gaps);
        return;
      }
      // The sheet's own edges stay straight; only an inner edge is torn.
      const depth = Math.min(2.5, band / 5);
      const top = n === 1 ? `${-PAPER_W / 2} ${y0}L${PAPER_W / 2} ${y0}` : tear(y0, depth);
      const bottom = n === parts.of ? `${-PAPER_W / 2} ${y1}L${PAPER_W / 2} ${y1}` : tear(y1, depth);
      const back = bottom.split('L').reverse().join('L');
      el('path', { d: `M${top}L${back}Z`, class: 'paper-gap', opacity: op }, this.gaps);
      const t = el('text', { y: (y0 + y1) / 2, 'text-anchor': 'middle', dy: '0.35em', class: 'paper-num', opacity: op }, this.gaps);
      t.textContent = String(n);
    });
  }
}

/** A picture: the real one, kept once in the scene's `defs`. */
export const photoContent =
  (id: string): Content =>
  (g, w, h) => {
    el('use', { href: `#${id}`, x: -w / 2, y: -h / 2 }, g);
  };

/**
 * A voice: what was heard, one band per packet from the top down, each drawn as its real samples swinging left and
 * right of the middle, so a loud packet is wide and a lost one leaves its band empty. `heard` holds the µ-law bytes
 * of each packet, or null for one that never came; `decode` turns a byte into a 16-bit sample.
 */
export const voiceContent =
  (heard: (Uint8Array | null)[], decode: (b: number) => number): Content =>
  (g, w, h) => {
    const band = h / heard.length;
    const parts: string[] = [];
    heard.forEach((bytes, i) => {
      if (!bytes) return;
      const y0 = -h / 2 + i * band;
      for (let k = 0; k < bytes.length; k++) {
        const x = (decode(bytes[k]!) / 32768) * (w / 2 - 6);
        parts.push(`${k ? 'L' : 'M'}${x.toFixed(1)} ${(y0 + ((k + 0.5) / bytes.length) * band).toFixed(2)}`);
      }
    });
    el('path', { d: parts.join(''), class: 'paper-voice' }, g);
  };

/** A page: its real title and grey bars for the rest of it. */
export const pageContent =
  (title: string): Content =>
  (g, w, h) => {
    const t = el('text', { y: -h / 2 + 18, 'text-anchor': 'middle', dy: '0.35em', class: 'paper-title' }, g);
    t.textContent = title;
    for (const [i, l] of [0.82, 0.66, 0.76, 0.58, 0.7, 0.8, 0.5].entries()) {
      el('rect', { x: (-w * l) / 2, y: -h / 2 + 34 + i * 8.5, width: w * l, height: 3.2, rx: 1.6, class: 'paper-line' }, g);
    }
  };
