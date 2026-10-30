import { clamp01, easeIn, easeInOut, easeOutBack, easeOutBounce, lerpV, v3, type Vec3 } from './project';
import type { Frame, Step, Story, Trip, Wrap } from './story';

/**
 * Story → visual timeline. Every trip's steps get a start and end in visual seconds, one packet at a time.
 * Everything here is a pure function of the story and the knock points, so the scene can be drawn for any v.
 */

/** A pause at the device that will resend a lost packet: its timer runs out, then it tries again. */
export type WaitStep = {
  kind: 'wait';
  device: string;
  seconds: number;
  giveUp: boolean;
  /** How the resender takes it when the ring runs out: surprised (first loss), angry (its resend was lost too), crying (gives up). */
  mood: 'surprise' | 'angry' | 'cry';
};

/** Little emoji statuses that pop up over a device. */
export type Face = 'thumbs' | 'love' | 'confused';
export const FACE_EMOJI: Record<Face | 'sad' | 'angry' | 'cry', string> = {
  thumbs: '👍',
  love: '😍',
  confused: '😕',
  sad: '😢',
  angry: '😠',
  cry: '😭',
};

export interface Reaction {
  t: number;
  device: string;
  face: Face;
}
export type TStep = Step | WaitStep;

export interface Seg {
  step: TStep;
  trip: Trip;
  t0: number;
  t1: number;
  /** Packet centre when the step starts and ends. */
  p0: Vec3;
  p1: Vec3;
  /** For `lost`: how far along the cable it was knocked off (travel progress 0..1) and the travel's duration. */
  knock?: { k: number; travel: number; byYou: boolean; cut: boolean };
}

export interface Cue {
  t: number;
  sound: 'snap' | 'sleeve' | 'thud' | 'swap' | 'bonk' | 'zap' | 'surprise' | 'pop' | 'chime' | 'lock' | 'unlock' | 'key' | 'snip';
}

export interface Timeline {
  segs: Seg[];
  reactions: Reaction[];
  /** HTTPS: when each end has worked out the session key (it can lock and open cards from then on). */
  keys: Map<string, number>;
  cues: Cue[];
  total: number;
  pos: Map<string, { x: number; y: number }>;
  kind: Map<string, string>;
  trayZ(device: string, level: number): number;
  isRouter(device: string): boolean;
  /** Arch height of a radio (satellite) hop by link id; flat cables are absent. */
  sky: Map<string, number>;
  /** Wi-Fi links: the packet flies straight through the air between the two devices. */
  air: Set<string>;
  /** The device the page is opened on. */
  client: string;
}

/** World positions (tiles) by device kind: the chain runs along +x, the DNS resolver branches off along −y. */
const POS: Record<string, { x: number; y: number }> = {
  laptop: { x: 0, y: 0 },
  // The phone sits in front of the home router, talking to it over Wi-Fi.
  phone: { x: 8, y: 8 },
  'home-router': { x: 8, y: 0 },
  router: { x: 16, y: 0 },
  'web-server': { x: 24, y: 0 },
  'dns-resolver': { x: 16, y: -8 },
  // Branches off the ISP router the other way, towards the viewer.
  'vpn-server': { x: 16, y: 8 },
};

export const DEVICE_TOP: Record<string, number> = { laptop: 1.7, phone: 2.0, 'home-router': 0.55, router: 0.8, 'web-server': 2.6, 'dns-resolver': 1.1, 'vpn-server': 1.3 };
export const CABLE_Z = 0.55;
/** Tray levels: 0 Ethernet, 1 IP, 2 transport, 3 app. The VPN case goes on just above Ethernet. */
export const LEVEL: Record<Wrap | 'app', number> = { eth: 0, vpn: 0.5, ip: 1, l4: 2, app: 3 };
const LEVEL_GAP = 1.15;
/** How far from a device's centre the cable port sits. */
const PORT = 2.4;
/** Seconds of visual time per step, the first time it happens. */
const DUR: Record<TStep['kind'], number> = { appear: 0.9, lock: 1.5, unlock: 1.3, wrap: 0.85, unwrap: 0.85, nat: 2.6, travel: 1.9, read: 1.2, lost: 0, wait: 2.8 };
/** A link this slow (one-way seconds) is drawn as a radio hop up to a satellite. */
export const SLOW_DELAY = 0.1;
export const SKY_HEIGHT = 9;
/** Seconds the VPN box takes to close or open, the first time. */
const VPN_BOX = 2.6;
/** Seconds a knocked packet tumbles before it is gone. */
export const TUMBLE = 1.8;

