import type { DeviceKind, DeviceSpec, LayerNum, LinkSpec, Scenario } from '../../sim';
import { v3, type Vec3 } from './project';

/** Footprint of every tower in tiles (x by y), and vertical rhythm. */
export const FW = 7;
export const FD = 3.6;
export const FLOOR_H = 4.6;
export const SLAB_T = 0.3;
export const ROOF_T = 0.25;
/** Gizmo parts are this deep (along y). */
export const PART_D = 1.1;
/** The slot where a gizmo rests on a floor, relative to the tower origin. */
export const SLOT = { x: 1.3, y: FD - 1.3 };
/** Where the floor's station stands (centre), relative to the tower origin: at the back, behind the slot. */
export const MACHINE = { x: 3.5, y: 0.8 };
/** Socket offset: cables run along this y line in front of the pads. */
export const CABLE_Y = FD + 0.6;

export interface FloorGeom {
  layer: LayerNum;
  index: number;
  z: number;
  /** Top surface of the slab. */
  top: number;
  slot: Vec3;
  machine: Vec3;
  bubble: Vec3;
}

export interface PortGeom {
  ifaceId: string;
  /** Where the cable meets the ground. */
  socket: Vec3;
  /** Where the transceiver stands on the physical floor. */
  stand: Vec3;
  /** Which side the port is on; the '2' variants use the outer cable row (for a second link on the same side). */
  side: 'left' | 'right' | 'left2' | 'right2';
}

export interface TowerGeom {
  id: string;
  kind: DeviceKind;
  origin: { x: number; y: number };
  floors: FloorGeom[];
  ports: PortGeom[];
  /** z of the roof slab's top. */
  roofZ: number;
  depth: number;
}

/** Layers per device kind, bottom floor first. */
export function floorsFor(kind: DeviceKind): LayerNum[] {
  return kind === 'router' || kind === 'home-router' ? [1, 2, 3] : [1, 2, 3, 4, 5];
}

/**
 * World positions (tiles) per scenario. All towers sit on one line along +x, so screen-space never overlaps
 * and the painter's order equals the order of traffic. The sim's own `layout` is for the old 2D map.
 */
const WORLD: Record<string, Record<string, { x: number; y: number }>> = {
  'fetch-web-page': {
    laptop: { x: 0, y: 0 },
    home: { x: 14, y: 0 },
    isp: { x: 28, y: 0 },
    resolver: { x: 42, y: 0 },
    server: { x: 56, y: 0 },
  },
};

/** Which side of the tower each interface's port is on, per scenario. Default: first iface left, others right. */
const PORT_SIDE: Record<string, Record<string, PortGeom['side']>> = {
  'fetch-web-page': {
    'laptop.eth0': 'right',
    'home.lan': 'left',
    'home.wan': 'right',
    'isp.cust': 'left',
    'isp.p1': 'right',
    'isp.p2': 'right2',
    'resolver.eth0': 'left',
    'server.eth0': 'left2',
  },
};

/** Second cable row, further out in front, for the '2' sides. */
export const CABLE_Y2 = CABLE_Y + 1.8;

export function towerFor(spec: DeviceSpec, scenarioId: string): TowerGeom {
  const o = WORLD[scenarioId]?.[spec.id] ?? { x: 0, y: 0 };
  const layers = floorsFor(spec.kind);
  const floors: FloorGeom[] = layers.map((layer, index) => {
    const z = index * FLOOR_H;
    const top = z + SLAB_T;
    return {
      layer,
      index,
      z,
      top,
      slot: v3(o.x + SLOT.x, o.y + SLOT.y, top),
      machine: v3(o.x + MACHINE.x, o.y + MACHINE.y, top),
      bubble: v3(o.x + MACHINE.x, o.y + MACHINE.y, top + 2.3),
    };
  });
  const roofZ = layers.length * FLOOR_H + ROOF_T;
  const ports: PortGeom[] = spec.ifaces.map((i, k) => {
    const side = PORT_SIDE[scenarioId]?.[i.id] ?? (k === 0 ? 'left' : 'right');
    const left = side === 'left' || side === 'left2';
    const outer = side === 'left2' || side === 'right2';
    // Port stations stand at the back corners (a second port on the same side sits one step inward), so the
    // front edge stays free for the packet sliding out to the cable.
    const stand = v3(left ? o.x + (outer ? 2.3 : 0.9) : o.x + FW - (outer ? 2.3 : 0.9), o.y + MACHINE.y, SLAB_T);
    const socket = v3(left ? o.x - 0.5 : o.x + FW + 0.5, o.y + (outer ? CABLE_Y2 : CABLE_Y), 0);
    return { ifaceId: i.id, socket, stand, side };
  });
  return { id: spec.id, kind: spec.kind, origin: o, floors, ports, roofZ, depth: o.x + o.y };
}

