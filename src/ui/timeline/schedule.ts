import type { LayerNum, SimEvent, SimResult, TimerKind } from '../../sim';
import { PROTO_ROW } from '../content/layers';
import { Narrator } from '../content/narration';

/**
 * Turns a SimResult into a visual schedule. "v" is visual time in seconds at 1× speed; the scene is a pure function
 * of v, which makes pause, scrub and step-back trivial.
 */

export type KfMode = 'appear' | 'encap' | 'decap' | 'change' | 'tx' | 'rx';

export interface Keyframe {
  v0: number;
  v1: number;
  mode: KfMode;
  /** PDU shown once this keyframe completes. */
  pduId: string;
  row: LayerNum;
  /** Where the strip was before (for movement). */
  fromRow: LayerNum;
  /** PDU shown during the transition for decap/tx (the outer one being unwrapped). */
  fromPduId?: string;
  /** Byte indices that changed (forward / NAT). */
  diff?: number[];
  seq: number;
}

export type TrackEnd = 'tx' | 'absorb' | 'consume' | 'drop' | 'final';

export interface Track {
  id: string;
  packetId: string;
  deviceId: string;
  kfs: Keyframe[];
  end: number;
  endKind: TrackEnd;
  /** Stream tracks: bytes handed to TCP over time. */
  consumed?: { v: number; bytes: number }[];
  isStream?: boolean;
}

export interface Flight {
  id: string;
  seq: number;
  packetId: string;
  frameId: string;
  linkId: string;
  from: string;
  to: string;
  fromIface: string;
  v0: number;
  v1: number;
  /** Set if the frame is lost: it fizzles at this v. */
  lostAt?: number;
  wireBytes: number;
}

export interface Badge {
  deviceId: string;
  text: string;
  tone: 'info' | 'good' | 'warn' | 'bad';
  v0: number;
  v1: number;
}

export interface Beat {
  v: number;
  /** When this beat's own animation is finished. */
  v1: number;
  seq: number;
  caption: string;
  deviceId?: string;
  flightId?: string;
}

export interface TimerSpan {
  deviceId: string;
  kind: TimerKind;
  v0: number;
  v1: number;
  /** Sim seconds the timer was set for. */
  seconds: number;
  fired: boolean;
}

export interface Skip {
  v0: number;
  v1: number;
  dt: number;
}

export interface Schedule {
  result: SimResult;
  duration: number;
  tracks: Track[];
  flights: Flight[];
  badges: Badge[];
  beats: Beat[];
  timers: TimerSpan[];
  skips: Skip[];
  tcpStates: { v: number; deviceId: string; state: string }[];
  /** Visual start time of every event, indexed by seq. */
  eventV: number[];
  cardSpans: Map<string, [number, number][]>;
  simTimeAt(v: number): number;
}

const BASE_COST: Record<SimEvent['type'], number> = {
  app: 1.1,
  encapsulate: 0.8,
  decapsulate: 0.7,
  'arp:miss': 0.9,
  'arp:hit': 0.3,
  'arp:learn': 0.7,
  route: 0.6,
  forward: 0.85,
  'nat:add': 1.0,
  'nat:translate': 0.95,
  tx: 0.5,
  rx: 0.45,
  drop: 1.0,
  'timer:set': 0.35,
  'timer:cancel': 0.05,
  'timer:fire': 0.8,
  'tcp:state': 0.6,
  'tcp:retransmit': 0.7,
  'tcp:dup-ack': 0.5,
  'tcp:ooo': 0.7,
  'tcp:duplicate': 0.6,
  'tcp:deliver': 0.5,
  'tcp:rtt': 0.05,
};

/** Sim-time gap → visual seconds, for idle periods with nothing in flight. */
function gapCost(dt: number): number {
  if (dt < 2e-4) return 0;
  return Math.min(2.4, 0.25 + 0.45 * Math.log10(dt / 2e-4));
}

function rowOf(first: string): LayerNum {
  return PROTO_ROW[first as keyof typeof PROTO_ROW] ?? 2;
}

