import { el } from './svg';
import { rbox, tile } from './prims';

/** The things you handle, drawn from simple shapes around the origin, for the menus and the scene alike. */

/** A chunky gold lightning bolt with a thick side, standing over a stormy line. */
export function drawBolt(g: SVGGElement): void {
  const points = '8,-30 -16,4 -2,4 -10,30 18,-8 3,-8 13,-30';
  el('polygon', { points, class: 'iso-bolt-side', transform: 'translate(6 3)' }, g);
  el('polygon', { points, class: 'iso-bolt' }, g);
}

/** A pair of scissors. */
export function drawScissors(g: SVGGElement): void {
  // Thin shapes are hard to grab: a clear area around them makes the whole thing a handle.
  el('circle', { cx: 0, cy: 4, r: 36, class: 'grab-area' }, g);
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

/** A long page: the bigger page. */
export function drawPage(g: SVGGElement): void {
  el('path', { d: 'M-17 -27 H9 L19 -17 V27 H-17 Z', class: 'page-sheet' }, g);
  el('path', { d: 'M9 -27 V-17 H19', class: 'page-fold' }, g);
  for (let i = 0; i < 5; i++) el('line', { x1: -10, x2: i % 2 ? 6 : 12, y1: -8 + i * 8, y2: -8 + i * 8, class: 'page-line' }, g);
}
