import { clamp01, easeIn, easeInOut, easeOut, easeOutBack, iso, isoV, ISO_X, ISO_Y, lerp, v3, type Pt, type Vec3 } from './project';
import { leaf, line, slab, tile } from './prims';
import { el } from './svg';
import type { Step } from './story';
import { lookupBeats } from './timeline';

/** What the servers do before they answer, as a pure drawing of progress k through the step. */

type Lookup = Extract<Step, { kind: 'lookup' }>;

/** The web server's tower, shared with its drawing in the scene. `slots`: the heights of its shelves. */
export const SERVER = { half: 0.8, height: 2.6, slotHalf: 0.55, slots: [2.25, 1.75, 1.25, 0.75] };
/** The books' covers, shared with the ones on the cabinets in the scene. */
export const BOOK = '#b0824f';
const PAPER = '#f8f1e4';

const ROWS = 6;
/** The row of the book that holds the name. */
const FOUND_ROW = 3;
const PAGE_W = 2.6;
const PAGE_D = 2.9;
/** How far the cover reaches past the pages. */
const COVER_OVER = 0.12;
/** Grey bars stand for lines nobody asked for: only what the real messages carry is ever readable. */
const BARS = [0.74, 0.58, 0.82, 0.66, 0.5, 0.78];

/** A rounded label that stays upright on screen. */
function pill(parent: SVGGElement, c: Pt, text: string, scale: number, op: number): void {
  const w = text.length * 7.2 + 18;
  const g = el('g', { class: 'lookup-pill', opacity: op.toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${scale.toFixed(3)})` }, parent);
  el('rect', { x: -w / 2, y: -12, width: w, height: 24, rx: 12 }, g);
  el('text', { 'text-anchor': 'middle', dy: '0.35em' }, g).textContent = text;
}

/** Text lying flat on a page, reading along +x. */
function flatText(parent: SVGGElement, p: Vec3, text: string, cls: string): void {
  const s = isoV(p);
  const t = el('text', { class: cls, dy: '0.35em', transform: `matrix(${ISO_X.toFixed(3)} ${ISO_Y.toFixed(3)} ${(-ISO_X).toFixed(3)} ${ISO_Y.toFixed(3)} ${s.sx.toFixed(1)} ${s.sy.toFixed(1)})` }, parent);
  t.textContent = text;
}

/** The resolver's book: it opens, pages turn, the question runs down the names, the line lights up, the address lifts off. */
export function drawBook(parent: SVGGElement, c: Vec3, top: Vec3, s: Lookup, k: number): void {
  const b = lookupBeats('dns');
  const opening = easeInOut(clamp01(k / b.open));
  const closing = easeInOut(clamp01((k - b.lift - 0.04) / (1 - b.lift - 0.04)));
  const g = el('g', { class: 'book', opacity: Math.min(clamp01(k / 0.04), 1 - easeIn(clamp01((k - 0.9) / 0.1))).toFixed(3) }, parent);
  const z = c.z + 0.5 * easeOut(clamp01(k / 0.1));
  const y0 = c.y - PAGE_D / 2;
  const rowY = (i: number): number => y0 + ((i + 0.8) / (ROWS + 0.6)) * PAGE_D;

  // Closed it is the right half alone, with the front cover lying on it; only flat open does it take up both sides.
  const leftAngle = Math.PI * (opening - closing);
  const flat = leftAngle > Math.PI * 0.98;
  const coverW = PAGE_W + COVER_OVER;
  const coverD = PAGE_D + COVER_OVER * 2;
  slab(g, { x: flat ? c.x - coverW : c.x, y: y0 - COVER_OVER, z: z - 0.24, w: flat ? coverW * 2 : coverW, d: coverD, h: 0.1, r: 0.14, color: BOOK });
  if (flat) slab(g, { x: c.x - PAGE_W, y: y0, z: z - 0.14, w: PAGE_W, d: PAGE_D, h: 0.14, r: 0.04, color: PAPER });
  slab(g, { x: c.x, y: y0, z: z - 0.14, w: PAGE_W, d: PAGE_D, h: 0.14, r: 0.04, color: PAPER });

  const lastFlip = b.search[b.search.length - 1]! + 0.1;
  const lit = clamp01((k - b.found) / 0.06);
  // Each turned page shows other lines; the last one is the page with the name on it.
  const turned = b.search.filter((f) => k >= f + 0.05).length;
  for (let i = 0; i < ROWS; i++) {
    const row = i === FOUND_ROW && k >= lastFlip;
    const y = rowY(i);
    if (row && flat) tile(g, c.x - PAGE_W + 0.15, y - 0.17, (PAGE_W - 0.15) * 2 * lit, 0.34, z, { class: 'book-lit' });
    if (flat && !row) tile(g, c.x - PAGE_W + 0.25, y - 0.05, (PAGE_W - 0.6) * BARS[(i + turned) % ROWS]!, 0.1, z, { class: 'book-bar' });
    if (!row) tile(g, c.x + 0.25, y - 0.05, (PAGE_W - 0.6) * BARS[(i + turned + 2) % ROWS]!, 0.1, z, { class: 'book-bar' });
  }
  if (flat && k >= lastFlip && k < b.lift + 0.1) {
    flatText(g, v3(c.x - PAGE_W + 0.3, rowY(FOUND_ROW), z), s.ask, 'book-name');
    if (k < b.lift) flatText(g, v3(c.x + 0.14, rowY(FOUND_ROW), z), s.found, 'book-name');
  }
  if (!flat) leaf(g, { x: c.x, y: y0 - COVER_OVER, z, w: coverW, d: coverD, t: 0.1, r: 0.14, angle: leftAngle, up: BOOK, under: PAPER });
  for (const f of b.search) {
    const q = clamp01((k - f) / 0.1);
    if (q > 0 && q < 1) leaf(g, { x: c.x, y: y0, z: z + 0.02, w: PAGE_W, d: PAGE_D, t: 0, r: 0.04, angle: Math.PI * easeInOut(q), up: PAPER, under: PAPER });
  }

  // The question runs down the names.
  if (k > 0.06 && k < b.found) {
    const run = easeInOut(clamp01((k - b.open) / (lastFlip - b.open)));
    const at = iso(c.x - PAGE_W / 2 - 0.2, lerp(rowY(0), rowY(FOUND_ROW), run), z + 0.35);
    const fade = clamp01((b.found - k) / 0.05);
    pill(parent, at, `${s.ask}?`, easeOutBack(clamp01((k - 0.06) / 0.08)), fade);
  }
  // The answer lifts off the page and rises to where the reply is made.
  if (k >= b.lift - 0.02) {
    const q = clamp01((k - b.lift + 0.02) / (1 - b.lift + 0.02));
    const from = iso(c.x + PAGE_W / 2, rowY(FOUND_ROW), z + 0.3);
    const to = isoV(top);
    pill(parent, { sx: lerp(from.sx, to.sx, easeInOut(q)), sy: lerp(from.sy, to.sy, easeInOut(q)) }, s.found, 1 + 0.12 * Math.sin(q * Math.PI), 1 - easeIn(clamp01((q - 0.82) / 0.18)));
  }
}

/** A flat sheet of paper standing up, facing the viewer's left, with the page's title on it. */
function sheet(parent: SVGGElement, c: Pt, title: string, scale: number, op: number): void {
  const w = Math.max(92, title.length * 6.4 + 20);
  const g = el('g', { class: 'web-sheet', opacity: op.toFixed(3), transform: `matrix(${(ISO_X * scale).toFixed(3)} ${(ISO_Y * scale).toFixed(3)} 0 ${scale.toFixed(3)} ${c.sx.toFixed(1)} ${c.sy.toFixed(1)})` }, parent);
  el('rect', { x: -w / 2, y: -34, width: w, height: 68, rx: 3 }, g);
  el('text', { 'text-anchor': 'middle', y: -16, dy: '0.35em' }, g).textContent = title;
  for (const [i, l] of [0.8, 0.62, 0.7].entries()) el('rect', { x: (-w * l) / 2, y: 0 + i * 9, width: w * l, height: 3, rx: 1.5, class: 'web-line' }, g);
}

/** The web server's shelves: the path tries one slot after another, the right drawer slides out, the page rises from it. */
export function drawShelf(parent: SVGGElement, c: Vec3, top: Vec3, s: Lookup, k: number): void {
  const b = lookupBeats('web');
  const SLOTS = SERVER.slots;
  const FOUND_SLOT = b.search.length;
  const front = c.y + SERVER.half;
  const tried = b.search.filter((f) => k >= f).length;
  const inFront = (z: number, out = 0): Pt => iso(c.x, front + out, z);

  const at = k >= b.found ? FOUND_SLOT : Math.max(0, tried - 1);
  const slotZ = SLOTS[at]!;
  const lit = iso(c.x - SERVER.slotHalf, front, slotZ);
  const end = iso(c.x + SERVER.slotHalf, front, slotZ);
  el('line', { x1: lit.sx, y1: lit.sy, x2: end.sx, y2: end.sy, class: k >= b.found ? 'slot-lit found' : 'slot-lit', opacity: clamp01(k / 0.08).toFixed(3) }, parent);

  const slide = easeOutBack(clamp01((k - b.found) / 0.1)) * (1 - easeInOut(clamp01((k - 0.88) / 0.12)));
  if (slide > 0.01) {
    const d = 1.5 * slide;
    slab(parent, { x: c.x - SERVER.slotHalf, y: front, z: slotZ - 0.17, w: SERVER.slotHalf * 2, d, h: 0.34, r: Math.min(0.08, d / 2), color: PAPER });
    line(parent, v3(c.x - 0.2, front + d, slotZ), v3(c.x + 0.2, front + d, slotZ), { class: 'dev-port' });
  }
  // The path, on its way down the slots and then on the drawer.
  if (k < b.lift) {
    const hop = clamp01((k - (k >= b.found ? b.found : (b.search[Math.max(0, tried - 1)] ?? 0))) / 0.08);
    const from = SLOTS[Math.max(0, at - 1)]!;
    const y = lerp(from, slotZ, easeInOut(hop));
    pill(parent, inFront(y + 0.15, 1.9), s.ask, easeOutBack(clamp01(k / 0.08)), clamp01((b.lift - k) / 0.05));
  }
  const rise = clamp01((k - b.found - 0.1) / (b.lift - b.found - 0.1));
  if (rise > 0) {
    const drawer = inFront(slotZ + 0.4, 0.8);
    const shelf = { sx: drawer.sx, sy: drawer.sy - 62 * easeOut(rise) };
    const q = clamp01((k - b.lift) / (1 - b.lift));
    const to = isoV(top);
    const pos = { sx: lerp(shelf.sx, to.sx, easeInOut(q)), sy: lerp(shelf.sy, to.sy, easeInOut(q)) };
    sheet(parent, pos, s.found, lerp(0.35 + 0.65 * easeOut(rise), 0.5, q), 1 - easeIn(clamp01((q - 0.8) / 0.2)));
  }
}
