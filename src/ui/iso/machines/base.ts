import type { DeviceState } from '../../timeline/schedule';
import type { Act } from '../../timeline/schedule';
import type { FloorGeom, PortGeom, TowerGeom } from '../layout';
import type { Vec3 } from '../project';
import type { MachineKind } from './Machine';

export interface MachineCtx {
  deviceId: string;
  tower: TowerGeom;
  floor: FloorGeom;
  /** For ports. */
  port?: PortGeom;
}

export interface MachineView {
  kind: MachineKind;
  iface?: string;
  g: SVGGElement;
  /** Where a bubble's tail points (world). */
  anchor: Vec3;
  /** Clickable element for operator gates (megaphone, lever, ...). */
  hit?: SVGElement;
  /**
   * Draw the machine for visual time v. `act` is the machine's current act (if any) with its progress u in [0,1];
   * `blocked` is true while an operator gate waits on this machine.
   */
  render(v: number, st: DeviceState, act: Act | undefined, u: number, blocked: boolean): void;
}

export type MachineBuilder = (parent: SVGGElement, ctx: MachineCtx) => MachineView;

/** Absolute world point from tower-local coordinates. */
export function local(t: TowerGeom, lx: number, ly: number, z: number): Vec3 {
  return { x: t.origin.x + lx, y: t.origin.y + ly, z };
}
