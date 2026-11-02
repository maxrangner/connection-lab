import { el } from './svg';
import { line, slab, tiles } from './prims';
import { v3 } from './project';

/** The things you handle, drawn from simple shapes around the origin, for the menus and the scene alike. */

/** A pair of scissors. */
export function drawScissors(g: SVGGElement): void {
  for (const s of [-1, 1]) {
    el('line', { x1: s * 13, y1: 16, x2: -s * 7, y2: -26, class: 'scissor-blade' }, g);
    el('circle', { cx: s * 16, cy: 24, r: 8, class: 'scissor-grip' }, g);
  }
  el('circle', { cx: 0, cy: 0, r: 2.5, class: 'scissor-pin' }, g);
}

/** Two bars, to pause. */
export function drawPause(g: SVGGElement): void {
  for (const x of [-6.5, 2]) el('rect', { x, y: -8, width: 4.5, height: 16, rx: 1, fill: 'currentColor' }, g);
}

/** A triangle, to play. */
export function drawPlay(g: SVGGElement): void {
  el('path', { d: 'M-5.5 -8.5 L8 0 L-5.5 8.5 Z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, g);
}

/** The moon, for the dark theme. */
export function drawMoon(g: SVGGElement): void {
  el('path', { d: 'M4 -9 A9.5 9.5 0 1 0 9 5 A7.5 7.5 0 0 1 4 -9 Z', fill: 'currentColor' }, g);
}

/** The sun, for the light theme. */
export function drawSun(g: SVGGElement): void {
  el('circle', { r: 4.5, fill: 'currentColor' }, g);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    el('line', { x1: Math.cos(a) * 7, y1: Math.sin(a) * 7, x2: Math.cos(a) * 10, y2: Math.sin(a) * 10, stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }, g);
  }
}

/** A magnifying glass. */
export function drawSpyglass(g: SVGGElement): void {
  el('line', { x1: 13, y1: 13, x2: 30, y2: 30, class: 'spy-handle' }, g);
  el('circle', { cx: 0, cy: 0, r: 19, class: 'spy-lens' }, g);
  el('path', { d: 'M-11 -6 A12 12 0 0 1 -4 -12', class: 'spy-shine' }, g);
}

/** A small satellite, the same boxes and panels as a device. */
export function drawSatellite(g: SVGGElement): void {
  const wing = (x: number): void => {
    slab(g, { x, y: -0.4, z: -0.04, w: 1, d: 0.8, h: 0.08, r: 0.06, color: '#2f3f5a' });
    tiles(g, Array.from({ length: 6 }, (_, i) => ({ x: x + 0.06 + (i % 3) * 0.3, y: -0.34 + Math.floor(i / 3) * 0.35, w: 0.28, d: 0.33 })), 0.04, { class: 'dev-cell' });
  };
  // Back to front, so the body hides the far arm and the near wing lies over nothing.
  wing(-1.75);
  line(g, v3(-0.75, 0, 0), v3(-0.42, 0, 0), { class: 'dev-arm' });
  slab(g, { x: -0.42, y: -0.42, z: -0.38, w: 0.84, d: 0.84, h: 0.76, r: 0.12, color: '#f2ebdd' });
  slab(g, { x: -0.1, y: -0.1, z: 0.38, w: 0.2, d: 0.2, h: 0.12, r: 0.1, color: '#f2ebdd' });
  slab(g, { x: -0.3, y: -0.3, z: 0.5, w: 0.6, d: 0.6, h: 0.06, r: 0.3, color: '#5b8ec4' });
  line(g, v3(0.42, 0, 0), v3(0.75, 0, 0), { class: 'dev-arm' });
  wing(0.75);
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

/** A speech bubble struck through: the devices keep quiet. */
export function drawTalk(g: SVGGElement): void {
  el('path', { d: 'M-7 -9 H7 a3 3 0 0 1 3 3 V3 a3 3 0 0 1 -3 3 H-1 L-5 10 V6 H-7 a3 3 0 0 1 -3 -3 V-6 a3 3 0 0 1 3 -3 Z', class: 'bar-talk' }, g);
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

/** A thermometer: the sensor of a smart home. */
export function drawThermometer(g: SVGGElement): void {
  el('path', { d: 'M-6 8 V-20 A6 6 0 0 1 6 -20 V8 A12 12 0 1 1 -6 8 Z', class: 'ear-line' }, g);
  el('circle', { cx: 0, cy: 18, r: 6, class: 'ping-dot' }, g);
  el('path', { d: 'M0 18 V-10', class: 'ear-line' }, g);
}

/** An ear: the stranger, listening. */
export function drawEar(g: SVGGElement): void {
  el('path', { d: 'M-14 6 C-20 -24 22 -30 18 -2 C16 10 2 8 2 20 C2 28 -10 28 -12 18', class: 'ear-line' }, g);
  el('path', { d: 'M-4 -4 C-2 -14 10 -12 8 -2', class: 'ear-line' }, g);
}

/** Many small machines at once: a botnet. */
export function drawSwarm(g: SVGGElement): void {
  for (const [x, y] of [[-16, -14], [10, -18], [-4, 4], [18, 8], [-20, 16]] as const) el('rect', { x: x - 6, y: y - 6, width: 12, height: 12, rx: 2, class: 'swarm-bot' }, g);
}

/** A door ajar, with light in it: a port. */
export function drawDoor(g: SVGGElement): void {
  el('path', { d: 'M-14 26 V-24 H14 V26', class: 'ear-line' }, g);
  el('path', { d: 'M-14 -24 L6 -16 V26 L-14 26 Z', class: 'ear-line' }, g);
  el('circle', { cx: 0, cy: 4, r: 2.5, class: 'swarm-bot' }, g);
}

/** A long page: the bigger page. */
/** A globe, for a site. */
export function drawGlobe(g: SVGGElement): void {
  el('circle', { r: 9 }, g);
  el('ellipse', { rx: 4, ry: 9 }, g);
}

/** A little picture, for a photo. */
export function drawPhoto(g: SVGGElement): void {
  el('rect', { x: -12, y: -10, width: 24, height: 20, rx: 2 }, g);
  el('path', { d: 'M-10 7l7-8 5 5 3-3 5 6' }, g);
}

export function drawPage(g: SVGGElement): void {
  el('path', { d: 'M-17 -27 H9 L19 -17 V27 H-17 Z', class: 'page-sheet' }, g);
  el('path', { d: 'M9 -27 V-17 H19', class: 'page-fold' }, g);
  for (let i = 0; i < 5; i++) el('line', { x1: -10, x2: i % 2 ? 6 : 12, y1: -8 + i * 8, y2: -8 + i * 8, class: 'page-line' }, g);
}