export function buildTimeline(story: Story, knocks: ReadonlyMap<string, number> = new Map()): Timeline {
  const kind = new Map(story.devices.map((d) => [d.id, d.kind]));
  const pos = new Map(story.devices.map((d, i) => [d.id, POS[d.kind] ?? { x: i * 8, y: 0 }]));
  const trayZ = (device: string, level: number): number => (DEVICE_TOP[kind.get(device) ?? ''] ?? 1) + 1.1 + level * LEVEL_GAP;
  const at = (device: string, level: number): Vec3 => {
    const p = pos.get(device) ?? { x: 0, y: 0 };
    return v3(p.x, p.y, trayZ(device, level));
  };

  // A slow link (a satellite hop, hundreds of ms each way) arches into the sky and takes longer to cross.
  const sky = new Map(story.links.filter((l) => l.delay >= SLOW_DELAY).map((l) => [l.id, SKY_HEIGHT] as const));
  const air = new Set(story.links.filter((l) => l.medium === 'wifi').map((l) => l.id));
  const linkPace = (link: string): number => (sky.has(link) ? 2.4 : 1);
  const segs: Seg[] = [];
  const cues: Cue[] = [];
  const reactions: Reaction[] = [];
  /** What has already arrived where (to spot duplicates) and which page parts are in. */
  const arrived = new Set<string>();
  const filled = new Set<number>();
  // Steps get quicker as they repeat, so the third trip through a router doesn't drag.
  const seen = new Map<string, number>();
  // Resend after resend goes by faster and faster, so a long outage stays watchable; only the waits keep growing.
  let streak = 0;
  const pace = (s: TStep, trip: Trip): number => {
    const tired = Math.max(0.35, 0.8 ** streak);
    // An address changing is a moment to watch, the first few times.
    if (s.kind === 'nat') {
      const m = seen.get('nat') ?? 0;
      seen.set('nat', m + 1);
      return (0.55 + 0.45 * 0.7 ** m) * tired;
    }
    if (s.kind === 'appear' || s.kind === 'read' || s.kind === 'wait') return tired;
    // The VPN box going on or coming off is a moment to watch, the first few times.
    if ((s.kind === 'wrap' || s.kind === 'unwrap') && s.layer === 'vpn') {
      const m = seen.get('vpn') ?? 0;
      seen.set('vpn', m + 1);
      return ((0.5 + 0.5 * 0.7 ** m) * tired * VPN_BOX) / DUR.wrap;
    }
    const key = s.kind;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return (0.5 + 0.5 * 0.8 ** n) * (trip.card ? 1 : 0.85) * tired;
  };

  let t = 0;
  story.trips.forEach((trip, ti) => {
    let p = at(trip.origin, trip.card ? LEVEL.app : LEVEL.l4);
    for (const step of trip.steps) {
      const seg: Seg = { step, trip, t0: t, t1: t, p0: p, p1: p };
      let d = DUR[step.kind] * pace(step, trip);
      switch (step.kind) {
        case 'lock':
        case 'unlock':
        case 'appear':
        case 'read':
          seg.p1 = at(step.device, LEVEL.app);
          break;
        case 'wrap':
        case 'unwrap':
          seg.p1 = at(step.device, LEVEL[step.layer]);
          break;
        case 'nat':
          seg.p1 = at(step.device, LEVEL.ip);
          break;
        case 'travel':
          seg.p1 = at(step.to, LEVEL.eth);
          d *= linkPace(step.link);
          break;
        case 'lost': {
          const travel = DUR.travel * pace({ ...step, kind: 'travel' }, trip) * linkPace(step.link);
          // Knocked by the viewer: where they tapped. Lost by itself (a stormy cable): halfway along.
          const tapped = knocks.get(`${trip.packetId}@${step.link}`);
          const k = tapped ?? 0.5;
          seg.knock = { k, travel, byYou: tapped !== undefined, cut: !!step.cut };
          d = k * travel + TUMBLE;
          seg.p1 = travelPath(pos, trayZ, step.from, step.to, k, sky.get(step.link) ?? 0, air.has(step.link));
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
    streak = trip.lost ? streak + 1 : 0;
    if (trip.lost) {
      const next = story.trips[ti + 1];
      const retry = next?.retry ? next : undefined;
      const device = retry?.origin ?? trip.origin;
      const mood = !retry ? 'cry' : trip.retry ? 'angry' : 'surprise';
      const step: WaitStep = { kind: 'wait', device, seconds: retry ? retry.start - trip.start : 0, giveUp: !retry, mood };
      // A longer real wait gets a longer ring: resends back off, 1 s, 2 s, 4 s and so on.
      const seg: Seg = { step, trip, t0: t, t1: t + DUR.wait + 0.5 * Math.log2(Math.max(1, step.seconds)), p0: p, p1: p };
      segs.push(seg);
      cues.push({ t: seg.t1 - 0.5, sound: 'surprise' });
      t = seg.t1;
    }
    // Arrived: the receiver reacts, and the picture lingers a moment so you can see it.
    const last = segs[segs.length - 1];
    if (!trip.lost && last && last.trip === trip && 'device' in last.step) {
      const face = arrivalFace(trip, last.step.device, arrived, filled);
      if (face) {
        reactions.push({ t: last.t1, device: last.step.device, face });
        t += 0.6;
      }
    }
    t += 0.5;
  });

  // Devices that only pass packets on, so they never open them further than IP.
  const isRouter = (device: string): boolean => /router|vpn/.test(kind.get(device) ?? '');
  // Each end has the session key once it has read the other side's last open "hello": from the two hellos both
  // compute the same secret, so the two keys are the same.
  const keys = new Map<string, number>();
  for (const s of segs) if (s.step.kind === 'read' && s.trip.chapter === 'secret' && !s.trip.locked) keys.set(s.step.device, s.t1);
  for (const t of keys.values()) cues.push({ t, sound: 'key' });
  return { segs, reactions, keys, cues, total: t, pos, kind, trayZ, isRouter, sky, air, client: story.client };
}

/**
 * How the receiver feels about what just arrived. Thumbs up for a reply it was waiting for (and the ACK that
 * finishes the hello); love when the page is complete; confused by a duplicate, or by a part that turns up while an
 * earlier one is still missing. Requests (a question, SYN, GET) get no reaction.
 */
function arrivalFace(trip: Trip, device: string, arrived: Set<string>, filled: Set<number>): Face | null {
  if (trip.quiet) return null;
  const key = `${device}|${trip.chapter}|${trip.card ?? trip.l4Label}|${trip.part?.n ?? 0}`;
  if (arrived.has(key)) return 'confused';
  arrived.add(key);
  if (trip.part) {
    filled.add(trip.part.n);
    if (filled.size === trip.part.of) return 'love';
    for (let m = 1; m < trip.part.n; m++) if (!filled.has(m)) return 'confused';
    return 'thumbs';
  }
  if (trip.chapter === 'page' && !trip.outward) return 'love';
  if (!trip.outward) return 'thumbs';
  if (trip.chapter === 'hello' && trip.l4Label === 'ACK') return 'thumbs';
  return null;
}

function addCues(cues: Cue[], seg: Seg, story: Story): void {
  const s = seg.step;
  const at = (f: number): number => seg.t0 + (seg.t1 - seg.t0) * f;
  if (s.kind === 'wrap') cues.push({ t: at(0.35 + 0.65 * 0.45), sound: s.layer === 'eth' ? 'sleeve' : s.layer === 'vpn' ? 'lock' : 'snap' });
  if (s.kind === 'unwrap' && s.layer === 'vpn') cues.push({ t: at(0.5), sound: 'unlock' });
  if (s.kind === 'unwrap' && s.layer === 'eth') cues.push({ t: at(0.35 + 0.65 * 0.62), sound: 'thud' });
  if (s.kind === 'nat' || ((s.kind === 'wrap' || s.kind === 'unwrap') && s.addr)) cues.push({ t: at(0.44), sound: 'swap' });
  if (s.kind === 'lost' && seg.knock) cues.push({ t: seg.t0 + seg.knock.k * seg.knock.travel, sound: seg.knock.byYou ? 'bonk' : seg.knock.cut ? 'thud' : 'zap' });
  if (s.kind === 'lock') cues.push({ t: at(0.62), sound: 'lock' });
  if (s.kind === 'unlock') cues.push({ t: at(0.4), sound: 'unlock' });
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

/**
 * Inside a device the packet always lies along its stations (the trays all run along x): facing +x on the way out
 * from the laptop, −x on the way back. It only turns where a cable branches off another way, swinging round while it
 * drops from its tray down to the port, and back again while it rises into the next device.
 */
export function trayAngle(trip: Trip): number {
  return trip.outward ? 0 : Math.PI;
}

/** Angle a turned the shortest way towards b, by t. */
function turnTo(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

/**
 * Down from the sender's Ethernet tray to its port, along the cable, and up into the receiver's tray. A link with
 * `sky` > 0 is a radio hop (a satellite): the packet climbs to the top of an arch that high and comes back down.
 */
export function travelPose(
  pos: Map<string, { x: number; y: number }>,
  trayZ: (device: string, level: number) => number,
  from: string,
  to: string,
  k: number,
  inTray = 0,
  sky = 0,
  flies = false,
): { pos: Vec3; angle: number } {
  const a = pos.get(from) ?? { x: 0, y: 0 };
  const b = pos.get(to) ?? { x: 0, y: 0 };
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const cable = Math.atan2(uy, ux);
  const portA = v3(a.x + ux * PORT, a.y + uy * PORT, CABLE_Z);
  const portB = v3(b.x - ux * PORT, b.y - uy * PORT, CABLE_Z);
  // Over Wi-Fi there is no cable to drop to: the packet flies in a low arc from tray to tray.
  const za = trayZ(from, 0);
  const zb = trayZ(to, 0);
  const middle = flies
    ? [v3(a.x + (b.x - a.x) * 0.5, a.y + (b.y - a.y) * 0.5, Math.max(za, zb) + 1.2)]
    : sky > 0
      ? [portA, v3((a.x + b.x) / 2, (a.y + b.y) / 2, sky), portB]
      : [portA, portB];
  const pts = [v3(a.x, a.y, trayZ(from, 0)), ...middle, v3(b.x, b.y, trayZ(to, 0))];
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y, p.z - pts[i]!.z));
  const total = lens.reduce((s, x) => s + x, 0);
  const first = lens[0]!;
  const last = lens[lens.length - 1]!;
  const onCable = total - first - last;
  const dist = easeInOut(k) * total;
  // Swing round over the drop and the first third of the cable; swing back over the last third and the rise.
  const out = first + onCable / 3;
  const back = total - last - onCable / 3;
  const angle = dist < out ? turnTo(inTray, cable, smooth(dist / out)) : dist > back ? turnTo(cable, inTray, smooth((dist - back) / (total - back))) : cable;
  let d = dist;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i]! || i === lens.length - 1) return { pos: lerpV(pts[i]!, pts[i + 1]!, clamp01(d / lens[i]!)), angle };
    d -= lens[i]!;
  }
  return { pos: pts[pts.length - 1]!, angle: inTray };
}

