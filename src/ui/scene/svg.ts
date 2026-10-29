export const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

export function text(parent: Element, x: number, y: number, s: string, cls = '', attrs: Record<string, string | number> = {}): SVGTextElement {
  const t = el('text', { x, y, class: cls, ...attrs }, parent);
  t.textContent = s;
  return t;
}

/** Sets an attribute only if it changed (cheap per-frame updates). */
export function setAttr(e: Element, k: string, v: string | number): void {
  const s = String(v);
  if (e.getAttribute(k) !== s) e.setAttribute(k, s);
}

export function show(e: Element, visible: boolean): void {
  const d = visible ? '' : 'none';
  const st = (e as SVGElement).style;
  if (st.display !== d) st.display = d;
}
