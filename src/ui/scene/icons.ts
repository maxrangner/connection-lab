import type { DeviceKind } from '../../sim';
import { el } from './svg';

/** Simple-shape device glyphs, drawn around (0,0) in a ~56×40 box. Replaceable by generated art later. */
export function drawIcon(kind: DeviceKind, parent: Element): SVGGElement {
  const g = el('g', { class: `icon icon-${kind}` }, parent);
  switch (kind) {
    case 'laptop':
      el('rect', { x: -22, y: -20, width: 44, height: 28, rx: 3, class: 'ic-body' }, g);
      el('rect', { x: -18, y: -16, width: 36, height: 20, rx: 1.5, class: 'ic-screen' }, g);
      el('path', { d: 'M-28 10h56l-4 6h-48z', class: 'ic-body' }, g);
      break;
    case 'home-router':
      el('rect', { x: -26, y: -4, width: 52, height: 18, rx: 4, class: 'ic-body' }, g);
      el('path', { d: 'M-16 -4l-6 -18M16 -4l6 -18', class: 'ic-line' }, g);
      for (let i = 0; i < 4; i++) el('circle', { cx: -14 + i * 9, cy: 5, r: 2, class: 'ic-led' }, g);
      break;
    case 'router':
      el('ellipse', { cx: 0, cy: 8, rx: 26, ry: 9, class: 'ic-body' }, g);
      el('rect', { x: -26, y: -10, width: 52, height: 18, class: 'ic-body ic-noline' }, g);
      el('ellipse', { cx: 0, cy: -10, rx: 26, ry: 9, class: 'ic-top' }, g);
      el('path', { d: 'M-12 -10h24M8 -14l4 4-4 4M-8 -6l-4 -4 4 -4', class: 'ic-line' }, g);
      break;
    case 'dns-resolver':
      for (let i = 0; i < 2; i++) {
        el('rect', { x: -22, y: -18 + i * 17, width: 44, height: 14, rx: 2, class: 'ic-body' }, g);
        el('circle', { cx: -15, cy: -11 + i * 17, r: 2, class: 'ic-led' }, g);
      }
      el('text', { x: 6, y: -7, class: 'ic-text' }, g).textContent = 'DNS';
      break;
    case 'web-server':
      for (let i = 0; i < 3; i++) {
        el('rect', { x: -22, y: -20 + i * 13, width: 44, height: 10, rx: 2, class: 'ic-body' }, g);
        el('circle', { cx: -15, cy: -15 + i * 13, r: 1.8, class: 'ic-led' }, g);
        el('path', { d: `M-6 ${-15 + i * 13}h20`, class: 'ic-line' }, g);
      }
      break;
  }
  return g;
}
