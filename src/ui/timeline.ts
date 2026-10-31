import type { PduSnapshot } from '../sim';
import { toneOf } from './notes';
import { clamp01, easeIn, easeInOut, easeOutBack, easeOutBounce, lerpV, v3, type Vec3 } from './project';
import type { Details, Frame, Seen, Step, Story, Trip, Wrap } from './story';

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
  /** The name on a certificate that checked out: a stamp takes the place of the face. */
  stamp?: string;
}
export type TStep = Step | WaitStep;

/** One cable crossed by a packet of a stream. */
export interface FlowHop {
  from: string;
  to: string;
  link: string;
  /** Sim time the frame was sent. */
  at: number;
  t0: number;
  t1: number;
  lost: boolean;
  /** How far along the cable it gets (1 unless it is lost). */
  fall: number;
  seen?: Seen;
}

/** A sender of a stream waiting for its timer, or giving up. */
export interface FlowWait {
  step: WaitStep;
  t0: number;
  t1: number;
}

/** A packet of a stream: when it is on its way, and when it lands on the sheet if it is a part that gets there. */
export interface FlowPacket {
  trip: Trip;
  hops: FlowHop[];
  t0: number;
  t1: number;
  landed: number | null;
}

export interface Seg {
  step: TStep;
  trip: Trip;
  t0: number;
  t1: number;
  /** Packet centre when the step starts and ends. */
  p0: Vec3;
  p1: Vec3;
  /** For `lost`: how far along the cable it was knocked off (travel progress 0..1) and the travel's duration. */
  knock?: { k: number; travel: number; byYou: boolean };
  /** For `flow`: the packets of the stream. */
  flow?: FlowPacket[];
  waits?: FlowWait[];
}

export interface Cue {
  t: number;
  sound: 'snap' | 'sleeve' | 'thud' | 'swap' | 'bonk' | 'surprise' | 'pop' | 'chime' | 'lock' | 'unlock' | 'key' | 'snip' | 'flip' | 'found' | 'note' | 'break';
  /** For a note: the pitch it plays at. */
  hz?: number;
}

/** A sound of a call as its listener gets it: a note bubbling up from the phone, or one breaking for a packet that never came. */
export interface Note {
  t: number;
  device: string;
  pitch: number;
  loud: number;
  broken: boolean;
  /** Whose voice: heard by the caller, or by the friend. */
  heardBy: 'caller' | 'friend';
}

/** Seconds a note stays up. */
export const NOTE_LIFE = 2.4;
/** Packets of one gap that break: a long gap is silence, not a row of pops. */
const BROKEN_SHOWN = 2;
/** The tone of a lost packet that was itself a pause: the phone only knows something is missing. */
const UNKNOWN_TONE = { hz: 300, pitch: 0.5, loud: 0.3 };

export interface Timeline {
  segs: Seg[];
  reactions: Reaction[];
  /** A call's notes, in order. */
  notes: Note[];
  /** HTTPS: when each end has worked out the session key (it can lock and open cards from then on). */
  keys: Map<string, number>;
  /** HTTPS: when each end has made the half of its key that it keeps to itself. */
  halves: Map<string, number>;
  /** What the real clock says at points of the visual time: real seconds run nothing like the animation's. */
  real: { v: number; sim: number }[];
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
  /** How far the cable to the ISP has been stretched, in tiles. */
  stretch: number;
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
  // The far corner: its own cables reach the DNS resolver and the web server without passing the ISP router again.
  'vpn-server': { x: 24, y: -8 },
  // The name servers a cold resolver walks, in a row behind it: root, the TLD's, the site's own.
  'root-server': { x: 8, y: -16 },
  'tld-server': { x: 16, y: -16 },
  'auth-server': { x: 24, y: -16 },
  // The friend's phone, on the far side of the internet, in front of the web server.
  peer: { x: 24, y: 8 },
};

