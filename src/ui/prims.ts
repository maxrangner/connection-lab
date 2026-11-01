import { el } from './svg';
import { iso, U, type Pt, type Vec3 } from './project';
import { FACE, shade } from './shade';

export interface BoxSpec {
  x: number;
  y: number;
  z: number;
  w: number; // along +x
  d: number; // along +y
  h: number; // along +z
  color: string;
  cls?: string;
  /** Face lightness overrides. */
  faces?: Partial<typeof FACE>;
}

export interface BoxEl {
  g: SVGGElement;
  top: SVGPathElement;
  left: SVGPathElement;
  right: SVGPathElement;
}

const P = (x: number, y: number, z: number): string => {
  const p = iso(x, y, z);
  return `${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`;
};

/** Three visible faces of a cuboid: top, +y ("left") and +x ("right"). */
export function box(parent: Element | null, s: BoxSpec): BoxEl {
  const { x, y, z, w, d, h } = s;
  const f = { ...FACE, ...s.faces };
  const g = el('g', { class: `ibox ${s.cls ?? ''}` });
  const top = el('path', { d: `M${P(x, y, z + h)}L${P(x + w, y, z + h)}L${P(x + w, y + d, z + h)}L${P(x, y + d, z + h)}Z`, fill: shade(s.color, f.top), class: 'f-top' }, g);
  const left = el('path', { d: `M${P(x, y + d, z + h)}L${P(x + w, y + d, z + h)}L${P(x + w, y + d, z)}L${P(x, y + d, z)}Z`, fill: shade(s.color, f.left), class: 'f-left' }, g);
  const right = el('path', { d: `M${P(x + w, y, z + h)}L${P(x + w, y + d, z + h)}L${P(x + w, y + d, z)}L${P(x + w, y, z)}Z`, fill: shade(s.color, f.right), class: 'f-right' }, g);
  if (parent) parent.appendChild(g);
  return { g, top, left, right };
}

export interface RBoxSpec {
  /** Centre of the footprint and bottom height. */
  cx: number;
  cy: number;
  z: number;
  /** Length along `angle`, width across it, height. */
  len: number;
  wid: number;
  h: number;
  /** Radians from +x towards +y. */
  angle: number;
  color: string;
}

/**
 * A box turned by any angle about the vertical axis. Draws the sides that face the viewer (normal towards +x+y),
 * shaded by how much they face +x or +y, then the top.
 */
export function rbox(parent: Element | null, s: RBoxSpec): SVGGElement {
  const g = el('g', { class: 'ibox' });
  const d = { x: Math.cos(s.angle), y: Math.sin(s.angle) };
  const p = { x: -d.y, y: d.x };
  const corner = (a: number, b: number, z: number): string => P(s.cx + d.x * a + p.x * b, s.cy + d.y * a + p.y * b, z);
  const L = s.len / 2;
  const W = s.wid / 2;
  const top = s.z + s.h;
  // Each side: its outward normal and its two bottom corners (in along/across coordinates).
  const sides: [{ x: number; y: number }, [number, number], [number, number]][] = [
    [d, [L, -W], [L, W]],
    [{ x: -d.x, y: -d.y }, [-L, W], [-L, -W]],
    [p, [L, W], [-L, W]],
    [{ x: -p.x, y: -p.y }, [-L, -W], [L, -W]],
  ];
  for (const [n, a, b] of sides) {
    if (n.x + n.y <= 1e-6) continue;
    const k = FACE.left * Math.max(0, n.y) ** 2 + FACE.right * Math.max(0, n.x) ** 2;
    el('path', { d: `M${corner(a[0], a[1], s.z)}L${corner(b[0], b[1], s.z)}L${corner(b[0], b[1], top)}L${corner(a[0], a[1], top)}Z`, fill: shade(s.color, k) }, g);
  }
  el('path', { d: `M${corner(L, -W, top)}L${corner(L, W, top)}L${corner(-L, W, top)}L${corner(-L, -W, top)}Z`, fill: shade(s.color, FACE.top) }, g);
  if (parent) parent.appendChild(g);
  return g;
}

/** The points around a rectangle of this size with rounded corners, its corner at the origin, going round one way. */
function roundedRect(w: number, h: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  const steps = Math.max(5, Math.ceil(r * 12));
  const corners: [number, number, number][] = [
    [w - r, r, -90],
    [w - r, h - r, 0],
    [r, h - r, 90],
    [r, r, 180],
  ];
  for (const [cx, cy, from] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = ((from + (i * 90) / steps) * Math.PI) / 180;
      const p: [number, number] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      // All corner, as a disc is: two corners meet at one point.
      const last = out[out.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) out.push(p);
    }
  }
  return out;
}

