import { clamp01, easeInOut, lerpV, v3, type Vec3 } from './project';
import type { Step, Story, Trip, Wrap } from './story';

/**
 * Story → visual timeline. Every trip's steps get a start and end in visual seconds, one packet at a time.
 * Everything here is a pure function of the story and the knock points, so the scene can be drawn for any v.
 */

/** A pause at the device that will resend a lost packet: its timer runs out, then it tries again. */
export type WaitStep = { kind: 'wait'; device: string; seconds: number; giveUp: boolean };
export type TStep = Step | WaitStep;

export interface Axis {
  x: number;
  y: number;
}

export interface Seg {
  step: TStep;
  trip: Trip;
  t0: number;
  t1: number;
  /** Packet centre when the step starts and ends. */
  p0: Vec3;
  p1: Vec3;
  /** The direction the packet faces (its front, byte 0) during this step. */
  axis: Axis;
  /** The packet hops around to face the next cable. */
  turn?: { from: Axis; to: Axis };
  /** For `lost`: how far along the cable it was knocked off (travel progress 0..1) and the travel's duration. */
  knock?: { k: number; travel: number };
}

export interface Cue {
  t: number;
  sound: 'snap' | 'sleeve' | 'thud' | 'flip' | 'bonk' | 'surprise' | 'pop' | 'chime';
}

export interface Timeline {
  segs: Seg[];
  cues: Cue[];
  total: number;
  pos: Map<string, { x: number; y: number }>;
  kind: Map<string, string>;
  trayZ(device: string, level: number): number;
  isRouter(device: string): boolean;
}

/** World positions (tiles) by device kind: the chain runs along +x, the DNS resolver branches off along −y. */
const POS: Record<string, { x: number; y: number }> = {
  laptop: { x: 0, y: 0 },
  'home-router': { x: 8, y: 0 },
  router: { x: 16, y: 0 },
  'web-server': { x: 24, y: 0 },
  'dns-resolver': { x: 16, y: -8 },
};

export const DEVICE_TOP: Record<string, number> = { laptop: 1.7, 'home-router': 0.55, router: 0.8, 'web-server': 2.6, 'dns-resolver': 1.1 };
export const CABLE_Z = 0.55;
/** Tray levels: 0 Ethernet, 1 IP, 2 transport, 3 app. */
export const LEVEL: Record<Wrap | 'app', number> = { eth: 0, ip: 1, l4: 2, app: 3 };
const LEVEL_GAP = 1.15;
/** How far from a device's centre the cable port sits. */
const PORT = 2.4;
/** Seconds of visual time per step, the first time it happens. */
const DUR: Record<TStep['kind'], number> = { appear: 0.9, wrap: 0.85, unwrap: 0.85, nat: 1.6, travel: 1.9, read: 1.2, lost: 0, wait: 2.8 };
/** Seconds a knocked packet tumbles before it is gone. */
export const TUMBLE = 1.8;

const sameAxis = (a: Axis, b: Axis): boolean => a.x === b.x && a.y === b.y;

export function buildTimeline(story: Story, knocks: ReadonlyMap<string, number> = new Map()): Timeline {
  const kind = new Map(story.devices.map((d) => [d.id, d.kind]));
  const pos = new Map(story.devices.map((d, i) => [d.id, POS[d.kind] ?? { x: i * 8, y: 0 }]));
  const trayZ = (device: string, level: number): number => (DEVICE_TOP[kind.get(device) ?? ''] ?? 1) + 1.1 + level * LEVEL_GAP;
  const at = (device: string, level: number): Vec3 => {
    const p = pos.get(device) ?? { x: 0, y: 0 };
    return v3(p.x, p.y, trayZ(device, level));
  };
  const axisOf = (from: string, to: string): Axis => {
    const a = pos.get(from) ?? { x: 0, y: 0 };
    const b = pos.get(to) ?? { x: 0, y: 0 };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx) || 1, y: 0 } : { x: 0, y: Math.sign(dy) };
  };

  const segs: Seg[] = [];
  const cues: Cue[] = [];
  // Steps get quicker as they repeat, so the third trip through a router doesn't drag.
  const seen = new Map<string, number>();
  const pace = (s: TStep, trip: Trip): number => {
    if (s.kind === 'appear' || s.kind === 'read' || s.kind === 'wait' || s.kind === 'nat') return 1;
    const key = s.kind;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return (0.5 + 0.5 * 0.8 ** n) * (trip.card ? 1 : 0.85);
  };

  let t = 0;
  story.trips.forEach((trip, ti) => {
    const moves = trip.steps.filter((s) => s.kind === 'travel' || s.kind === 'lost') as Extract<Step, { from: string }>[];
    let facing = moves[0] ? axisOf(moves[0].from, moves[0].to) : { x: 1, y: 0 };
    let p = at(trip.origin, trip.card ? LEVEL.app : LEVEL.l4);
    let moveIdx = 0;
    for (const step of trip.steps) {
      const seg: Seg = { step, trip, t0: t, t1: t, p0: p, p1: p, axis: facing };
      let d = DUR[step.kind] * pace(step, trip);
      switch (step.kind) {
        case 'appear':
        case 'read':
          seg.p1 = at(step.device, LEVEL.app);
          break;
        case 'wrap':
        case 'unwrap':
          seg.p1 = at(step.device, LEVEL[step.layer]);
          if (step.kind === 'wrap' && step.layer === 'eth') {
            const next = moves[moveIdx];
            const want = next ? axisOf(next.from, next.to) : facing;
            if (!sameAxis(want, facing)) {
              seg.turn = { from: facing, to: want };
              facing = want;
            }
          }
          break;
        case 'nat':
          seg.p1 = at(step.device, LEVEL.ip);
          break;
        case 'travel':
          facing = axisOf(step.from, step.to);
          seg.axis = facing;
          seg.p1 = at(step.to, LEVEL.eth);
          moveIdx++;
          break;
        case 'lost': {
          facing = axisOf(step.from, step.to);
          seg.axis = facing;
          const travel = DUR.travel * pace({ ...step, kind: 'travel' }, trip);
          const k = knocks.get(`${trip.packetId}@${step.link}`) ?? 0.5;
          seg.knock = { k, travel };
          d = k * travel + TUMBLE;
          seg.p1 = travelPath(pos, trayZ, step.from, step.to, k);
          moveIdx++;
          break;
        }
      }
      seg.t1 = t + d;
      segs.push(seg);
      addCues(cues, seg, story);
      t += d;
      p = seg.p1;
    }

    // A lost packet: the device that will resend it waits for its timer, then is surprised into trying again.
    if (trip.lost) {
      const next = story.trips[ti + 1];
      const retry = next?.retry ? next : undefined;
      const device = retry?.origin ?? trip.origin;
      const step: WaitStep = { kind: 'wait', device, seconds: retry ? retry.start - trip.start : 0, giveUp: !retry };
      const seg: Seg = { step, trip, t0: t, t1: t + DUR.wait, p0: p, p1: p, axis: facing };
      segs.push(seg);
      cues.push({ t: seg.t1 - 0.5, sound: 'surprise' });
      t = seg.t1;
    }
    t += 0.5;
  });

  const isRouter = (device: string): boolean => (kind.get(device) ?? '').includes('router');
  return { segs, cues, total: t, pos, kind, trayZ, isRouter };
}