export const DEVICE_TOP: Record<string, number> = { laptop: 1.7, phone: 2.0, 'home-router': 0.55, router: 0.8, 'web-server': 2.6, 'dns-resolver': 1.1, 'vpn-server': 1.3, 'root-server': 1.5, 'tld-server': 1.1, 'auth-server': 1.1, peer: 2.0 };
/** The servers only a cold resolver talks to; off the table otherwise. */
export const UPSTREAM_KINDS = new Set(['root-server', 'tld-server', 'auth-server']);
export const CABLE_Z = 0.55;
/** Tray levels: 0 Ethernet, 1 IP, 2 transport, 3 app. The VPN case goes on just above Ethernet. */
export const LEVEL: Record<Wrap | 'app', number> = { eth: 0, vpn: 0.5, ip: 1, l4: 2, app: 3 };
const LEVEL_GAP = 1.15;
/** How far from a device's centre the cable port sits. */
const PORT = 2.4;
/** Seconds of visual time per step, the first time it happens. */
const DUR: Record<TStep['kind'], number> = { appear: 0.9, lock: 1.5, unlock: 1.3, wrap: 0.85, unwrap: 0.85, nat: 2.6, travel: 1.9, read: 1.2, lookup: 4.2, lost: 0, wait: 2.8, flow: 0 };
/** A link this slow (one-way seconds) is drawn as a radio hop up to a satellite. */
export const SLOW_DELAY = 0.1;
export const SKY_HEIGHT = 9;
/** Seconds the VPN box takes to close or open, the first time. */
const VPN_BOX = 2.6;
/** Where in a wrap step the piece closes onto the packet. */
const WRAP_SHUT = 0.35 + 0.65 * 0.45;
/** Address changes in a run that get the full sound. */
const SWAP_SOUNDS = 6;
/** Seconds a knocked packet tumbles before it is gone. */
export const TUMBLE = 1.8;
/** A stream's packets: seconds between two from one sender, per cable, flying onto the sheet, and falling off a cable. */
const FLOW_GAP = 0.26;
const FLOW_HOP = 1;
export const FLOW_FLY = 0.5;
export const FLOW_FALL = 0.9;
/** Seconds a sender of a stream visibly waits when only its timer can tell it a packet is gone. */
const FLOW_TIMER = 1.6;
/** Seconds per cable of an ACK on its own: small, and not what you came to watch. */
const ACK_HOP = 0.7;

/** Tiles between the home router and the ISP router as drawn, and the real fibre each tile stands for. */
export const WAN_TILES = 8;
export const KM_PER_TILE = 50;
/** Light in glass fibre: about two thirds of c. */
export const KM_PER_SECOND = 200_000;
/** How far the ISP router may be dragged, in tiles: 8000 km, an ocean away. */
export const MAX_STRETCH = 160;
/** The one-way delay of the fibre to the ISP when it is stretched this many tiles. */
export const wanDelayFor = (stretch: number): number => ((WAN_TILES + stretch) * KM_PER_TILE) / KM_PER_SECOND;

