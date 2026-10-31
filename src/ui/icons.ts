import { el } from './svg';
import { rbox, tile } from './prims';

/** The things you handle, drawn from simple shapes around the origin, for the menus and the scene alike. */

/** A pair of scissors. */
export function drawScissors(g: SVGGElement): void {
  for (const s of [-1, 1]) {
    el('line', { x1: s * 13, y1: 16, x2: -s * 7, y2: -26, class: 'scissor-blade' }, g);
    el('circle', { cx: s * 16, cy: 24, r: 8, class: 'scissor-grip' }, g);
  }
  el('circle', { cx: 0, cy: 0, r: 2.5, class: 'scissor-pin' }, g);
}

/** A magnifying glass. */
export function drawSpyglass(g: SVGGElement): void {
  el('line', { x1: 13, y1: 13, x2: 30, y2: 30, class: 'spy-handle' }, g);
  el('circle', { cx: 0, cy: 0, r: 19, class: 'spy-lens' }, g);
  el('path', { d: 'M-11 -6 A12 12 0 0 1 -4 -12', class: 'spy-shine' }, g);
}

/** A small satellite, the same boxes and panels as a device. */
export function drawSatellite(g: SVGGElement): void {
  rbox(g, { cx: 0, cy: 0, z: -0.35, len: 0.7, wid: 0.7, h: 0.7, angle: 0, color: '#cfc6b8' });
  for (const s of [-1, 1]) tile(g, -0.45 + s * 1.15, -0.35, 0.9, 0.7, 0, { class: 'panel' });
}

/** A shield with a keyhole: the VPN. */
export function drawShield(g: SVGGElement): void {
  el('path', { d: 'M0 -26 L22 -18 V2 C22 16 10 24 0 29 C-10 24 -22 16 -22 2 V-18 Z', class: 'shield' }, g);
  el('circle', { cx: 0, cy: -4, r: 5, class: 'shield-hole' }, g);
  el('rect', { x: -2, y: -4, width: 4, height: 13, class: 'shield-hole' }, g);
}

/** A padlock: HTTPS. */
export function drawPadlock(g: SVGGElement): void {
  el('path', { d: 'M-11 -2 V-13 A11 11 0 0 1 11 -13 V-2', class: 'padlock-shackle' }, g);
  el('rect', { x: -17, y: -3, width: 34, height: 27, rx: 5, class: 'padlock-body' }, g);
  el('circle', { cx: 0, cy: 8, r: 4, class: 'padlock-hole' }, g);
  el('rect', { x: -1.6, y: 8, width: 3.2, height: 9, class: 'padlock-hole' }, g);
}

/** A speech bubble with a question in it: the ARP "who has…?" shouted on the cable. */
export function drawQuestion(g: SVGGElement): void {
  el('path', { d: 'M-22 -24 H22 V10 H-4 L-14 22 V10 H-22 Z', class: 'bubble' }, g);
  el('text', { x: 0, y: -6, dy: '0.35em', 'text-anchor': 'middle', class: 'bubble-text' }, g).textContent = '?';
}

/** Two cards, one behind the other: two devices fetching at once. */
export function drawPair(g: SVGGElement): void {
  el('rect', { x: -10, y: -24, width: 30, height: 20, rx: 5, class: 'pair-card pair-back' }, g);
  el('rect', { x: -22, y: -8, width: 30, height: 20, rx: 5, class: 'pair-card' }, g);
  el('circle', { cx: -14, cy: 2, r: 4, class: 'pair-dot' }, g);
}

/** An address tag with nothing written on it yet: the device that has to ask for an address first. */
export function drawTag(g: SVGGElement): void {
  el('path', { d: 'M-24 -14 H10 L24 0 L10 14 H-24 Z', class: 'tag' }, g);
  el('circle', { cx: 12, cy: 0, r: 3, class: 'tag-hole' }, g);
  for (let i = 0; i < 3; i++) el('line', { x1: -17 + i * 10, x2: -11 + i * 10, y1: 0, y2: 0, class: 'tag-dash' }, g);
}

/** A snowflake: the cold resolver, with nothing in its cache. */
export function drawSnowflake(g: SVGGElement): void {
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3;
    const dx = Math.cos(a) * 24;
    const dy = Math.sin(a) * 24;
    el('line', { x1: -dx, y1: -dy, x2: dx, y2: dy, class: 'flake' }, g);
    for (const s of [-1, 1]) {
      for (const t of [0.55, -0.55]) {
        const px = dx * t;
        const py = dy * t;
        const b = a + (s * Math.PI) / 3;
        el('line', { x1: px, y1: py, x2: px + Math.cos(b) * 7 * Math.sign(t), y2: py + Math.sin(b) * 7 * Math.sign(t), class: 'flake' }, g);
      }
    }
  }
}

/** A telephone handset: the call. */
export function drawHandset(g: SVGGElement): void {
  el('path', { d: 'M-22 -14 C-22 -24 -14 -26 -8 -20 L-2 -12 C2 -8 0 -4 -4 0 C0 8 8 16 16 20 C20 16 24 14 28 18 L34 24 C38 30 36 38 26 38 C0 38 -22 14 -22 -14 Z', class: 'handset' }, g);
}

/** A pipe that narrows: the thin line to the ISP. */
export function drawPipe(g: SVGGElement): void {
  el('path', { d: 'M-26 -16 H-8 L8 -6 H26 M-26 16 H-8 L8 6 H26', class: 'pipe' }, g);
  el('rect', { x: -28, y: -20, width: 6, height: 40, rx: 2, class: 'pipe-end' }, g);
  el('rect', { x: 22, y: -10, width: 6, height: 20, rx: 2, class: 'pipe-end' }, g);
}

/** A ping: a dot and the rings it sends out. */
export function drawPing(g: SVGGElement): void {
  el('circle', { cx: -8, cy: 0, r: 5, class: 'ping-dot' }, g);
  for (const r of [14, 24]) el('path', { d: `M${-8 + r * 0.5} ${-r * 0.87} A${r} ${r} 0 0 1 ${-8 + r * 0.5} ${r * 0.87}`, class: 'ping-ring' }, g);
}

/** A trace of the path: hops joined by a line. */
export function drawTrace(g: SVGGElement): void {
  el('path', { d: 'M-24 14 L-8 -6 L8 8 L24 -14', class: 'trace-line' }, g);
  for (const [x, y] of [[-24, 14], [-8, -6], [8, 8], [24, -14]] as const) el('circle', { cx: x, cy: y, r: 4.5, class: 'trace-hop' }, g);
}

/** A long page: the bigger page. */
export function drawPage(g: SVGGElement): void {
  el('path', { d: 'M-17 -27 H9 L19 -17 V27 H-17 Z', class: 'page-sheet' }, g);
  el('path', { d: 'M9 -27 V-17 H19', class: 'page-fold' }, g);
  for (let i = 0; i < 5; i++) el('line', { x1: -10, x2: i % 2 ? 6 : 12, y1: -8 + i * 8, y2: -8 + i * 8, class: 'page-line' }, g);
}