export function buildSchedule(result: SimResult): Schedule {
  const narrator = new Narrator(result);
  const tracks: Track[] = [];
  const flights: Flight[] = [];
  const badges: Badge[] = [];
  const beats: Beat[] = [];
  const timers: TimerSpan[] = [];
  const skips: Skip[] = [];
  const tcpStates: Schedule['tcpStates'] = [];
  const eventV: number[] = [];
  const openTrack = new Map<string, Track>(); // `${packetId}@${deviceId}` → track
  const lastIncoming = new Map<string, Track>(); // deviceId → track currently being processed there
  const streamAt = new Map<string, Track>(); // deviceId → stream track being cut into segments
  const lastTouch = new Map<Track, number>();
  const pendingFlights = new Map<string, Flight>(); // frameId → flight
  const timerById = new Map<string, TimerSpan>();
  const seenCount = new Map<string, number>();
  let cursor = 0;
  let lastT = 0;
  let flightCount = 0;

  const pdus = result.pdus;
  const packets = result.packets;

  const familiarity = (key: string): number => {
    const n = (seenCount.get(key) ?? 0) + 1;
    seenCount.set(key, n);
    return n <= 2 ? 1 : n <= 5 ? 0.75 : 0.55;
  };

  const newTrack = (packetId: string, deviceId: string, isStream = false): Track => {
    const t: Track = { id: `tr${tracks.length}`, packetId, deviceId, kfs: [], end: Infinity, endKind: 'consume', isStream };
    tracks.push(t);
    openTrack.set(`${packetId}@${deviceId}`, t);
    return t;
  };

  const lastKf = (t: Track): Keyframe | undefined => t.kfs[t.kfs.length - 1];

  const closeTrack = (t: Track, v: number, kind: TrackEnd): void => {
    if (t.end !== Infinity) return;
    t.end = v;
    t.endKind = kind;
    openTrack.delete(`${t.packetId}@${t.deviceId}`);
    if (lastIncoming.get(t.deviceId) === t) lastIncoming.delete(t.deviceId);
  };

  const diffBytes = (a?: string, b?: string): number[] => {
    const A = a ? pdus.get(a)?.bytes : undefined;
    const B = b ? pdus.get(b)?.bytes : undefined;
    if (!A || !B) return [];
    const out: number[] = [];
    for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) out.push(i);
    return out;
  };

  for (const e of result.events) {
    // ── time warp ──
    const dt = e.t - lastT;
    if (dt > 0 && pendingFlights.size === 0) {
      const g = gapCost(dt);
      if (dt >= 0.05) skips.push({ v0: cursor, v1: cursor + g, dt });
      cursor += g;
    }
    lastT = e.t;

    let dur = BASE_COST[e.type];
    if (e.type === 'encapsulate' || e.type === 'decapsulate') {
      dur *= familiarity(`${e.type}:${e.protocol}:${e.deviceId}`);
    } else if (e.type !== 'tx' && e.type !== 'rx') {
      dur *= familiarity(`${e.type}:${'deviceId' in e ? e.deviceId : ''}`);
    }
    if (e.type === 'timer:set' && e.kind === 'tcp-rto') dur = Math.min(dur, 0.25);
    if (e.type === 'arp:miss') {
      const k = `arpmiss:${e.deviceId}:${e.ip}`;
      if (seenCount.get(k)) dur = 0.15; // further packets just join the queue
      seenCount.set(k, 1);
    }

    let v0 = cursor;
    if (e.type === 'rx') {
      const f = pendingFlights.get(e.frameId);
      if (f) {
        v0 = Math.max(v0, f.v0 + flightDuration(f.wireBytes, f.linkId, flightCount));
        f.v1 = v0;
        pendingFlights.delete(e.frameId);
      }
    }
    if (e.type === 'drop' && e.reason === 'fault' && e.frameId) {
      const f = pendingFlights.get(e.frameId);
      if (f) {
        v0 = Math.max(v0, f.v0 + flightDuration(f.wireBytes, f.linkId, flightCount) * 0.5);
        f.lostAt = v0;
        f.v1 = v0 + dur;
        pendingFlights.delete(e.frameId);
      }
    }
    const v1 = v0 + dur;
    eventV[e.seq] = v0;
    cursor = v1;

    // ── narration ──
    const n = narrator.narrate(e);
    const deviceId = 'deviceId' in e ? e.deviceId : e.type === 'tx' ? e.fromDevice : undefined;
    if (n.caption) beats.push({ v: v0, v1, seq: e.seq, caption: n.caption, deviceId, flightId: e.type === 'tx' ? `fl${e.seq}` : undefined });
    if (n.badge && deviceId) badges.push({ deviceId, text: n.badge, tone: n.tone ?? 'info', v0, v1: v0 + Math.max(dur, 1.8) });

    // ── tracks / flights ──
    switch (e.type) {
      case 'encapsulate': {
        const pk = packets.get(e.packetId);
        const row = rowOf(e.protocol);
        let t = openTrack.get(`${e.packetId}@${e.deviceId}`);
        if (pk?.kind === 'stream') {
          t = newTrack(e.packetId, e.deviceId, true);
          t.consumed = [];
          t.kfs.push({ v0, v1, mode: 'appear', pduId: e.pduId, row: 5, fromRow: 5, seq: e.seq });
          streamAt.set(e.deviceId, t);
          break;
        }
        if (!t) {
          t = newTrack(e.packetId, e.deviceId);
          // A TCP data segment is cut from the application's stream one row above; everything else starts here.
          const fromStream = pk?.kind === 'tcp' && (pk.tcp?.len ?? 0) > 0 && !pk.retransmitOf;
          const fromRow: LayerNum = fromStream ? 5 : row;
          t.kfs.push({ v0, v1, mode: 'encap', pduId: e.pduId, row, fromRow, seq: e.seq });
          if (fromStream) {
            const s = streamAt.get(e.deviceId);
            if (s?.consumed) {
              const prev = s.consumed[s.consumed.length - 1]?.bytes ?? 0;
              const total = prev + (pk.tcp?.len ?? 0);
              s.consumed.push({ v: v0, bytes: total });
              const full = pdus.get(s.kfs[0]!.pduId)?.bytes.length ?? 0;
              if (total >= full) closeTrack(s, v1, 'consume');
            }
          }
        } else {
          const prev = lastKf(t)!;
          t.kfs.push({ v0, v1, mode: 'encap', pduId: e.pduId, row, fromRow: prev.row, seq: e.seq });
        }
        break;
      }
      case 'tx': {
        const t = openTrack.get(`${e.packetId}@${e.fromDevice}`);
        if (t) {
          const prev = lastKf(t)!;
          t.kfs.push({ v0, v1, mode: 'tx', pduId: e.frameId, fromPduId: prev.pduId, row: 1, fromRow: prev.row, seq: e.seq });
          closeTrack(t, v1, 'tx');
        }
        const f: Flight = {
          id: `fl${e.seq}`,
          seq: e.seq,
          packetId: e.packetId,
          frameId: e.frameId,
          linkId: e.linkId,
          from: e.fromDevice,
          to: e.toDevice,
          fromIface: e.fromIface,
          v0: v1,
          v1: v1 + 1,
          wireBytes: e.wireBytes,
        };
        flightCount++;
        flights.push(f);
        pendingFlights.set(e.frameId, f);
        break;
      }
      case 'rx': {
        const t = newTrack(e.packetId, e.deviceId);
        t.kfs.push({ v0, v1, mode: 'rx', pduId: e.frameId, row: 2, fromRow: 1, seq: e.seq });
        lastIncoming.set(e.deviceId, t);
        break;
      }
      case 'decapsulate': {
        const t = openTrack.get(`${e.packetId}@${e.deviceId}`);
        if (!t) break;
        const prev = lastKf(t)!;
        const pdu = pdus.get(e.pduId);
        const row = rowOf(pdu?.first ?? 'ethernet');
        t.kfs.push({ v0, v1, mode: 'decap', pduId: e.pduId, fromPduId: prev.pduId, row, fromRow: prev.row, seq: e.seq });
        break;
      }
      case 'forward':
      case 'nat:translate': {
        const t = openTrack.get(`${e.packetId}@${e.deviceId}`);
        if (!t) break;
        const prev = lastKf(t)!;
        t.kfs.push({
          v0,
          v1,
          mode: 'change',
          pduId: e.pduId,
          fromPduId: prev.pduId,
          row: 3,
          fromRow: prev.row,
          diff: diffBytes(prev.pduId, e.pduId),
          seq: e.seq,
        });
        break;
      }
      case 'drop': {
        if (e.deviceId) {
          const t = openTrack.get(`${e.packetId}@${e.deviceId}`);
          if (t) closeTrack(t, v1, 'drop');
        }
        break;
      }
      case 'tcp:deliver': {
        const t = openTrack.get(`${e.packetId}@${e.deviceId}`);
        if (t) closeTrack(t, v1, 'absorb');
        break;
      }
      case 'app': {
        if (e.action === 'dns-answer' || e.action === 'dns-serve') {
          // The DNS message has reached the application.
          for (const t of openTrack.values()) {
            if (t.deviceId === e.deviceId && lastKf(t)?.row === 5 && !t.isStream && e.action === 'dns-answer') closeTrack(t, v1, 'absorb');
          }
          const inc = lastIncoming.get(e.deviceId);
          if (inc && e.action === 'dns-serve') closeTrack(inc, v1, 'absorb');
        }
        if ((e.action === 'http-request-received' || e.action === 'http-response-received') && e.pduId) {
          const pdu = pdus.get(e.pduId)!;
          const t = newTrack(pdu.packetId, e.deviceId, true);
          t.kfs.push({ v0, v1, mode: 'appear', pduId: e.pduId, row: 5, fromRow: 5, seq: e.seq });
          if (e.action === 'http-request-received') closeTrack(t, v1 + 1.6, 'absorb');
          else closeTrack(t, Infinity, 'final');
        }
        break;
      }
      case 'timer:set': {
        const span: TimerSpan = { deviceId: e.deviceId, kind: e.kind, v0, v1: Infinity, seconds: e.fireAt - e.t, fired: false };
        timers.push(span);
        timerById.set(e.timerId, span);
        break;
      }
      case 'timer:cancel':
      case 'timer:fire': {
        const span = timerById.get(e.timerId);
        if (span) {
          span.v1 = v0;
          span.fired = e.type === 'timer:fire';
        }
        break;
      }
      case 'tcp:state':
        tcpStates.push({ v: v0, deviceId: e.deviceId, state: e.to });
        break;
    }

    // Keep the packet currently being processed at a device on screen while its consequences play out.
    if (deviceId) {
      const pkId = 'packetId' in e ? e.packetId : undefined;
      const t = (pkId && openTrack.get(`${pkId}@${deviceId}`)) || lastIncoming.get(deviceId);
      if (t) lastTouch.set(t, v1);
    }
  }

  const duration = cursor + 1.5;
  for (const t of tracks) {
    if (t.end === Infinity && t.endKind !== 'final') {
      const lk = lastKf(t);
      const touch = Math.max(lk?.v1 ?? 0, lastTouch.get(t) ?? 0);
      t.end = touch + 0.5;
      t.endKind = 'consume';
    }
    if (t.end === Infinity) t.end = duration + 100;
  }
  for (const f of pendingFlights.values()) f.v1 = f.v0 + 1.5;
  for (const s of timers) if (s.v1 === Infinity) s.v1 = duration;

  // Cards are open while something is inside them.
  const cardSpans = new Map<string, [number, number][]>();
  const raw = new Map<string, [number, number][]>();
  for (const t of tracks) {
    const v0 = t.kfs[0]?.v0 ?? 0;
    const list = raw.get(t.deviceId) ?? [];
    list.push([v0 - 0.45, Math.min(t.end, duration + 100) + 0.45]);
    raw.set(t.deviceId, list);
  }
  for (const [dev, spans] of raw) {
    spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + 1.2) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    cardSpans.set(dev, merged);
  }

  // Visual time → sim time, piecewise linear through event start times.
  const pts = result.events.map((e) => [eventV[e.seq]!, e.t] as const);
  const simTimeAt = (v: number): number => {
    if (!pts.length) return 0;
    let lo = 0;
    let hi = pts.length - 1;
    if (v <= pts[0]![0]) return pts[0]![1];
    if (v >= pts[hi]![0]) return pts[hi]![1];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]![0] <= v) lo = mid;
      else hi = mid;
    }
    const [va, ta] = pts[lo]!;
    const [vb, tb] = pts[hi]!;
    return vb > va ? ta + ((tb - ta) * (v - va)) / (vb - va) : ta;
  };

  return { result, duration, tracks, flights, badges, beats, timers, skips, tcpStates, eventV, cardSpans, simTimeAt };
}

function flightDuration(wireBytes: number, linkId: string, count: number): number {
  const base = linkId === 'lan' ? 1.15 : 1.45;
  const size = 0.18 * Math.log2(Math.max(1, wireBytes / 72));
  const fam = count < 6 ? 1 : 0.8;
  return (base + size) * fam;
}