export function buildTimeline(story: Story, knocks: ReadonlyMap<string, number> = new Map(), stretch = 0): Timeline {
  const kind = new Map(story.devices.map((d) => [d.id, d.kind]));
  // Stretching the cable to the ISP moves the ISP router and everything beyond it further along +x.
  const pos = new Map(
    story.devices.map((d, i) => {
      const p = POS[d.kind] ?? { x: i * 8, y: 0 };
      return [d.id, p.x >= POS.router!.x ? { x: p.x + stretch, y: p.y } : p];
    }),
  );
  const trayZ = (device: string, level: number): number => (DEVICE_TOP[kind.get(device) ?? ''] ?? 1) + 1.1 + level * LEVEL_GAP;
  const at = (device: string, level: number): Vec3 => {
    const p = pos.get(device) ?? { x: 0, y: 0 };
    return v3(p.x, p.y, trayZ(device, level));
  };

  // A slow link (a satellite hop, hundreds of ms each way) arches into the sky and takes longer to cross.
  const sky = new Map(story.links.filter((l) => l.delay >= SLOW_DELAY).map((l) => [l.id, SKY_HEIGHT] as const));
  const air = new Set(story.links.filter((l) => l.medium === 'wifi').map((l) => l.id));
  // A stretched cable takes longer to cross, but not in proportion: an ocean would be a minute of watching.
  const linkPace = (link: string): number => (sky.has(link) ? 2.4 : link === 'wan' ? Math.sqrt(1 + stretch / WAN_TILES) : 1);
  const segs: Seg[] = [];
  const cues: Cue[] = [];
  const reactions: Reaction[] = [];
  const notes: Note[] = [];
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

  const byId = new Map(story.trips.map((x) => [x.packetId, x]));
  const resent = new Set(story.trips.map((x) => x.retransmitOf));
  let t = 0;
  story.trips.forEach((trip, ti) => {
    let p = at(trip.origin, trip.card ? LEVEL.app : LEVEL.l4);
    const ring = (step: WaitStep): void => {
      // A longer real wait gets a longer ring: resends back off, 1 s, 2 s, 4 s and so on.
      const seg: Seg = { step, trip, t0: t, t1: t + DUR.wait + 0.5 * Math.log2(Math.max(1, step.seconds)), p0: p, p1: p };
      segs.push(seg);
      cues.push({ t: seg.t1 - 0.5, sound: 'surprise' });
      t = seg.t1;
    };
    // The timer of a resend runs down just before it goes, whatever else was said in between.
    if (trip.timedOut) ring({ kind: 'wait', device: trip.origin, seconds: trip.waited ?? 0, giveUp: false, mood: byId.get(trip.retransmitOf ?? '')?.retry ? 'angry' : 'surprise' });
    for (const step of trip.steps) {
      const seg: Seg = { step, trip, t0: t, t1: t, p0: p, p1: p };
      let d = DUR[step.kind] * pace(step, trip);
      switch (step.kind) {
        case 'lock':
        case 'unlock':
        case 'appear':
        case 'read':
        case 'lookup':
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
        case 'flow':
          ({ packets: seg.flow, waits: seg.waits } = planFlow(step.packets, t, story, knocks, linkPace, cues, reactions, step.packets.length > 1 ? FLOW_HOP : ACK_HOP, trip.kind === 'call' ? notes : null));
          // A call stays until its last notes have gone.
          d = Math.max(t, ...seg.flow.map((p) => p.t1), ...seg.waits.map((w) => w.t1)) - t + (trip.kind === 'call' ? NOTE_LIFE : step.packets.length > 1 ? 0.5 : 0);
          break;
        case 'lost': {
          const travel = DUR.travel * pace({ ...step, kind: 'travel' }, trip) * linkPace(step.link);
          // Cut under it by the viewer: where it was. Into a cable that was already cut: halfway along.
          const caught = knocks.get(`${trip.packetId}@${step.link}`);
          const k = caught ?? 0.5;
          seg.knock = { k, travel, byYou: caught !== undefined };
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

    streak = trip.lost ? streak + 1 : 0;
    // Nobody tries again and the page never came: tears. A lost ACK needs no retry, the next data says the same thing, and a
    // lost SYN needs none once the other side's own resend has got through. A DNS answer is for the asker to miss.
    const dns = trip.chapter === 'dns';
    const askedAgain = dns && story.trips.slice(ti + 1).some((x) => x.chapter === 'dns' && x.retry);
    if (trip.lost && !story.pageTitle && trip.l4Label !== 'ACK' && !resent.has(trip.packetId) && !askedAgain) {
      ring({ kind: 'wait', device: dns ? trip.client : trip.origin, seconds: 0, giveUp: true, mood: 'cry' });
    }
    // Arrived: the receiver reacts, and the picture lingers a moment so you can see it.
    const last = segs[segs.length - 1];
    if (!trip.lost && last && last.trip === trip && 'device' in last.step) {
      const face = arrivalFace(trip, last.step.device, arrived, filled);
      if (face) {
        // The server has proved who it is: the stamp says so, and stays long enough to read.
        const stamp = trip.identity && last.step.device === trip.client ? trip.identity : undefined;
        reactions.push({ t: last.t1, device: last.step.device, face, ...(stamp ? { stamp } : {}) });
        t += stamp ? 1.8 : 0.6;
      }
    }
    // A small ACK goes straight on.
    const step = trip.steps[0];
    t += step?.kind === 'flow' && step.packets.length === 1 ? 0.1 : 0.5;
  });

  // Devices that only pass packets on, so they never open them further than IP.
  const isRouter = (device: string): boolean => /router|vpn/.test(kind.get(device) ?? '');
  // Each end has the session key once it has read the other side's last open "hello": from the two hellos both
  // compute the same secret, so the two keys are the same.
  const keys = new Map<string, number>();
  for (const s of segs) if (s.step.kind === 'read' && s.trip.chapter === 'secret' && !s.trip.locked) keys.set(s.step.device, s.t1);
  for (const t of keys.values()) cues.push({ t, sound: 'key' });
  // Each end makes its private half when it first has a hello to answer or to send.
  const halves = new Map<string, number>();
  for (const s of segs) if (s.trip.keyShare && (s.step.kind === 'appear' || s.step.kind === 'read') && !halves.has(s.step.device)) halves.set(s.step.device, s.t0);
  return { segs, reactions, notes, keys, halves, real: realClock(segs, story), cues, total: t, pos, kind, trayZ, isRouter, sky, air, client: story.client, stretch };
}

/** The real clock along the visual time, from when each frame really left and arrived. */
function realClock(segs: Seg[], story: Story): Timeline['real'] {
  const delay = new Map(story.links.map((l) => [l.id, l.delay]));
  const points = crossings({ segs })
    .flatMap((c) => [{ v: c.t0, sim: c.at }, { v: c.t1, sim: c.at + (delay.get(c.link) ?? 0) }])
    .sort((a, b) => a.v - b.v);
  let most = 0;
  return points.map((p) => ({ v: p.v, sim: (most = Math.max(most, p.sim)) }));
}

/** Real seconds gone at visual time v. */
export function realAt(tl: Pick<Timeline, 'real'>, v: number): number {
  let before = { v: 0, sim: 0 };
  for (const p of tl.real) {
    if (p.v > v) return before.sim + ((p.sim - before.sim) * (v - before.v)) / (p.v - before.v);
    before = p;
  }
  return before.sim;
}

export function formatWait(s: number): string {
  const ms = Math.round(s * 1000);
  return ms >= 1000 ? `${Number(s.toFixed(1))} s` : `${ms} ms`;
}

/**
 * When a stream's packets go. Everything keeps its real order: a packet leaves after whatever it was sent in reply to has
 * arrived, so a window of packets goes out, the ACKs come back, and they let out the next ones. Packets of one sender keep
 * a gap so each can be seen, though on the real cable they are microseconds apart. A sender that can only wait for its
 * timer shows a ring, and when it gives up, its tears; the packets themselves get no reaction each, there are too many.
 */
function planFlow(
  packets: Trip[],
  from: number,
  story: Story,
  knocks: ReadonlyMap<string, number>,
  linkPace: (link: string) => number,
  cues: Cue[],
  reactions: Reaction[],
  hop: number,
  /** A call: each side talks on its own clock, nothing is a reply to anything, so nothing waits for what was heard. Its notes go here. */
  notes: Note[] | null = null,
): { packets: FlowPacket[]; waits: FlowWait[] } {
  const delay = new Map(story.links.map((l) => [l.id, l.delay]));
  const heard: { sim: number; v: number }[] = [];
  const lastSent = new Map<string, number>();
  const filled = new Set<number>();
  /** The last time each part (or ACK) was sent. */
  const sent = new Map<string, Trip>();
  const waits: FlowWait[] = [];
  const wait = (step: WaitStep, t0: number): number => {
    const t1 = t0 + FLOW_TIMER;
    waits.push({ step, t0, t1 });
    cues.push({ t: t1 - 0.5, sound: 'surprise' });
    return t1;
  };
  /** When the last packet so far came off the cables. */
  let settled = from;
  let puzzled = false;
  /** In a call: the part each listener expects next from each sender. */
  const expected = new Map<string, number>();
  const planned = packets.map((trip): FlowPacket => {
    let t = Math.max(from, (lastSent.get(trip.origin) ?? -Infinity) + FLOW_GAP);
    // In a call each side's first word still waits for what it answers (the friend speaks only once called); after that
    // a side talks on its own clock.
    if (!notes || !lastSent.has(trip.origin)) for (const h of heard) if (h.sim <= trip.start) t = Math.max(t, h.v);
    const key = `${trip.origin}|${trip.part?.n ?? trip.l4Label}`;
    const before = sent.get(key);
    sent.set(key, trip);
    if (trip.timedOut) {
      // A timer only runs out in silence: nothing is on its way any more.
      t = wait({ kind: 'wait', device: trip.origin, seconds: trip.waited ?? 0, giveUp: false, mood: before?.retry && before.lost ? 'angry' : 'surprise' }, Math.max(t, settled));
    }
    lastSent.set(trip.origin, t);
    const t0 = t;
    const hops: FlowHop[] = [];
    for (const s of trip.steps) {
      if (s.kind !== 'travel' && s.kind !== 'lost') continue;
      const lost = s.kind === 'lost';
      // Cut under it by the viewer: where it was. Dropped off a full port buffer: right at the router. Lost by itself: halfway along.
      const caught = knocks.get(`${trip.packetId}@${s.link}`);
      const fall = lost ? (caught ?? (trip.droppedAtQueue ? 0.08 : 0.5)) : 1;
      const d = hop * linkPace(s.link) * fall;
      hops.push({ from: s.from, to: s.to, link: s.link, at: s.at, t0: t, t1: t + d, lost, fall, seen: s.seen });
      t += d;
      if (lost) cues.push({ t, sound: 'thud' });
    }
    settled = Math.max(settled, t);
    const last = hops[hops.length - 1];
    if (trip.lost || !last) return { trip, hops, t0, t1: t + FLOW_FALL, landed: null };
    heard.push({ sim: last.at + (delay.get(last.link) ?? 0), v: t });
    if (!trip.part) return { trip, hops, t0, t1: t, landed: null };
    if (notes) {
      const heardBy = last.to === story.client ? 'caller' : 'friend';
      // The listener only finds out about a lost packet now, from the number on this one. Nothing comes back for it.
      const first = expected.get(trip.origin) ?? 1;
      for (let m = first; m < Math.min(trip.part.n, first + BROKEN_SHOWN); m++) {
        const lost = sent.get(`${trip.origin}|${m}`)?.audio;
        const at = t + (m - first) * 0.12;
        notes.push({ t: at, device: last.to, ...((lost && toneOf(lost)) ?? UNKNOWN_TONE), broken: true, heardBy });
        cues.push({ t: at, sound: 'break' });
      }
      expected.set(trip.origin, trip.part.n + 1);
      // A pause makes no note.
      const tone = trip.audio && toneOf(trip.audio);
      if (tone) {
        notes.push({ t, device: last.to, ...tone, broken: false, heardBy });
        cues.push({ t, sound: 'note', hz: tone.hz });
      }
      return { trip, hops, t0, t1: t, landed: null };
    }

    const landed = t + FLOW_FLY;
    const n = trip.part.n;
    cues.push({ t: landed, sound: 'pop' });
    const fresh = !filled.has(n);
    filled.add(n);
    let gap = false;
    for (let m = 1; m < n; m++) gap ||= !filled.has(m);
    // A hole in what has come so far, or a part that had already come.
    const odd = gap || !fresh;
    if (odd && !puzzled) reactions.push({ t: landed, device: trip.client, face: 'confused' });
    puzzled = odd;
    if (fresh && filled.size === trip.part.of) {
      reactions.push({ t: landed, device: trip.client, face: 'love' });
      cues.push({ t: landed, sound: 'chime' });
    }
    return { trip, hops, t0, t1: landed, landed };
  });
  const last = planned[planned.length - 1];
  const part = last?.trip.part;
  if (!notes && last?.trip.lost && part && filled.size < part.of) wait({ kind: 'wait', device: last.trip.origin, seconds: 0, giveUp: true, mood: 'cry' }, last.t1);
  return { packets: planned, waits };
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
  if (s.kind === 'wrap') cues.push({ t: at(WRAP_SHUT), sound: s.layer === 'eth' ? 'sleeve' : s.layer === 'vpn' ? 'lock' : 'snap' });
  if (s.kind === 'unwrap' && s.layer === 'vpn') cues.push({ t: at(0.5), sound: 'unlock' });
  if (s.kind === 'unwrap' && s.layer === 'eth') cues.push({ t: at(0.35 + 0.65 * 0.62), sound: 'thud' });
  const landing = swapLanding(s);
  if (landing !== null) {
    // The full sound is for the first few. After that the router only ticks, and the VPN box has its lock.
    if (cues.filter((c) => c.sound === 'swap').length < SWAP_SOUNDS) cues.push({ t: at(landing), sound: 'swap' });
    else if (s.kind === 'nat') cues.push({ t: at(landing), sound: 'snap' });
  }
  if (s.kind === 'lookup') {
    const b = lookupBeats(s.what);
    for (const f of b.search) cues.push({ t: at(f), sound: s.what === 'dns' ? 'flip' : 'snap' });
    cues.push({ t: at(b.found), sound: 'found' });
  }
  if (s.kind === 'lost' && seg.knock) cues.push({ t: seg.t0 + seg.knock.k * seg.knock.travel, sound: seg.knock.byYou ? 'bonk' : 'thud' });
  if (s.kind === 'lock') cues.push({ t: at(0.62), sound: 'lock' });
  if (s.kind === 'unlock') cues.push({ t: at(0.4), sound: 'unlock' });
  if (s.kind === 'read') {
    const last = story.trips.filter((x) => x.card).at(-1);
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
 * from the laptop, −x on the way back. It only turns where a cable branches off sideways, swinging round while it
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
  // A packet lies along its cable either way round: on one that runs back against its facing it slides, tail first.
  const heading = Math.atan2(uy, ux);
  const cable = Math.cos(heading - inTray) < -0.9 ? heading + Math.PI : heading;
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
  if (s.kind === 'wait' || s.kind === 'flow') return 0;
  // The trays make way for the book, and come back for the reply.
  if (s.kind === 'lookup') return s.device === device ? clamp01((k - 0.85) / 0.15) : 0;
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

/** A frame crossing a cable, by itself or as one of a stream. */
export interface Crossing {
  trip: Trip;
  link: string;
  /** Sim time the frame was sent. */
  at: number;
  t0: number;
  t1: number;
  lost: boolean;
  seen?: Seen;
}

/** Every frame of the run that crosses a cable. A timeline never changes, so its list is made once. */
export function crossings(tl: Pick<Timeline, 'segs'>): Crossing[] {
  let list = CROSSINGS.get(tl.segs);
  if (!list) {
    list = tl.segs.flatMap((s): Crossing[] => {
      const st = s.step;
      if (s.flow) return s.flow.flatMap((p) => p.hops.map((h) => ({ trip: p.trip, link: h.link, at: h.at, t0: h.t0, t1: h.t1, lost: h.lost, seen: h.seen })));
      if (st.kind !== 'travel' && st.kind !== 'lost') return [];
      return [{ trip: s.trip, link: st.link, at: st.at, t0: s.t0, t1: s.t1, lost: st.kind === 'lost', seen: st.seen }];
    });
    CROSSINGS.set(tl.segs, list);
  }
  return list;
}
const CROSSINGS = new WeakMap<Seg[], Crossing[]>();

/** What a spyglass put on a line at visual time `from` has read by v, oldest first. It reads a frame a quarter of the way along. */
export function spyLog(tl: Timeline, line: string, v: number, from = -Infinity): Seen[] {
  const readAt = (c: Crossing): number => c.t0 + (c.t1 - c.t0) * 0.25;
  return crossings(tl)
    .filter((c) => c.link === line && c.seen && readAt(c) >= from && readAt(c) <= v)
    .sort((a, b) => readAt(a) - readAt(b))
    .map((c) => c.seen!);
}

/**
 * Everything already seen at visual time v: every frame that has set off on a cable (and whether it was lost), and the
 * sim time a change on `line` applies from: the latest among them, or earlier if a frame still to come on that line was
 * sent before that, as in a stream, which spreads microseconds out into seconds. Cutting or mending a cable mid-run keeps the
 * frames seen as they were and only affects the rest, so the picture so far never changes.
 */
export function seenSoFar(tl: Timeline, v: number, line?: string): { decided: Record<string, boolean>; now: number } {
  const decided: Record<string, boolean> = {};
  let now = 0;
  let next = Infinity;
  for (const c of crossings(tl)) {
    if (c.t0 > v) {
      if (c.link === line) next = Math.min(next, c.at);
      continue;
    }
    decided[`${c.trip.packetId}@${c.link}`] = c.lost;
    now = Math.max(now, c.at);
  }
  return { decided, now: Math.min(now, next) };
}

/** The packets on a line at v and how far along they are, for a cut to catch; one nearly across gets there. */
export function ridingOn(tl: Timeline, v: number, line: string): { packetId: string; k: number }[] {
  return crossings(tl).flatMap((c) => {
    if (c.link !== line || c.lost || v < c.t0 || v >= c.t1) return [];
    const k = (v - c.t0) / (c.t1 - c.t0);
    // Still dropping out of its tray: it falls as it reaches the cable.
    return k > 0.9 ? [] : [{ packetId: c.trip.packetId, k: Math.max(k, 0.12) }];
  });
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

export const NO_LOCK: LockPose = { show: false, drop: 0, open: 0, op: 1, dark: 0, key: null };
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

/**
 * Where a step button goes from visual time `from`: the next action, or back to the start of this one. Within `grace`
 * seconds of that start it goes to the one before, so pressing back again always gets further back.
 */
export function stepTarget(tl: Timeline, from: number, dir: 1 | -1, grace = 0.2): number {
  const marks = [...new Set(tl.segs.flatMap((s) => [s.t0, ...(s.flow ?? []).map((p) => p.t0)])), tl.total].sort((a, b) => a - b);
  if (dir > 0) return marks.find((m) => m > from + 0.01) ?? tl.total;
  const before = marks.filter((m) => m <= from + 0.01);
  const here = before[before.length - 1] ?? 0;
  return from - here >= grace ? here : (before[before.length - 2] ?? 0);
}

/** The fields of the packet at progress k of a segment: as the latest step left them. A translated address counts once it lands. */
export function detailsAt(seg: Seg, k: number): Details {
  return latest(seg, k, 'details') ?? {};
}

/** The exact bytes of the packet at progress k of a segment, as the latest step left them. */
export function pduAt(seg: Seg, k: number): PduSnapshot | undefined {
  return latest(seg, k, 'pdu');
}

function latest<K extends 'details' | 'pdu'>(seg: Seg, k: number, what: K): Step[K] | undefined {
  const steps = seg.trip.steps;
  const s = seg.step;
  for (let i = steps.indexOf(s as Step) - (s.kind === 'nat' && k < swapLanding(s)! ? 1 : 0); i >= 0; i--) {
    const d = steps[i]![what];
    if (d) return d;
  }
  return undefined;
}

/**
 * When things happen in a lookup, as shares of the step. `open`: the book or the shelf is ready, `search`: each page
 * turned or slot tried, `found`: the line or the file lights up, `lift`: the answer rises to become the reply.
 */
export function lookupBeats(what: 'dns' | 'web'): { open: number; search: number[]; found: number; lift: number } {
  return what === 'dns' ? { open: 0.14, search: [0.2, 0.32, 0.44], found: 0.62, lift: 0.8 } : { open: 0.08, search: [0.12, 0.24, 0.36], found: 0.48, lift: 0.78 };
}

/**
 * Where in a step the new address lands, if the step changes one: at the router in the middle of its moment, and at
 * the VPN box when the box closes, or as it starts to lift off.
 */
export function swapLanding(s: TStep): number | null {
  if (s.kind === 'nat') return 0.44;
  if (s.kind === 'wrap' && s.addr) return WRAP_SHUT;
  if (s.kind === 'unwrap' && s.addr) return 0.6;
  return null;
}

/**
 * The big moment when an address changes, at progress k of a step: the tag swells (`grow`), the field flips over
 * (`flip`, the new value shows from 0.5) to land at `landing`, then the fresh label settles and the old one peels off (`stamp`).
 */
export function swapMoment(k: number, landing: number): { grow: number; flip: number; stamp: number } {
  return {
    grow: easeOutBack(clamp01((k - 0.1) / 0.16)) * (1 - easeIn(clamp01((k - 0.84) / 0.16))),
    flip: clamp01((k - landing + 0.08) / 0.16),
    stamp: clamp01((k - landing) / 0.3),
  };
}
