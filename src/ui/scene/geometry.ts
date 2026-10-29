import type { DeviceSpec, LayerNum } from '../../sim';
import { rowsFor, type LayerModel, type RowDef } from '../content/layers';

export const CARD_W = 340;
export const ROW_H = 34;
export const THIN_ROW_H = 14;
export const HEAD_H = 36;
export const CARD_PAD = 8;
export const LABEL_W = 78;
export const NODE_W = 84;
export const NODE_H = 70;

export interface RowGeom {
  def: RowDef;
  y: number;
  h: number;
}

export interface CardGeom {
  cx: number;
  cy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: RowGeom[];
}

export function cardGeom(spec: DeviceSpec, model: LayerModel): CardGeom {
  const defs = rowsFor(spec.kind, model);
  let y = HEAD_H;
  const rows: RowGeom[] = [];
  for (const def of defs) {
    const h = def.thin ? THIN_ROW_H : ROW_H;
    rows.push({ def, y, h });
    y += h;
  }
  const h = y + CARD_PAD;
  const { x: cx, y: cy } = spec.layout;
  // Hosts' cards are centred on the node; rows are relative to the card's top-left.
  return { cx, cy, x: cx - CARD_W / 2, y: cy - h / 2, w: CARD_W, h, rows: rows.map((r) => ({ ...r, y: r.y + cy - h / 2 })) };
}

export function rowCenter(g: CardGeom, layer: LayerNum): number {
  const r = g.rows.find((x) => x.def.layer === layer);
  if (r) return r.y + r.h / 2;
  // Routers have no L4/L5 rows: park such strips just above the top row.
  const top = g.rows[0]!;
  return top.y + top.h / 2;
}

export function stripLeft(g: CardGeom): number {
  return g.x + LABEL_W + 4;
}

export function nodeRect(spec: DeviceSpec): { x: number; y: number; w: number; h: number } {
  return { x: spec.layout.x - NODE_W / 2, y: spec.layout.y - NODE_H / 2, w: NODE_W, h: NODE_H };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** Point where the segment from (cx,cy) towards (tx,ty) leaves the rectangle. */
export function exitPoint(
  rect: { x: number; y: number; w: number; h: number },
  cx: number,
  cy: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  const sx = dx !== 0 ? (dx > 0 ? rect.x + rect.w - cx : rect.x - cx) / dx : Infinity;
  const sy = dy !== 0 ? (dy > 0 ? rect.y + rect.h - cy : rect.y - cy) / dy : Infinity;
  const s = Math.min(Math.abs(sx), Math.abs(sy));
  return { x: cx + dx * s, y: cy + dy * s };
}