export function floorOf(t: TowerGeom, layer: LayerNum): FloorGeom {
  return t.floors.find((f) => f.layer === layer) ?? t.floors[t.floors.length - 1]!;
}

export interface CableGeom {
  id: string;
  spec: LinkSpec;
  a: string;
  b: string;
  /** Axis-aligned polyline from port a's socket to port b's socket. */
  points: Vec3[];
  segLen: number[];
  length: number;
}

/**
 * Cables run along the front of the pads (y = CABLE_Y, or CABLE_Y2 for a second link that must pass in front
 * of a tower), as single straight segments along x.
 */
export function cableFor(link: LinkSpec, towers: Map<string, TowerGeom>): CableGeom {
  const find = (ifaceId: string): { t: TowerGeom; p: PortGeom } => {
    for (const t of towers.values()) {
      const p = t.ports.find((x) => x.ifaceId === ifaceId);
      if (p) return { t, p };
    }
    throw new Error(`no port for ${ifaceId}`);
  };
  const A = find(link.a);
  const B = find(link.b);
  // Every cable is one straight run along x: both sockets of a link sit on the same cable row.
  if (Math.abs(A.p.socket.y - B.p.socket.y) > 1e-9) throw new Error(`cable ${link.id}: sockets on different rows`);
  const points: Vec3[] = [A.p.socket, B.p.socket];
  const segLen = points.slice(1).map((p, i) => Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y));
  return { id: link.id, spec: link, a: A.t.id, b: B.t.id, points, segLen, length: segLen.reduce((a, b) => a + b, 0) };
}

export interface CablePoint {
  p: Vec3;
  axis: 'x' | 'y';
  dir: 1 | -1;
}

/** Point at distance s along the cable from its first point (clamped). */
export function cablePointAt(c: CableGeom, s: number): CablePoint {
  let rem = Math.max(0, Math.min(c.length, s));
  for (let i = 0; i < c.segLen.length; i++) {
    const a = c.points[i]!;
    const b = c.points[i + 1]!;
    const L = c.segLen[i]!;
    if (rem <= L || i === c.segLen.length - 1) {
      const t = L > 0 ? rem / L : 0;
      const axis: 'x' | 'y' = Math.abs(b.x - a.x) > 1e-9 ? 'x' : 'y';
      const dir: 1 | -1 = (axis === 'x' ? b.x - a.x : b.y - a.y) >= 0 ? 1 : -1;
      return { p: v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 0), axis, dir };
    }
    rem -= L;
  }
  return { p: c.points[0]!, axis: 'x', dir: 1 };
}

export interface WorldGeom {
  towers: Map<string, TowerGeom>;
  cables: Map<string, CableGeom>;
  /** World bounding box (tiles) incl. tower heights, for the overview camera. */
  bounds: { x0: number; y0: number; x1: number; y1: number; zTop: number };
}

export function buildWorld(sc: Scenario): WorldGeom {
  const towers = new Map<string, TowerGeom>();
  for (const d of sc.devices) towers.set(d.id, towerFor(d, sc.id));
  const cables = new Map<string, CableGeom>();
  for (const l of sc.links) cables.set(l.id, cableFor(l, towers));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let zTop = 0;
  for (const t of towers.values()) {
    x0 = Math.min(x0, t.origin.x - 1);
    y0 = Math.min(y0, t.origin.y - 1);
    x1 = Math.max(x1, t.origin.x + FW + 1);
    y1 = Math.max(y1, t.origin.y + CABLE_Y2 + 0.8);
    zTop = Math.max(zTop, t.roofZ + 1.5);
  }
  return { towers, cables, bounds: { x0, y0, x1, y1, zTop } };
}
