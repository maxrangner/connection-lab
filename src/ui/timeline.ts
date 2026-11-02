import { crossingKey, type PduSnapshot } from '../sim';
import { toneOf } from './notes';
import type { Parts } from './paper';
import { clamp01, easeIn, easeInOut, easeOutBack, easeOutBounce, lerp, lerpV, v3, type Vec3 } from './project';
import { buildReadout, listenReadout, scanReadout, type Readout } from './readout';
import { buildSpeech, listenerSpeech, type Bubble } from './speech';
import { flowOf, SLOW_DELAY, unrolled, type Details, type Frame, type Seen, type Step, type Story, type Trip, type Wrap } from './story';

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
  /** The sim time the story starts at: nothing that comes after can change what came before it. */
  startsAt: number;
  reactions: Reaction[];
  /** A call's notes, in order. */
  notes: Note[];
  /** What ping or traceroute has printed, and the hops it has found. */
  readout: Readout;
  /** The same for each added on another device. */
  joinReadouts: { device: string; readout: Readout }[];
  /** What the attackers print: what the stranger overhears, and what a scan finds. */
  attackReadouts: { device: string; readout: Readout }[];
  /** What the devices say as packets set off, in plain words. */
  speech: Bubble[];
  /** HTTPS: when each end has worked out the session key (it can lock and open cards from then on). */
  keys: Map<string, number>;
  /** HTTPS: when each end has made the half of its key that it keeps to itself. */
  halves: Map<string, number>;
  /** What the real clock says at points of the visual time: real seconds run nothing like the animation's. */
  real: { v: number; sim: number }[];
  cues: Cue[];
  /** When the last packet is done. */
  settled: number;
  /** When the last device has finished speaking too: a run does not stop on a line nobody can finish reading. */
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
  /** When a device's page came in, if that happened in the traffic after a card was dropped in. */
  pages: Map<string, number>;
  /** The same for the answer to its DNS question. */
  answers: Map<string, number>;
  /** When each device comes onto the table, as the first packet to it nears it. */
  reveals: Map<string, Entrance>;
  /** When each cable is laid, before the first packet over it, and the device it starts from. */
  laid: Map<string, Entrance & { from: string }>;
}

/** World positions (tiles) by device kind: the chain runs along +x, the DNS resolver branches off along −y. */
const POS: Record<string, { x: number; y: number }> = {
  laptop: { x: 0, y: 0 },
  // The phone sits in front of the home router, talking to it over Wi-Fi.
  phone: { x: 8, y: 8 },
  // A broker at home, on its own cable from the router, on the far side from your own things.
  'local-broker': { x: 8, y: -6 },
  // The sensor is on the wall well behind the cable to the router, so the button under it stays clear of the router.
  sensor: { x: 1, y: -9 },
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
  // Out on the internet, right below the ISP router.
  'mqtt-broker': { x: 16, y: 8 },
  // The friend's phone, on the far side of the internet, in front of the web server.
  peer: { x: 24, y: 8 },
  // Red, once dragged in. The stranger sits within reach of the Wi-Fi, the others out on the internet by the ISP router.
  stranger: { x: 13, y: 11 },
  scanner: { x: 31, y: 9 },
  bot1: { x: -4, y: -16 },
  bot2: { x: 6, y: -12 },
  bot3: { x: 11, y: -8 },
};

export const DEVICE_TOP: Record<string, number> = { laptop: 1.85, phone: 2.0, 'home-router': 0.55, router: 0.8, 'web-server': 2.6, 'dns-resolver': 1.1, 'vpn-server': 1.3, 'root-server': 1.5, 'tld-server': 1.1, 'auth-server': 1.1, peer: 2.0, stranger: 1.85, scanner: 1.85, bot: 1.8, sensor: 0.9, 'mqtt-broker': 1.5 };
/** The servers only a cold resolver talks to; off the table otherwise. */
export const UPSTREAM_KINDS = new Set(['root-server', 'tld-server', 'auth-server']);
/** The attackers switched on from the Attack popup. */
export const ATTACKER_KINDS = new Set(['stranger', 'scanner', 'bot']);
/** Seconds before the first packet sets off over a cable: it is laid over the first two, and the device at its end springs up over the second two. */
const LAY_FROM = 1.3;
const LAID_BY = 0.7;
const SPRINGS_FROM = 0.75;
const SPRUNG_BY = 0.15;