/** Gentle S-curve (smoothstep): starts and ends at rest, never faster than 1.5×. */
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export function travelPath(
  pos: Map<string, { x: number; y: number }>,
  trayZ: (device: string, level: number) => number,
  from: string,
  to: string,
  k: number,
  sky = 0,
  flies = false,
): Vec3 {
  return travelPose(pos, trayZ, from, to, k, 0, sky, flies).pos;
}

/** Packet centre and facing for a segment at progress k: move first, then the layer work happens in place. */
export function packetPose(tl: Timeline, seg: Seg, k: number): { pos: Vec3; angle: number } {
  const s = seg.step;
  const inTray = trayAngle(seg.trip);
  if (s.kind === 'travel') return travelPose(tl.pos, tl.trayZ, s.from, s.to, k, inTray, tl.sky.get(s.link) ?? 0, tl.air.has(s.link));
  if (s.kind === 'lost' && seg.knock) {
    const local = k * (seg.t1 - seg.t0);
    return travelPose(tl.pos, tl.trayZ, s.from, s.to, Math.min(seg.knock.k, local / seg.knock.travel), inTray, tl.sky.get(s.link) ?? 0, tl.air.has(s.link));
  }
  return { pos: lerpV(seg.p0, seg.p1, easeInOut(clamp01(k / 0.4))), angle: inTray };
}

