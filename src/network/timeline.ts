import { clamp01, easeInOut, lerpV, v3, type Vec3 } from '../ui/iso/project';
import type { Step, Story, Trip, Wrap } from './story';

/** Seconds of visual time per step. */
const DUR: Record<Step['kind'], number> = { appear: 0.9, wrap: 0.85, unwrap: 0.85, nat: 1.6, travel: 1.9, read: 1.2 };

/** Tiles between devices along +x. */
export const SPACING = 8;
export const CABLE_Z = 0.55;
/** Tray levels: 0 Ethernet, 1 IP, 2 TCP, 3 app. */
export const LEVEL: Record<Wrap | 'app', number> = { eth: 0, ip: 1, tcp: 2, app: 3 };
const LEVEL_GAP = 1.15;

export const DEVICE_TOP: Record<string, number> = { laptop: 1.7, 'home-router': 0.55, router: 0.8, 'web-server': 2.6 };

export interface Seg {
  step: Step;
  trip: Trip;
  t0: number;
  t1: number;
  /** Packet centre when the step starts and ends. */
  p0: Vec3;
  p1: Vec3;
}

export interface Timeline {
  segs: Seg[];
  total: number;
  deviceX: Map<string, number>;
  deviceKind: Map<string, string>;
  trayZ(device: string, level: number): number;
  isRouter(device: string): boolean;
}

export function buildTimeline(story: Story): Timeline {
  const deviceX = new Map(story.devices.map((d, i) => [d.id, i * SPACING]));
  const deviceKind = new Map(story.devices.map((d) => [d.id, d.kind]));
  const trayZ = (device: string, level: number): number => (DEVICE_TOP[deviceKind.get(device) ?? ''] ?? 1) + 1.1 + level * LEVEL_GAP;
  const at = (device: string, level: number): Vec3 => v3(deviceX.get(device) ?? 0, 0, trayZ(device, level));

  const segs: Seg[] = [];
  let t = 0;
  for (const trip of [story.request, story.response]) {
    const first = trip.steps[0];
    let p = first && first.kind !== 'travel' ? at(first.device, LEVEL.app) : v3(0, 0, 0);
    for (const step of trip.steps) {
      let p1 = p;
      switch (step.kind) {
        case 'appear':
        case 'read':
          p1 = at(step.device, LEVEL.app);
          break;
        case 'wrap':
        case 'unwrap':
          p1 = at(step.device, LEVEL[step.layer]);
          break;
        case 'nat':
          p1 = at(step.device, LEVEL.ip);
          break;
        case 'travel':
          p1 = at(step.to, LEVEL.eth);
          break;
      }
      const d = DUR[step.kind];
      segs.push({ step, trip, t0: t, t1: t + d, p0: p, p1 });
      t += d;
      p = p1;
    }
    t += 0.5;
  }
  const isRouter = (device: string): boolean => (deviceKind.get(device) ?? '').includes('router');
  return { segs, total: t, deviceX, deviceKind, trayZ, isRouter };
}

export function segAt(tl: Timeline, v: number): { seg: Seg; k: number } | null {
  if (v < 0) return null;
  for (const seg of tl.segs) if (v < seg.t1) return { seg, k: clamp01((v - seg.t0) / (seg.t1 - seg.t0)) };
  return null;
}

/** Down from the sender's Ethernet tray to the cable, along it, and up into the receiver's tray. */
export function travelPath(tl: Timeline, from: string, to: string, k: number): Vec3 {
  const xa = tl.deviceX.get(from) ?? 0;
  const xb = tl.deviceX.get(to) ?? 0;
  const dir = Math.sign(xb - xa) || 1;
  const pts = [
    v3(xa, 0, tl.trayZ(from, 0)),
    v3(xa + dir * 2.4, 0, CABLE_Z),
    v3(xb - dir * 2.4, 0, CABLE_Z),
    v3(xb, 0, tl.trayZ(to, 0)),
  ];
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.z - pts[i]!.z));
  const total = lens.reduce((a, b) => a + b, 0);
  let d = easeInOut(k) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]! || i === lens.length - 1) return lerpV(pts[i]!, pts[i + 1]!, clamp01(d / lens[i]!));
    d -= lens[i]!;
  }
  return pts[3]!;
}

/** Packet centre for a segment at progress k: move first, then the layer work happens in place. */
export function packetPos(tl: Timeline, seg: Seg, k: number): Vec3 {
  if (seg.step.kind === 'travel') return travelPath(tl, seg.step.from, seg.step.to, k);
  return lerpV(seg.p0, seg.p1, easeInOut(clamp01(k / 0.4)));
}

/** Which layer pieces are on the packet when a segment starts (before its own change). */
export function wrapsBefore(seg: Seg): Set<Wrap> {
  const on = new Set<Wrap>();
  for (const s of seg.trip.steps) {
    if (s === seg.step) break;
    if (s.kind === 'wrap') on.add(s.layer);
    if (s.kind === 'unwrap') on.delete(s.layer);
  }
  return on;
}

/** Source and destination addresses on the IP piece when a segment starts. */
export function addressBefore(seg: Seg): { from: string; to: string } {
  const a = { from: seg.trip.from, to: seg.trip.to };
  for (const s of seg.trip.steps) {
    if (s === seg.step) break;
    if (s.kind === 'nat') a[s.which] = s.after;
  }
  return a;
}

/** Device trays fade in while the packet is at a device and out as it leaves. */
export function trayOpacity(tl: Timeline, device: string, v: number): number {
  const hit = segAt(tl, v);
  if (!hit) return 0;
  const { seg, k } = hit;
  const fade = 0.3;
  if (seg.step.kind === 'travel') {
    const dt = seg.t1 - seg.t0;
    if (seg.step.from === device) return clamp01(1 - (k * dt) / fade);
    if (seg.step.to === device) return clamp01(1 - ((1 - k) * dt) / fade);
    return 0;
  }
  if (seg.step.device !== device) return 0;
  // Fade in at the start of a trip, fade out after the last read.
  const first = seg.trip.steps[0] === seg.step;
  const last = seg.trip.steps[seg.trip.steps.length - 1] === seg.step;
  const dt = seg.t1 - seg.t0;
  let o = 1;
  if (first) o = Math.min(o, clamp01((k * dt) / fade));
  if (last) o = Math.min(o, clamp01(((1 - k) * dt) / fade));
  return o;
}