function addCues(cues: Cue[], seg: Seg, story: Story): void {
  const s = seg.step;
  const at = (f: number): number => seg.t0 + (seg.t1 - seg.t0) * f;
  if (s.kind === 'wrap') cues.push({ t: at(0.35 + 0.65 * 0.45), sound: s.layer === 'eth' ? 'sleeve' : 'snap' });
  if (s.kind === 'unwrap' && s.layer === 'eth') cues.push({ t: at(0.35 + 0.65 * 0.62), sound: 'thud' });
  if (s.kind === 'nat') cues.push({ t: at(0.5), sound: 'flip' });
  if (s.kind === 'lost' && seg.knock) cues.push({ t: seg.t0 + seg.knock.k * seg.knock.travel, sound: 'bonk' });
  if (s.kind === 'read') {
    const last = story.trips[story.trips.length - 1];
    cues.push({ t: at(0.6), sound: seg.trip === last && seg.trip.chapter === 'page' ? 'chime' : 'pop' });
  }
}

export function segAt(tl: Timeline, v: number): { seg: Seg; k: number } | null {
  if (v < 0) return null;
  for (const seg of tl.segs) if (v < seg.t1) return { seg, k: clamp01((v - seg.t0) / (seg.t1 - seg.t0)) };
  return null;
}

/** Down from the sender's Ethernet tray to its port, along the cable, and up into the receiver's tray. */
export function travelPath(
  pos: Map<string, { x: number; y: number }>,
  trayZ: (device: string, level: number) => number,
  from: string,
  to: string,
  k: number,
): Vec3 {
  const a = pos.get(from) ?? { x: 0, y: 0 };
  const b = pos.get(to) ?? { x: 0, y: 0 };
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const pts = [
    v3(a.x, a.y, trayZ(from, 0)),
    v3(a.x + ux * PORT, a.y + uy * PORT, CABLE_Z),
    v3(b.x - ux * PORT, b.y - uy * PORT, CABLE_Z),
    v3(b.x, b.y, trayZ(to, 0)),
  ];
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y, p.z - pts[i]!.z));
  const total = lens.reduce((s, x) => s + x, 0);
  let d = easeInOut(k) * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]! || i === lens.length - 1) return lerpV(pts[i]!, pts[i + 1]!, clamp01(d / lens[i]!));
    d -= lens[i]!;
  }
  return pts[3]!;
}

/** Packet centre for a segment at progress k: move first, then the layer work happens in place. */
export function packetPos(tl: Timeline, seg: Seg, k: number): Vec3 {
  const s = seg.step;
  if (s.kind === 'travel') return travelPath(tl.pos, tl.trayZ, s.from, s.to, k);
  if (s.kind === 'lost' && seg.knock) {
    const local = k * (seg.t1 - seg.t0);
    return travelPath(tl.pos, tl.trayZ, s.from, s.to, Math.min(seg.knock.k, local / seg.knock.travel));
  }
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
  const s = seg.step;
  const fade = 0.3;
  const dt = seg.t1 - seg.t0;
  if (s.kind === 'wait') return 0;
  if (s.kind === 'travel' || s.kind === 'lost') {
    if (s.from === device) return clamp01(1 - (k * dt) / fade);
    if (s.to === device && s.kind === 'travel') return clamp01(1 - ((1 - k) * dt) / fade);
    return 0;
  }
  if (s.device !== device) return 0;
  // Fade in at the start of a trip, fade out after its last step.
  const steps = seg.trip.steps;
  let o = 1;
  if (steps[0] === s) o = Math.min(o, clamp01((k * dt) / fade));
  if (steps[steps.length - 1] === s) o = Math.min(o, clamp01(((1 - k) * dt) / fade));
  return o;
}

/** What the current chapter is at v (the last one after the end). */
export function chapterAt(tl: Timeline, v: number): Trip['chapter'] | null {
  if (v < 0 || !tl.segs.length) return null;
  return (segAt(tl, v)?.seg ?? tl.segs[tl.segs.length - 1]!).trip.chapter;
}