export function packetPos(tl: Timeline, seg: Seg, k: number): Vec3 {
  return packetPose(tl, seg, k).pos;
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
    if ((s.kind === 'wrap' || s.kind === 'unwrap') && s.addr) Object.assign(a, s.addr);
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

/**
 * Everything already seen at visual time v: every frame that has set off on a cable (and whether it was lost),
 * and the latest sim time among them. Changing the weather mid-run keeps these as they were and only affects
 * frames sent from that sim time on, so the picture so far never changes.
 */
export function seenSoFar(tl: Timeline, v: number): { decided: Record<string, boolean>; now: number } {
  const decided: Record<string, boolean> = {};
  let now = 0;
  for (const s of tl.segs) {
    if (s.t0 > v) continue;
    const st = s.step;
    if (st.kind !== 'travel' && st.kind !== 'lost') continue;
    decided[`${s.trip.packetId}@${st.link}`] = st.kind === 'lost';
    now = Math.max(now, st.at);
  }
  return { decided, now };
}

/** The frame around the packet during a segment: the one being put on or taken off, else the last one put on. */
export function frameAt(seg: Seg): Frame | undefined {
  const s = seg.step;
  if ((s.kind === 'wrap' || s.kind === 'unwrap') && s.frame) return s.frame;
  let f: Frame | undefined;
  for (const x of seg.trip.steps) {
    if (x === s) break;
    if (x.kind === 'wrap' && x.frame) f = x.frame;
  }
  return f ?? seg.trip.steps.find((x): x is Extract<Step, { kind: 'wrap' }> => x.kind === 'wrap' && !!x.frame)?.frame;
}

/** The padlock on a card and the key working it, at progress k of a segment. */
export interface LockPose {
  show: boolean;
  /** 1 = high above the card, 0 = sitting on it, negative = lifting off. */
  drop: number;
  /** Shackle: 0 shut, 1 open. */
  open: number;
  op: number;
  /** How dark (encrypted) the card is. */
  dark: number;
  /** The key while it is out: `to` 0 at its resting place, 1 in the keyhole; `turn` 0..1 of a quarter turn. */
  key: { to: number; turn: number } | null;
}

const NO_LOCK: LockPose = { show: false, drop: 0, open: 0, op: 1, dark: 0, key: null };
const SHUT: LockPose = { show: true, drop: 0, open: 0, op: 1, dark: 1, key: null };

export function lockPose(seg: Seg, k: number): LockPose {
  const { trip, step } = seg;
  if (!trip.locked) return NO_LOCK;
  if (step.kind === 'lock') {
    // Drops on open, the key flies in and turns, the shackle snaps shut, the key goes home.
    const flyIn = clamp01((k - 0.25) / 0.3);
    const flyOut = clamp01((k - 0.78) / 0.22);
    return {
      show: true,
      drop: 1 - easeOutBounce(clamp01(k / 0.25)),
      open: 1 - clamp01((k - 0.62) / 0.08),
      op: 1,
      dark: clamp01((k - 0.62) / 0.14),
      key: k > 0.25 && k < 1 ? { to: easeInOut(flyIn) * (1 - easeInOut(flyOut)), turn: clamp01((k - 0.55) / 0.13) * (1 - clamp01((k - 0.7) / 0.08)) } : null,
    };
  }
  if (step.kind === 'unlock') {
    // The key flies in and turns, the shackle springs open, the key goes home, the padlock lifts away.
    const lift = clamp01((k - 0.55) / 0.4);
    return {
      show: k < 0.95,
      drop: -easeIn(lift),
      open: clamp01((k - 0.42) / 0.08),
      op: 1 - clamp01((k - 0.7) / 0.25),
      dark: 1 - clamp01((k - 0.42) / 0.14),
      key: k < 0.9 ? { to: easeInOut(clamp01(k / 0.28)) * (1 - easeInOut(clamp01((k - 0.58) / 0.3))), turn: clamp01((k - 0.28) / 0.14) * (1 - clamp01((k - 0.48) / 0.1)) } : null,
    };
  }
  const i = trip.steps.indexOf(step as Step);
  const locked = trip.steps.findIndex((s) => s.kind === 'lock');
  const opened = trip.steps.findIndex((s) => s.kind === 'unlock');
  if (i < 0 || i < locked || (opened >= 0 && i > opened)) return NO_LOCK;
  return SHUT;
}

/** Where a step button goes from visual time `from`: the next action, or back to the start of this or the last one. */
export function stepTarget(tl: Timeline, from: number, dir: 1 | -1): number {
  const marks = [...new Set(tl.segs.map((s) => s.t0)), tl.total].sort((a, b) => a - b);
  if (dir > 0) return marks.find((m) => m > from + 0.01) ?? tl.total;
  return [...marks].reverse().find((m) => m < from - 0.2) ?? 0;
}

/**
 * The big moment when an address changes, at progress k of a step: the tag swells (`grow`), the field flips over
 * (`flip`, the new value shows from 0.5), then the new value lands with a bang and the old one falls away (`stamp`).
 */
export function swapMoment(k: number): { grow: number; flip: number; stamp: number } {
  return {
    grow: easeOutBack(clamp01((k - 0.1) / 0.16)) * (1 - easeIn(clamp01((k - 0.84) / 0.16))),
    flip: clamp01((k - 0.36) / 0.16),
    stamp: clamp01((k - 0.44) / 0.3),
  };
}