/** How the sides of a rounded thing fall off: gentler than a box's, the outline does the rest. */
const ROUNDED = { left: 0.92, right: 0.76 };

const pathOf = (pts: Pt[]): string => `M${pts.map((p) => `${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`).join('L')}Z`;

/** The outline around these points. */
function hull(pts: Pt[]): Pt[] {
  const sorted = [...pts].sort((a, b) => a.sx - b.sx || a.sy - b.sy);
  const half = (list: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (const p of list) {
      while (out.length >= 2) {
        const [a, b] = [out[out.length - 2]!, out[out.length - 1]!];
        if ((b.sx - a.sx) * (p.sy - a.sy) - (b.sy - a.sy) * (p.sx - a.sx) > 0) break;
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/** The bold outline around a whole shape, with a thin light rim outside it that keeps it off a dark table. */
function outline(parent: Element, pts: Pt[]): void {
  const d = pathOf(hull(pts));
  el('path', { d, class: 'dev-rim' }, parent);
  el('path', { d, class: 'dev-line' }, parent);
}

/** Lying flat: a slab with rounded corners, sides shaded by how they face, and a bold outline. */
export function slab(parent: Element, s: { x: number; y: number; z: number; w: number; d: number; h: number; r: number; color: string }): void {
  const foot = roundedRect(s.w, s.d, s.r).map(([a, b]) => ({ x: s.x + a, y: s.y + b }));
  const [mx, my] = [s.x + s.w / 2, s.y + s.d / 2];
  foot.forEach((a, i) => {
    const b = foot[(i + 1) % foot.length]!;
    const flip = (b.y - a.y) * ((a.x + b.x) / 2 - mx) - (b.x - a.x) * ((a.y + b.y) / 2 - my) < 0 ? -1 : 1;
    const n = { x: (flip * (b.y - a.y)) / Math.hypot(b.x - a.x, b.y - a.y), y: (flip * (a.x - b.x)) / Math.hypot(b.x - a.x, b.y - a.y) };
    if (n.x + n.y <= 0) return;
    const color = shade(s.color, ROUNDED.left * Math.max(0, n.y) ** 2 + ROUNDED.right * Math.max(0, n.x) ** 2);
    el('path', { d: pathOf([iso(a.x, a.y, s.z + s.h), iso(b.x, b.y, s.z + s.h), iso(b.x, b.y, s.z), iso(a.x, a.y, s.z)]), fill: color, stroke: color, 'stroke-width': 0.7 }, parent);
  });
  const top = foot.map((p) => iso(p.x, p.y, s.z + s.h));
  el('path', { d: pathOf(top), fill: shade(s.color, FACE.top) }, parent);
  outline(parent, [...top, ...foot.map((p) => iso(p.x, p.y, s.z))]);
}

/**
 * Standing up, its face towards +y and leaning back by `lean` radians from its foot at (y, z): a panel with rounded corners
 * and a bold outline, `h` long up the lean, `t` thick behind the face.
 */
export function panel(parent: Element, s: { x: number; y: number; z: number; w: number; h: number; t: number; r: number; lean: number; color: string }): void {
  const [sin, cos] = [Math.sin(s.lean), Math.cos(s.lean)];
  const on = (a: number, b: number, behind: number): Pt => iso(s.x + a, s.y - b * sin - behind * cos, s.z + b * cos - behind * sin);
  const edge = roundedRect(s.w, s.h, s.r);
  edge.forEach(([ax, ab], i) => {
    const [bx, bb] = edge[(i + 1) % edge.length]!;
    const flip = (bb - ab) * ((ax + bx) / 2 - s.w / 2) - (bx - ax) * ((ab + bb) / 2 - s.h / 2) < 0 ? -1 : 1;
    const n = { x: (flip * (bb - ab)) / Math.hypot(bx - ax, bb - ab), up: (flip * (ax - bx)) / Math.hypot(bx - ax, bb - ab) };
    if (n.x + n.up <= 0) return;
    const color = shade(s.color, FACE.top * Math.max(0, n.up) ** 2 + ROUNDED.right * Math.max(0, n.x) ** 2);
    el('path', { d: pathOf([on(ax, ab, 0), on(bx, bb, 0), on(bx, bb, s.t), on(ax, ab, s.t)]), fill: color, stroke: color, 'stroke-width': 0.7 }, parent);
  });
  const face = edge.map(([a, b]) => on(a, b, 0));
  el('path', { d: pathOf(face), fill: shade(s.color, ROUNDED.left) }, parent);
  outline(parent, [...face, ...edge.map(([a, b]) => on(a, b, s.t))]);
}

/** The shadow a thing with this footprint throws on the table. */
export function groundShadow(parent: Element, s: { x: number; y: number; w: number; d: number; r: number }): void {
  el('path', { d: pathOf(roundedRect(s.w, s.d, s.r).map(([a, b]) => iso(s.x + a, s.y + b))), class: 'dev-shadow' }, parent);
}

/** Many small flat rectangles at height z, as one shape: keys on a keyboard. */
export function tiles(parent: Element, rects: { x: number; y: number; w: number; d: number }[], z: number, attrs: Record<string, string | number>): void {
  const d = rects.map((r) => pathOf([iso(r.x, r.y, z), iso(r.x + r.w, r.y, z), iso(r.x + r.w, r.y + r.d, z), iso(r.x, r.y + r.d, z)])).join('');
  el('path', { d, ...attrs }, parent);
}

/** A flat iso rectangle on the ground plane (or at height z). */
export function tile(parent: Element | null, x: number, y: number, w: number, d: number, z: number, attrs: Record<string, string | number>): SVGPathElement {
  const p = el('path', { d: `M${P(x, y, z)}L${P(x + w, y, z)}L${P(x + w, y + d, z)}L${P(x, y + d, z)}Z`, ...attrs });
  if (parent) parent.appendChild(p);
  return p;
}

export interface CylSpec {
  x: number; // centre
  y: number;
  z: number;
  r: number;
  h: number;
  color: string;
  cls?: string;
}

/** Vertical cylinder: elliptical top + shaded body. */
export function cylinder(parent: Element | null, s: CylSpec): SVGGElement {
  const g = el('g', { class: `icyl ${s.cls ?? ''}` });
  const rx = s.r * Math.SQRT2 * U;
  const ry = rx / 2;
  const top = iso(s.x, s.y, s.z + s.h);
  const bot = iso(s.x, s.y, s.z);
  el('path', { d: `M${(top.sx - rx).toFixed(2)} ${top.sy.toFixed(2)}L${(bot.sx - rx).toFixed(2)} ${bot.sy.toFixed(2)}A${rx.toFixed(2)} ${ry.toFixed(2)} 0 0 0 ${(bot.sx + rx).toFixed(2)} ${bot.sy.toFixed(2)}L${(top.sx + rx).toFixed(2)} ${top.sy.toFixed(2)}Z`, fill: shade(s.color, FACE.right), class: 'f-right' }, g);
  el('path', { d: `M${(top.sx - rx).toFixed(2)} ${top.sy.toFixed(2)}L${(bot.sx - rx).toFixed(2)} ${bot.sy.toFixed(2)}A${rx.toFixed(2)} ${ry.toFixed(2)} 0 0 0 ${bot.sx.toFixed(2)} ${(bot.sy + ry).toFixed(2)}L${top.sx.toFixed(2)} ${(top.sy + ry).toFixed(2)}Z`, fill: shade(s.color, FACE.left), class: 'f-left' }, g);
  el('ellipse', { cx: top.sx.toFixed(2), cy: top.sy.toFixed(2), rx: rx.toFixed(2), ry: ry.toFixed(2), fill: shade(s.color, FACE.top), class: 'f-top' }, g);
  if (parent) parent.appendChild(g);
  return g;
}

/** Screen-aligned text at a world point. Call `placeBillboard` to move it later. */
export function billboard(parent: Element | null, p: Vec3, text: string, cls = '', attrs: Record<string, string | number> = {}): SVGTextElement {
  const s = iso(p.x, p.y, p.z);
  const t = el('text', { x: s.sx.toFixed(1), y: s.sy.toFixed(1), class: `bb ${cls}`, ...attrs });
  t.textContent = text;
  if (parent) parent.appendChild(t);
  return t;
}

export function placeBillboard(t: SVGTextElement, p: Vec3, dx = 0, dy = 0): void {
  const s = iso(p.x, p.y, p.z);
  t.setAttribute('x', (s.sx + dx).toFixed(1));
  t.setAttribute('y', (s.sy + dy).toFixed(1));
}

/** Translate transform that moves something built at the origin to world point p. */
export function at(p: Vec3): string {
  const s = iso(p.x, p.y, p.z);
  return `translate(${s.sx.toFixed(2)},${s.sy.toFixed(2)})`;
}

/** Line between two world points. */
export function line(parent: Element | null, a: Vec3, b: Vec3, attrs: Record<string, string | number>): SVGLineElement {
  const A = iso(a.x, a.y, a.z);
  const B = iso(b.x, b.y, b.z);
  const l = el('line', { x1: A.sx.toFixed(2), y1: A.sy.toFixed(2), x2: B.sx.toFixed(2), y2: B.sy.toFixed(2), ...attrs });
  if (parent) parent.appendChild(l);
  return l;
}
