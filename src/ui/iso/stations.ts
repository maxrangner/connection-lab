import { LAYER_COLOR } from '../content/layers';
import { el } from '../scene/svg';
import type { Act, DeviceState } from '../timeline/schedule';
import type { FloorGeom, PortGeom, TowerGeom } from './layout';
import { MACHINE } from './layout';
import { DESCRIPTION, GLYPH, MACHINE_FLOOR, type MachineKind } from './machines/Machine';
import { billboard, box, line } from './prims';
import { clamp01, easeOut, iso, U, type Vec3 } from './project';

const W = 1.5;
const D = 0.9;
const H = 0.7;

export interface StationView {
  kind: MachineKind;
  iface?: string;
  g: SVGGElement;
  /** Where a bubble's tail points (world). */
  anchor: Vec3;
  /** Click target for operator gates. */
  hit: SVGElement;
  render(v: number, st: DeviceState, act: Act | undefined, u: number, blocked: boolean): void;
}

/** Press: quickly down, hold, back up. */
const press = (u: number): number => (u < 0.2 ? easeOut(u / 0.2) : u < 0.6 ? 1 : 1 - easeOut((u - 0.6) / 0.4));

/**
 * Every floor has one station: the same simple block in its layer's colour with one symbol on top. It lights up
 * and dips when it acts; a ring around the symbol shows a running timer.
 */
export function buildStation(parent: SVGGElement, kind: MachineKind, tower: TowerGeom, floor: FloorGeom, port?: PortGeom): StationView {
  const c: Vec3 = port ? { x: port.stand.x, y: port.stand.y, z: floor.top } : { x: tower.origin.x + MACHINE.x + (kind === 'natDesk' ? 2.0 : 0), y: tower.origin.y + MACHINE.y, z: floor.top };
  const layer = MACHINE_FLOOR[kind];
  const color = kind === 'natDesk' ? '#c084fc' : LAYER_COLOR[layer];
  const g = el('g', { class: `station st-${kind}`, 'data-kind': kind }, parent);
  const title = el('title', {}, g);
  title.textContent = DESCRIPTION[kind];
  const body = el('g', { class: 'st-body' }, g);
  box(body, { x: c.x - W / 2, y: c.y - D / 2, z: c.z, w: W, d: D, h: H, color, faces: { top: 0.62, left: 0.46, right: 0.36 } });
  const top = { x: c.x, y: c.y, z: c.z + H };
  const glyph = billboard(body, top, GLYPH[kind], 'st-glyph', { 'text-anchor': 'middle', dy: 5 });
  // Timer ring: an ellipse on the top face, drawn as a dash whose length is the remaining fraction.
  const tc = iso(top.x, top.y, top.z);
  const rx = 0.55 * Math.SQRT2 * U * 0.62;
  const ring = el('ellipse', { cx: tc.sx.toFixed(1), cy: tc.sy.toFixed(1), rx: rx.toFixed(1), ry: (rx / 2).toFixed(1), class: 'st-ring', pathLength: 1 }, body);
  ring.style.display = 'none';
  if (port) {
    // A short cable from the station to the socket, and the interface name.
    line(g, { x: c.x, y: c.y + D / 2, z: c.z + 0.05 }, { x: port.socket.x, y: port.socket.y, z: 0 }, { class: 'cable-stub' });
    billboard(g, { x: c.x, y: c.y + D / 2 + 0.2, z: c.z + 0.02 }, port.ifaceId.split('.')[1] ?? '', 'st-iface', { 'text-anchor': 'middle', dy: 12 });
  }
  void glyph;
  return {
    kind,
    iface: port?.ifaceId,
    g,
    anchor: { x: c.x, y: c.y, z: c.z + H + 0.3 },
    hit: body,
    render(_v, st, act, u, blocked) {
      const acting = !!act && u > 0 && u < 1.15;
      const p = acting ? press(clamp01(u)) : 0;
      body.setAttribute('transform', p ? `translate(0,${(0.12 * U * p).toFixed(2)})` : '');
      g.classList.toggle('acting', acting);
      g.classList.toggle('blocked', blocked);
      const ownTimer = st.timer && timerBelongs(kind, st.timer.kind) ? st.timer : undefined;
      ring.style.display = ownTimer ? '' : 'none';
      if (ownTimer) ring.style.strokeDasharray = `${(1 - ownTimer.fraction).toFixed(4)} 1`;
    },
  };
}

function timerBelongs(kind: MachineKind, timer: string): boolean {
  if (timer === 'tcp-rto' || timer === 'tcp-timewait') return kind === 'tcpClerk';
  if (timer === 'dns-retry') return kind === 'browser';
  return kind === 'linkStation';
}