/** When something comes onto the table. */
export interface Entrance {
  t0: number;
  t1: number;
}
export const CABLE_Z = 0.55;
/** Tray levels: 0 Ethernet, 1 IP, 2 transport, 3 app. The VPN case goes on just above Ethernet. */
export const LEVEL: Record<Wrap | 'app', number> = { eth: 0, vpn: 0.5, ip: 1, l4: 2, app: 3 };
const LEVEL_GAP = 1.15;
/** How far from a device's centre the cable port sits. */
const PORT = 2.4;
/** Seconds of visual time per step, the first time it happens. */
const DUR: Record<TStep['kind'], number> = { appear: 0.9, lock: 1.5, unlock: 1.3, wrap: 0.85, unwrap: 0.85, nat: 2.6, travel: 1.9, read: 1.2, lookup: 4.2, lost: 0, wait: 2.8, flow: 0 };
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
/** Seconds a run holds still at its start, for the opening line. */
const OPENING = 2.6;
export const FLOW_FLY = 0.5;
/** The share of a hop's way, at each end, a small block takes to move between the middle of the cable and its lane. */
const LANE_IN = 0.2;
export const FLOW_FALL = 0.9;
/** Seconds a sender of a stream visibly waits when only its timer can tell it a packet is gone. */
const FLOW_TIMER = 1.6;
/** Seconds per cable of an ACK on its own: small, and not what you came to watch. */
const ACK_HOP = 0.7;
/** How much quicker the steps of a trace go once its first probe has been answered. */
const PROBE_PACE = 0.55;
/** Ping is the quick one: the same, from its first echo on. */
const PING_PACE = 0.4;
/** Seconds per cable of a repeated echo or probe. */
const PROBE_HOP = 0.4;
/** How many ACKs of a stream carry their name. */
const NAMED_ACKS = 3;
/** Seconds per cable once a card has been dropped in. */
const TRAFFIC_HOP = 0.8;

/** Tiles between the home router and the ISP router as drawn, and the real fibre each tile stands for. */
export const WAN_TILES = 8;
export const KM_PER_TILE = 50;
/** Light in glass fibre: about two thirds of c. */
export const KM_PER_SECOND = 200_000;
/** How far the ISP router may be dragged, in tiles: 8000 km, an ocean away. */
export const MAX_STRETCH = 160;
/** The one-way delay of the fibre to the ISP when it is stretched this many tiles. */
export const wanDelayFor = (stretch: number): number => ((WAN_TILES + stretch) * KM_PER_TILE) / KM_PER_SECOND;

const crosses = (t: Trip): boolean => t.steps.some((s) => s.kind === 'travel' || s.kind === 'lost');

/**
 * `drops` has the visual second each device had an action added, if any did. What was on screen by the first of them stays as
 * it was. The step under way finishes, and everything left of every job then runs at once as small blocks.
 */
