import { el } from './svg';
import { iso, U, type Vec3 } from './project';
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
