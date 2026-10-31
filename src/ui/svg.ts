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

/** Sets an attribute only if it changed: setting the same value again still makes the browser lay things out anew. */
export function setAttr(e: Element, k: string, v: string | number): void {
  const s = String(v);
  if (e.getAttribute(k) !== s) e.setAttribute(k, s);
}

/** Sets an element's text only if it changed. */
export function setText(e: Element, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}