export function buildTimeline(story: Story, knocks: ReadonlyMap<string, number> = new Map(), stretch = 0, drops: ReadonlyMap<string, number> = new Map(), past: Past = NO_PAST): Timeline {
  const mix = Math.min(Infinity, ...drops.values());
  const kind = new Map(story.devices.map((d) => [d.id, d.kind]));
  // An attacker is already at it when the run starts, so nothing runs by itself.
  const alone = story.attackers.length ? 0 : mix;
  // Stretching the cable to the ISP moves the ISP router and everything beyond it further along +x.
  const pos = new Map(
    story.devices.map((d, i) => {
      const p = POS[d.id] ?? POS[d.kind] ?? { x: i * 8, y: 0 };
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
  const pages = new Map<string, number>();
  const answers = new Map<string, number>();
  /** What had not been shown when a card was dropped in, and the stream that cut short, if one did. */
  const left: Trip[] = [];
  let cutShort: FlowState | undefined;
  /** What has already arrived where (to spot duplicates) and which page parts are in. */
  const arrived = new Set<string>();
  const filled = new Set<number>();
  // Steps get quicker as they repeat, so the third trip through a router doesn't drag.
  const seen = new Map<string, number>();
  // Resend after resend goes by faster and faster, so a long outage stays watchable; only the waits keep growing.
  let streak = 0;
  // A trace is one idea, shown on the first probe and its answer; after that only the hop is new.
  const shownOnce = story.trips.filter((x) => x.chapter === 'trace').slice(0, 2);
  const pace = (s: TStep, trip: Trip): number => {
    const brisk = trip.chapter === 'ping' ? PING_PACE : trip.chapter === 'trace' && !shownOnce.includes(trip) ? PROBE_PACE : 1;
    const tired = Math.max(0.35, 0.8 ** streak) * brisk;
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
  // A run opens on what the device sets out to do, and nothing moves until that can be read. A reading is already at it.
  let t = story.reading ? 0 : OPENING;
  story.trips.forEach((trip, ti) => {
    if (left.length || t >= alone || trip.client !== story.client) {
      left.push(trip);
      return;
    }
    let p = at(trip.origin, trip.card ? LEVEL.app : LEVEL.l4);
    const ring = (step: WaitStep): void => {
      // A longer real wait gets a longer ring: resends back off, 1 s, 2 s, 4 s and so on.
      const seg: Seg = { step, trip, t0: t, t1: t + DUR.wait + 0.5 * Math.log2(Math.max(1, step.seconds)), p0: p, p1: p };
      segs.push(seg);
      cues.push({ t: seg.t1 - 0.5, sound: 'surprise' });
      t = seg.t1;
    };
    // The timer of a resend runs down just before it goes, whatever else was said in between.
    if (trip.timedOut) ring({ kind: 'wait', device: trip.origin, seconds: trip.waited ?? 0, giveUp: false, mood: (trip.retransmitOf ? byId.get(trip.retransmitOf)?.retry : story.trips.slice(0, ti).some((x) => x.retry && x.origin === trip.origin && x.chapter === trip.chapter && x.card === trip.card)) ? 'angry' : 'surprise' });
    for (const [i, step] of trip.steps.entries()) {
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
        case 'flow': {
          const state = newFlow();
          const plan = planFlow(step.packets, t, story, knocks, linkPace, cues, reactions, story.probe ? (trip.chapter === 'dns' ? ACK_HOP : PROBE_HOP) : step.packets.length > 1 ? FLOW_HOP : ACK_HOP, notes, state, alone);
          ({ packets: seg.flow, waits: seg.waits } = plan);
          left.push(...plan.rest);
          if (plan.rest.length) cutShort = state;
          // A call stays until its last notes have gone.
          d = Math.max(t, ...seg.flow.map((p) => p.t1), ...seg.waits.map((w) => w.t1)) - t + (plan.rest.length ? 0 : trip.kind === 'call' ? NOTE_LIFE : step.packets.length > 1 ? 0.5 : 0);
          break;
        }
        case 'lost': {
          const travel = DUR.travel * pace({ ...step, kind: 'travel' }, trip) * linkPace(step.link);
          // Cut under it by the viewer: where it was. Into a cable that was already cut: halfway along.
          const caught = knocks.get(crossingKey(trip.packetId, step.link, crossingOf(trip, step)));
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
      // A card was dropped in: this step finishes, and what the packet has left to cross goes with the rest.
      if (t > alone) {
        const rest = trip.steps.slice(i + 1);
        if (rest.some((s) => s.kind === 'travel' || s.kind === 'lost' || s.kind === 'flow')) left.push({ ...trip, steps: rest, timedOut: false });
      }
      if (left.length) break;
    }
    if (left.length) return;

    streak = trip.lost ? streak + 1 : 0;
    // Nobody tries again and the page never came: tears. A lost ACK needs no retry, the next data says the same thing, and a
    // lost SYN needs none once the other side's own resend has got through. A DNS answer is for the asker to miss.
    // Tears are for a fetch that really failed: a ping or a trace only found nothing there.
    const dns = trip.chapter === 'dns';
    const later = story.trips.slice(ti + 1);
    const tryingOn = later.some((x) => x.origin === trip.origin && x.chapter === trip.chapter && (x.retry || x.card === trip.card)) || (dns && later.some((x) => x.chapter === 'dns'));
    if (past.rung.has(trip.packetId) || (trip.lost && !story.pageTitle && trip.l4Label !== 'ACK' && !resent.has(trip.packetId) && !tryingOn)) {
      ring({ kind: 'wait', device: dns || story.probe ? trip.client : trip.origin, seconds: 0, giveUp: true, mood: story.probe ? 'surprise' : 'cry' });
    }
    // The server has forgotten the connection, and says so: that is the end of it.
    if (trip.l4Label.includes('RST') && !trip.outward && !story.pageTitle) ring({ kind: 'wait', device: trip.client, seconds: 0, giveUp: true, mood: 'cry' });
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

  const traffic = left.flatMap(unrolled).filter(crosses).sort((a, b) => a.sent - b.sent || a.start - b.start);
  if (traffic.length) {
    const trip = flowOf(traffic[0]!, traffic, { chapter: 'traffic' });
    const step = trip.steps[0]!;
    const p = at(story.client, LEVEL.eth);
    // A page in parts carries on from what has landed so far, whether those parts came as a stream or one by one.
    const { packets, waits } = planFlow(traffic, t, story, knocks, linkPace, cues, reactions, TRAFFIC_HOP, notes, { ...(cutShort ?? { ...newFlow(), filled }), queued: true, dropped: drops, started: past.started });
    const end = Math.max(t, ...packets.map((x) => x.t1), ...waits.map((w) => w.t1));
    segs.push({ step, trip, t0: t, t1: end, p0: p, p1: p, flow: packets, waits });
    t = end + (notes.length ? NOTE_LIFE : 0.5);
    // A page in parts has its own moment on the sheet. Any other is in when its last packet is.
    for (const client of story.fetched) {
      const done = packets.filter((x) => x.trip.client === client && x.trip.chapter === 'page' && !x.trip.outward && !x.trip.lost && x.trip.dataBytes > 0).at(-1);
      if (!done || done.trip.part) continue;
      pages.set(client, done.t1);
      reactions.push({ t: done.t1, device: client, face: 'love' });
      cues.push({ t: done.t1, sound: 'chime' });
    }
    for (const app of story.told) {
      const copy = packets.find((x) => x.trip.message?.kind === 'reading' && !x.trip.lost && x.hops.at(-1)?.to === app);
      if (copy) pages.set(app, copy.t1);
    }
    for (const client of story.clients) {
      const answer = packets.find((x) => x.trip.chapter === 'dns' && !x.trip.lost && x.hops.at(-1)?.to === client);
      if (answer) answers.set(client, answer.t1);
    }
  }

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
  const { reveals, laid } = entrances(segs, Number.isFinite(mix) ? mix : 0);
  const times = timing(segs);
  const readout = buildReadout(story, story.client, story.probe, times, t);
  const joinReadouts = story.joinProbes.map(({ device, probe }) => ({ device, readout: buildReadout(story, device, probe, times, t) }));
  // The stranger reads a frame as it goes by, a quarter of the way along, like a spyglass.
  const heardAt = new Map<string, number>();
  for (const c of crossings({ segs })) if (air.has(c.link) && !heardAt.has(c.trip.packetId)) heardAt.set(c.trip.packetId, c.t0 + (c.t1 - c.t0) * 0.25);
  const attackReadouts = [
    ...(story.listener ? [{ device: story.listener, readout: listenReadout(story, heardAt, t) }] : []),
    ...(story.scan ? [{ device: story.scan.device, readout: scanReadout(story.scan, times, t) }] : []),
  ];
  for (const f of [...readout.flags, ...joinReadouts.flatMap((x) => x.readout.flags)]) cues.push({ t: f.t, sound: 'found' });
  const speech = [...buildSpeech(story, segs, t), ...(story.listener ? listenerSpeech(story.listener, story.heard, heardAt) : [])];
  return { segs, startsAt: story.startsAt, reactions, notes, readout, joinReadouts, attackReadouts, speech, keys, halves, real: realClock(segs, story), cues, settled: t, total: Math.max(t, ...speech.map((b) => b.t1)), pos, kind, trayZ, isRouter, sky, air, client: story.client, pages, answers, reveals, laid };
}

/**
 * What has to be on the table before each packet sets off: the first over a cable has it laid, the first to a device has it
 * there. Nothing can start before `since`, when the run or a dropped-in job begins, so what sets off right then comes in as it goes.
 */
function entrances(segs: Seg[], since: number): Pick<Timeline, 'reveals' | 'laid'> {
  const reveals: Timeline['reveals'] = new Map();
  const laid: Timeline['laid'] = new Map();
  const bring = (device: string, t0: number, t1: number): void => {
    if (t0 < (reveals.get(device)?.t0 ?? Infinity)) reveals.set(device, { t0, t1 });
  };
  const cross = (from: string, to: string, link: string, setOff: number): void => {
    const t = setOff < since ? setOff : Math.max(setOff, since + LAY_FROM);
    if (t - LAY_FROM < (laid.get(link)?.t0 ?? Infinity)) laid.set(link, { from, t0: t - LAY_FROM, t1: t - LAID_BY });
    // Something that sends before anything reached it has to be there already.
    bring(from, t - LAY_FROM, t - LAID_BY);
    bring(to, t - SPRINGS_FROM, t - SPRUNG_BY);
  };
  for (const s of segs) {
    const st = s.step;
    for (const h of (s.flow ?? []).flatMap((p) => p.hops)) cross(h.from, h.to, h.link, h.t0);
    if (st.kind === 'travel' || st.kind === 'lost') cross(st.from, st.to, st.link, s.t0);
  }
  return { reveals, laid };
}

/** How many times a trip had crossed this step's link before it. */
const crossingOf = (trip: Trip, step: Extract<Step, { kind: 'travel' | 'lost' }>): number => trip.steps.slice(0, trip.steps.indexOf(step)).filter((x) => (x.kind === 'travel' || x.kind === 'lost') && x.link === step.link).length;

/** When each packet set off and when it was done. */
function timing(segs: Seg[]): Map<string, { t0: number; t1: number }> {
  const times = new Map<string, { t0: number; t1: number }>();
  for (const s of segs) {
    for (const p of s.flow ?? []) times.set(p.trip.packetId, { t0: times.get(p.trip.packetId)?.t0 ?? p.t0, t1: p.t1 });
    if (!s.flow) times.set(s.trip.packetId, { t0: times.get(s.trip.packetId)?.t0 ?? s.t0, t1: s.t1 });
  }
  return times;
}

/** The real clock along the visual time, from when each frame really left and arrived. */
function realClock(segs: Seg[], story: Story): Timeline['real'] {
  const delay = new Map(story.links.map((l) => [l.id, l.delay]));
  const points = crossings({ segs })
    .flatMap((c) => [{ v: c.t0, sim: c.at - story.startsAt }, { v: c.t1, sim: c.at - story.startsAt + (delay.get(c.link) ?? 0) }])
    .sort((a, b) => a.v - b.v);
  let most = 0;
  return points.map((p) => ({ v: p.v, sim: (most = Math.max(most, p.sim)) }));
}

/**
 * The parts of a page that came in several packets, and when each landed on the sheet (not there: not yet). Only the first
 * device has a sheet, and only a page goes on it: a call's voice is notes, though its packets are numbered too.
 */
export function pageParts(tl: Pick<Timeline, 'segs' | 'client'>): Parts | null {
  let of = 0;
  let shownFrom = Infinity;
  const filled = new Map<number, number>();
  for (const s of tl.segs) {
    for (const p of s.flow ?? []) {
      if (!p.trip.part || p.trip.chapter !== 'page' || p.trip.client !== tl.client) continue;
      of = p.trip.part.of;
      shownFrom = Math.min(shownFrom, s.t0);
      if (p.landed !== null && !filled.has(p.trip.part.n)) filled.set(p.trip.part.n, p.landed);
    }
    const part = s.trip.part;
    if (!part || s.trip.chapter !== 'page') continue;
    of = part.of;
    shownFrom = Math.min(shownFrom, s.t0);
    if (s.step.kind === 'read' && s.step.device === tl.client && !filled.has(part.n)) filled.set(part.n, lerp(s.t0, s.t1, 0.92));
  }
  return of > 1 ? { of, filled, shownFrom, complete: filled.size === of ? Math.max(...filled.values()) : Infinity } : null;
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

/** The small blocks that say what they are: the first few plain ACKs of a stream, and every QoS step. A SYN or a reset has no data either, and is no ACK. */
export function namedAcks(flow: FlowPacket[]): FlowPacket[] {
  const first = flow.filter((p) => p.trip.l4Label === 'ACK').slice(0, NAMED_ACKS);
  return flow.filter((p) => first.includes(p) || p.trip.message?.kind === 'mqtt-control');
}

/** What a stream has heard and sent so far. Traffic carries on from a stream that a dropped card cut short. */
interface FlowState {
  heard: { client: string; sim: number; v: number }[];
  lastSent: Map<string, number>;
  filled: Set<number>;
  /** The last time each part (or ACK) was sent. */
  sent: Map<string, Trip>;
  /** In a call: the part each listener expects next from each sender. */
  expected: Map<string, number>;
  puzzled: boolean;
  /** When a block goes onto each cable in each direction. */
  onCable: Map<string, number[]>;
  /** Blocks of different jobs take turns on a cable. One job's already keep their distance. */
  queued: boolean;
  /** The visual second each device had an action added: nothing of its job goes before that, also when the traffic began earlier. */
  dropped: ReadonlyMap<string, number>;
  /** When packets already seen set off: they were seen to go, so nothing that has since changed can hold them back. */
  started: ReadonlyMap<string, number>;
}
const newFlow = (): FlowState => ({ heard: [], lastSent: new Map(), filled: new Set(), sent: new Map(), expected: new Map(), puzzled: false, onCable: new Map(), queued: false, dropped: new Map(), started: new Map() });

/**
 * The first moment from `wanted` on with a free place on this cable. A block takes any gap rather than going to the back of
 * the line, so it is only ever held up by blocks ahead of it: whatever comes later, or never comes, cannot move it.
 */
function freeSlot(taken: number[], wanted: number): number {
  let t = wanted;
  for (const s of [...taken].sort((a, b) => a - b)) if (t > s - FLOW_GAP && t < s + FLOW_GAP) t = s + FLOW_GAP;
  return t;
}

/**
 * When a stream's packets go. Everything keeps its real order: a packet leaves after whatever it was sent in reply to has
 * arrived, so a window of packets goes out, the ACKs come back, and they let out the next ones. Packets of one sender keep
 * a gap so each can be seen, though on the real cable they are microseconds apart. A sender that can only wait for its
 * timer shows a ring, and when it gives up, its tears; the packets themselves get no reaction each, there are too many.
 * Each device's job only waits for its own packets, so two jobs run side by side.
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
  /** In a call each side talks on its own clock, nothing is a reply to anything, so nothing waits for what was heard. Its notes go here. */
  notes: Note[],
  state = newFlow(),
  /** What has not set off by this visual second is left out, for the traffic after it. */
  until = Infinity,
): { packets: FlowPacket[]; waits: FlowWait[]; rest: Trip[] } {
  const delay = new Map(story.links.map((l) => [l.id, l.delay]));
  const { heard, lastSent, filled, sent, expected, onCable } = state;
  const waits: FlowWait[] = [];
  const wait = (step: WaitStep, t0: number): number => {
    const t1 = t0 + FLOW_TIMER;
    waits.push({ step, t0, t1 });
    cues.push({ t: t1 - 0.5, sound: 'surprise' });
    return t1;
  };
  /** When the last packet so far came off the cables. */
  let settled = from;
  const plan = (trip: Trip, start: number): FlowPacket => {
    let t = start;
    const sender = `${trip.client}|${trip.origin}`;
    const key = `${sender}|${trip.part?.n ?? trip.l4Label}`;
    const before = sent.get(key);
    sent.set(key, trip);
    if (trip.timedOut) {
      // A timer only runs out in silence: nothing is on its way any more.
      t = wait({ kind: 'wait', device: trip.origin, seconds: trip.waited ?? 0, giveUp: false, mood: before?.retry && before.lost ? 'angry' : 'surprise' }, Math.max(t, settled));
    }
    const hops: FlowHop[] = [];
    for (const s of trip.steps) {
      if (s.kind !== 'travel' && s.kind !== 'lost') continue;
      const lost = s.kind === 'lost';
      // Each way along a cable is one frame at a time: a block waits its turn at the device before it.
      const way = `${s.link}|${s.from}`;
      const taken = onCable.get(way) ?? [];
      onCable.set(way, taken);
      if (state.queued) t = freeSlot(taken, t);
      taken.push(t);
      // Cut under it by the viewer: where it was. Dropped off a full port buffer: right at the router. Lost by itself: halfway along.
      const caught = knocks.get(crossingKey(trip.packetId, s.link, crossingOf(trip, s)));
      const fall = lost ? (caught ?? (trip.droppedAtQueue ? 0.08 : 0.5)) : 1;
      const d = hop * linkPace(s.link) * fall;
      hops.push({ from: s.from, to: s.to, link: s.link, at: s.at, t0: t, t1: t + d, lost, fall, seen: s.seen });
      t += d;
      if (lost) cues.push({ t, sound: 'thud' });
    }
    const t0 = hops[0]?.t0 ?? t;
    lastSent.set(sender, t0);
    settled = Math.max(settled, t);
    const last = hops[hops.length - 1];
    if (trip.lost || !last) return { trip, hops, t0, t1: t + FLOW_FALL, landed: null };
    heard.push({ client: trip.client, sim: last.at + (delay.get(last.link) ?? 0), v: t });
    if (!trip.part) return { trip, hops, t0, t1: t, landed: null };
    if (trip.chapter === 'call') {
      const heardBy = last.to === trip.client ? 'caller' : 'friend';
      // The listener only finds out about a lost packet now, from the number on this one. Nothing comes back for it.
      const first = expected.get(sender) ?? 1;
      for (let m = first; m < Math.min(trip.part.n, first + BROKEN_SHOWN); m++) {
        const lost = sent.get(`${sender}|${m}`)?.audio;
        const at = t + (m - first) * 0.12;
        notes.push({ t: at, device: last.to, ...((lost && toneOf(lost)) ?? UNKNOWN_TONE), broken: true, heardBy });
        cues.push({ t: at, sound: 'break' });
      }
      expected.set(sender, trip.part.n + 1);
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
    if (odd && !state.puzzled) reactions.push({ t: landed, device: trip.client, face: 'confused' });
    state.puzzled = odd;
    if (fresh && filled.size === trip.part.of) {
      reactions.push({ t: landed, device: trip.client, face: 'love' });
      cues.push({ t: landed, sound: 'chime' });
    }
    return { trip, hops, t0, t1: landed, landed };
  };
  const planned: FlowPacket[] = [];
  const rest: Trip[] = [];
  /** Whoever has been left out from here on: a side of a call on its own clock, or a whole job, where everything answers something. */
  const stopped = new Set<string>();
  for (const trip of packets) {
    const sender = `${trip.client}|${trip.origin}`;
    const chain = trip.chapter === 'call' ? sender : trip.client;
    let t = Math.max(from, (lastSent.get(sender) ?? -Infinity) + FLOW_GAP, state.dropped.get(trip.client) ?? -Infinity);
    // In a call each side's first word still waits for what it answers (the friend speaks only once called); after that
    // a side talks on its own clock. An attacker's junk and knocks answer nothing either, and go at their own pace.
    const ownClock = trip.chapter === 'call' ? trip.part?.n !== 1 : trip.chapter === 'attack' && trip.outward && !trip.l4Label.includes('RST');
    const seen = state.started.get(trip.packetId);
    if (seen !== undefined) t = Math.max(t, seen);
    else if (!ownClock) for (const h of heard) if (h.client === trip.client && h.sim <= trip.start) t = Math.max(t, h.v);
    if (t > until || stopped.has(chain)) {
      stopped.add(chain);
      rest.push(trip);
    } else planned.push(plan(trip, t));
  }
  const last = planned[planned.length - 1];
  const part = last?.trip.part;
  if (!rest.length && last?.trip.chapter !== 'call' && last?.trip.lost && part && filled.size < part.of) wait({ kind: 'wait', device: last.trip.origin, seconds: 0, giveUp: true, mood: 'cry' }, last.t1);
  // Among other jobs' traffic the last packet needn't be the client's, and a fetch can die before there are parts to count.
  const mine = state.queued && !rest.length ? planned.filter((p) => p.trip.client === story.client).at(-1) : undefined;
  if (mine?.trip.lost && !mine.trip.part && mine.trip.l4Label !== 'ACK' && mine.trip.chapter !== 'call' && !story.probe && !story.reading && !story.fetched.includes(story.client)) {
    wait({ kind: 'wait', device: story.client, seconds: 0, giveUp: true, mood: 'cry' }, mine.t1);
  }
  return { packets: planned, waits, rest };
}

/**
 * How the receiver feels about what just arrived. Thumbs up for a reply it was waiting for (and the ACK that
 * finishes the hello); love when the page is complete; confused by a duplicate, or by a part that turns up while an
 * earlier one is still missing. Requests (a question, SYN, GET) get no reaction.
 */
function arrivalFace(trip: Trip, device: string, arrived: Set<string>, filled: Set<number>): Face | null {
  if (trip.quiet) return null;
  if (trip.l4Label.includes('RST')) return 'confused';
  // The same words from someone else are news: each router says "TTL ran out".
  const key = `${device}|${trip.chapter}|${trip.from}|${trip.card ?? trip.l4Label}|${trip.part?.n ?? 0}`;
  if (arrived.has(key)) return 'confused';
  arrived.add(key);
  if (trip.part) {
    filled.add(trip.part.n);
    if (filled.size === trip.part.of) return 'love';
    for (let m = 1; m < trip.part.n; m++) if (!filled.has(m)) return 'confused';
    return 'thumbs';
  }
  if (trip.chapter === 'page' && !trip.outward) return trip.message?.kind === 'mqtt-control' ? 'thumbs' : 'love';
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

/**
 * How far into its lane a block is, a share k through a hop, from none at the devices to all of it on the cable. It goes by
 * how far the block has really come, not by the clock: a block slows down as it arrives, and a lane timed by the clock
 * would still be sliding it sideways once it had all but stopped.
 */
export function laneShare(k: number): number {
  const came = easeInOut(k);
  return smooth(Math.min(came, 1 - came) / LANE_IN);
}

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
/** How long a phone is on a call: from when it first hears the other side until the call is over, for both at once. A phone that hears nothing is on no call. */
export function callSpan(tl: Timeline, device: string): { from: number; to: number; heardBy: Note['heardBy'] } | null {
  const heard = tl.notes.filter((n) => n.device === device);
  if (!heard.length) return null;
  return { from: Math.min(...heard.map((n) => n.t)), to: Math.max(...tl.notes.map((n) => n.t)), heardBy: heard[0]!.heardBy };
}

export function chapterAt(tl: Timeline, v: number): Trip['chapter'] | null {
  if (v < 0 || !tl.segs.length) return null;
  return (segAt(tl, v)?.seg ?? tl.segs[tl.segs.length - 1]!).trip.chapter;
}

/** A frame crossing a cable, by itself or as one of a stream. */
export interface Crossing {
  trip: Trip;
  link: string;
  /** Which of this packet's crossings of this link, from 0. */
  crossing: number;
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
      if (s.flow) return s.flow.flatMap((p) => p.hops.map((h) => ({ trip: p.trip, link: h.link, crossing: 0, at: h.at, t0: h.t0, t1: h.t1, lost: h.lost, seen: h.seen })));
      if (st.kind !== 'travel' && st.kind !== 'lost') return [];
      return [{ trip: s.trip, link: st.link, crossing: 0, at: st.at, t0: s.t0, t1: s.t1, lost: st.kind === 'lost', seen: st.seen }];
    });
    const counted = new Map<string, number>();
    for (const c of [...list].sort((a, b) => a.at - b.at)) {
      const key = `${c.trip.packetId}@${c.link}`;
      c.crossing = counted.get(key) ?? 0;
      counted.set(key, c.crossing + 1);
    }
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

/** What a run has shown so far, which a mended cable must not take back: the rings of those who gave up, and when each packet set off. */
export interface Past {
  rung: ReadonlySet<string>;
  started: ReadonlyMap<string, number>;
}
export const NO_PAST: Past = { rung: new Set(), started: new Map() };

/** What has been shown by visual time v, on top of what had been before. */
export function pastAt(tl: Timeline, v: number, before: Past): Past {
  const rung = new Set(before.rung);
  const started = new Map(before.started);
  for (const s of tl.segs) {
    if (s.step.kind === 'wait' && s.step.giveUp && s.t0 <= v) rung.add(s.trip.packetId);
    for (const p of s.flow ?? []) if (p.t0 <= v && !started.has(p.trip.packetId)) started.set(p.trip.packetId, p.t0);
  }
  return { rung, started };
}

/**
 * Everything already seen at visual time v: every frame that has set off on a cable (and whether it was lost), and the
 * sim time a change on `line` applies from: the latest among them, or earlier if a frame still to come on that line was
 * sent before that, as in a stream, which spreads microseconds out into seconds. Cutting or mending a cable mid-run keeps the
 * frames seen as they were and only affects the rest, so the picture so far never changes.
 */
export function seenSoFar(tl: Timeline, v: number, line?: string): { decided: Record<string, boolean>; now: number } {
  const decided: Record<string, boolean> = {};
  let now = tl.startsAt;
  let next = Infinity;
  for (const c of crossings(tl)) {
    if (c.t0 > v) {
      if (c.link === line) next = Math.min(next, c.at);
      continue;
    }
    decided[crossingKey(c.trip.packetId, c.link, c.crossing)] = c.lost;
    now = Math.max(now, c.at);
  }
  return { decided, now: Math.min(now, next) };
}

/** When a card dropped in at v starts, in sim time: just after the last thing on screen, which must go first. */
export const joinAt = (tl: Timeline, v: number): number => seenSoFar(tl, v).now + 1e-9;

/** The packets on a line at v and how far along they are, for a cut to catch; one nearly across gets there. */
export function ridingOn(tl: Timeline, v: number, line: string): { packetId: string; crossing: number; k: number }[] {
  return crossings(tl).flatMap((c) => {
    if (c.link !== line || c.lost || v < c.t0 || v >= c.t1) return [];
    const k = (v - c.t0) / (c.t1 - c.t0);
    // Still dropping out of its tray: it falls as it reaches the cable.
    return k > 0.9 ? [] : [{ packetId: c.trip.packetId, crossing: c.crossing, k: Math.max(k, 0.12) }];
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
