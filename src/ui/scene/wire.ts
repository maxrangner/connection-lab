import { ETH_PREAMBLE, type PduSnapshot } from '../../sim';
import { LAYER_COLOR, protocolColor } from '../content/layers';
import { layoutStrip } from './strip';
import { el } from './svg';

export const CELL_W = 4.4;
const AMP = 6.5;
const LITERAL_CELLS = 12;

export interface Train {
  g: SVGGElement;
  wave: SVGGElement;
  label: SVGTextElement;
  length: number;
  cells: { x: number; y: number; color: string }[];
}

/**
 * A decimated but real view of the bits on the wire: preamble first, then the frame, each byte sent least
 * significant bit first (as Ethernet does). Colors follow the layer that owns the byte.
 */
export function buildTrain(frame: PduSnapshot, wireBytes: number): Train {
  const bytes = new Uint8Array(ETH_PREAMBLE.length + frame.bytes.length);
  bytes.set(ETH_PREAMBLE, 0);
  bytes.set(frame.bytes, ETH_PREAMBLE.length);
  const layout = layoutStrip(frame);
  const colorOfByte = (i: number): string => {
    if (i < ETH_PREAMBLE.length) return LAYER_COLOR[1];
    const b = i - ETH_PREAMBLE.length;
    const s = layout.segs.find((x) => b >= x.start && b < x.end);
    return s ? protocolColor(s.protocol) : LAYER_COLOR[2];
  };
  const totalBits = bytes.length * 8;
  const n = Math.max(18, Math.min(56, Math.round(14 + 7 * Math.log2(wireBytes / 64))));
  // The first cells are the literal first preamble bits, so the 1010… clock pattern is visible.
  const bitIndex = (k: number): number =>
    k < LITERAL_CELLS ? k : Math.floor(LITERAL_CELLS + ((k - LITERAL_CELLS) * (totalBits - LITERAL_CELLS)) / (n - LITERAL_CELLS));
  const cells: Train['cells'] = [];
  for (let k = 0; k < n; k++) {
    const idx = bitIndex(k);
    const bit = ((bytes[idx >> 3] ?? 0) >> (idx & 7)) & 1;
    cells.push({ x: -k * CELL_W, y: bit ? -AMP : AMP, color: colorOfByte(idx >> 3) });
  }
  const g = el('g', { class: 'train' });
  const wave = el('g', { class: 'train-wave' }, g);
  let k = 0;
  let prevY: number | null = null;
  while (k < n) {
    const color = cells[k]!.color;
    let d = '';
    const start = k;
    while (k < n && cells[k]!.color === color) {
      const c = cells[k]!;
      if (k === start) d += `M${c.x} ${prevY ?? c.y}L${c.x} ${c.y}`;
      else if (prevY !== c.y) d += `L${c.x} ${c.y}`;
      d += `L${c.x - CELL_W} ${c.y}`;
      prevY = c.y;
      k++;
    }
    el('path', { d, stroke: color, class: 'wave' }, wave);
  }
  const label = el('text', { class: 'train-label', x: 0, y: 0 }, g);
  label.textContent = `${wireBytes} B · ${(wireBytes * 8).toLocaleString('en')} bits`;
  return { g, wave, label, length: n * CELL_W, cells };
}
