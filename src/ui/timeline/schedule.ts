import type { LayerNum, NatEntry, SimEvent, SimResult, TcpState, TimerKind } from '../../sim';
import { PROTO_ROW } from '../content/layers';
import { SpeechWriter, type Tone } from '../content/speech';
import { machineFor, type MachineKind } from '../iso/machines/Machine';

/**
 * Turns a SimResult into a visual schedule. "v" is visual time in seconds at 1× speed; the scene is a pure
 * function of v, which makes pause, scrub and step-back trivial.
 */

export type KfMode = 'appear' | 'encap' | 'decap' | 'change' | 'tx' | 'rx';

export interface Keyframe {
  v0: number;
  v1: number;
  mode: KfMode;
  /** PDU shown once this keyframe completes. */
  pduId: string;
  row: LayerNum;
  fromRow: LayerNum;
  /** PDU shown during the transition for decap/tx (the outer one being unwrapped). */
  fromPduId?: string;
  /** Byte indices that changed (forward / NAT). */
  diff?: number[];
  seq: number;
  /** For tx/rx: which interface. */
  iface?: string;
}

export type TrackEnd = 'tx' | 'absorb' | 'consume' | 'drop' | 'final';

export interface Track {
  id: string;
  packetId: string;
  deviceId: string;
  kfs: Keyframe[];
  end: number;
  endKind: TrackEnd;
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
  toIface: string;
  v0: number;
  v1: number;
  lostAt?: number;
  wireBytes: number;
}

export interface Bubble {
  seq: number;
  v0: number;
  v1: number;
  deviceId: string;
  machine: MachineKind;
  iface?: string;
  text: string;
  tone: Tone;
  important: boolean;
}

/** A machine doing something: drives its pose. */
export interface Act {
  seq: number;
  v0: number;
  v1: number;
  deviceId: string;
  machine: MachineKind;
  iface?: string;
  event: SimEvent;
}

export interface TimerSpan {
  deviceId: string;
  kind: TimerKind;
  v0: number;
  v1: number;
  seconds: number;
  fired: boolean;
}

export interface Skip {
  v0: number;
  v1: number;
  dt: number;
}

export interface TcpSpan {
  deviceId: string;
  connId: string;
  packetId: string;
  label: string;
  relSeq: number;
  len: number;
  sentV: number;
  ackedV: number;
  retxV?: number;
}

export type GateAction = 'press-arp' | 'drag-cell' | 'pull-lever';

export interface Gate {
  id: string;
  v: number;
  kind: 'bubble' | 'operator';
  seq: number;
  deviceId: string;
  machine: MachineKind;
  iface?: string;
  action?: GateAction;
  hint: string;
}

export interface DeviceState {
  arp: { ip: string; mac: string }[];
  nat: NatEntry[];
  tcpState?: TcpState;
  outstanding: TcpSpan[];
  timer?: { kind: TimerKind; fraction: number; remaining: number };
  route?: { dst: string; nextHop: string; outIface: string };
  dnsAnswer?: string[];
  pageReady: boolean;
}

export interface Schedule {
  result: SimResult;
  duration: number;
  tracks: Track[];
  flights: Flight[];
  bubbles: Bubble[];
  acts: Act[];
  timers: TimerSpan[];
  skips: Skip[];
  tcpStates: { v: number; deviceId: string; state: TcpState }[];
  tcpSpans: TcpSpan[];
  gates: Gate[];
  eventV: number[];
  /** Visual spans during which something is inside each device (its floors light up). */
  busySpans: Map<string, [number, number][]>;
  simTimeAt(v: number): number;
  deviceStateAt(deviceId: string, v: number): DeviceState;
}

const BASE_COST: Record<SimEvent['type'], number> = {
  app: 1.1,
  encapsulate: 0.9,
  decapsulate: 0.75,
  'arp:miss': 0.9,
  'arp:hit': 0.3,
  'arp:learn': 0.7,
  route: 0.7,
  forward: 0.85,
  'nat:add': 1.0,
  'nat:translate': 1.0,
  tx: 0.55,
  rx: 0.5,
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

function gapCost(dt: number): number {
  if (dt < 2e-4) return 0;
  return Math.min(2.4, 0.25 + 0.45 * Math.log10(dt / 2e-4));
}

function rowOf(first: string): LayerNum {
  return PROTO_ROW[first as keyof typeof PROTO_ROW] ?? 2;
}

export function flightDuration(wireBytes: number, linkId: string, count: number): number {
  const base = linkId === 'lan' ? 1.3 : 1.6;
  const size = 0.2 * Math.log2(Math.max(1, wireBytes / 72));
  const fam = count < 6 ? 1 : 0.8;
  return (base + size) * fam;
}

export function buildSchedule(result: SimResult): Schedule {
  const writer = new SpeechWriter(result);
  const sc = result.scenario;
  const kindOf = (id: string) => sc.devices.find((d) => d.id === id)?.kind ?? 'laptop';
  const tracks: Track[] = [];
  const flights: Flight[] = [];
  const bubbles: Bubble[] = [];
  const acts: Act[] = [];
  const timers: TimerSpan[] = [];
  const skips: Skip[] = [];
  const tcpStates: Schedule['tcpStates'] = [];
  const tcpSpans: TcpSpan[] = [];
  const gates: Gate[] = [];
  const arpLearns: { v: number; deviceId: string; ip: string; mac: string }[] = [];
  const natAdds: { v: number; deviceId: string; entry: NatEntry }[] = [];
  const routes: { v: number; deviceId: string; dst: string; nextHop: string; outIface: string }[] = [];
  const dnsAnswers: { v: number; deviceId: string; ips: string[] }[] = [];
  let pageReadyV = Infinity;
  let pageDevice = '';
  const eventV: number[] = [];
  const openTrack = new Map<string, Track>();
  const lastIncoming = new Map<string, Track>();
  const streamAt = new Map<string, Track>();
  const lastTouch = new Map<Track, number>();
  const pendingFlights = new Map<string, Flight>();
  const timerById = new Map<string, TimerSpan>();
  const seenCount = new Map<string, number>();
  const operatorDone = new Set<GateAction>();
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
    if (e.type === 'encapsulate' || e.type === 'decapsulate') dur *= familiarity(`${e.type}:${e.protocol}:${e.deviceId}`);
    else if (e.type !== 'tx' && e.type !== 'rx') dur *= familiarity(`${e.type}:${'deviceId' in e ? e.deviceId : ''}`);
    if (e.type === 'timer:set' && e.kind === 'tcp-rto') dur = Math.min(dur, 0.25);
    if (e.type === 'arp:miss') {
      const k = `arpmiss:${e.deviceId}:${e.ip}`;
      if (seenCount.get(k)) dur = 0.15;
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

    // ── speech + acts ──
    const deviceId = 'deviceId' in e ? e.deviceId : e.type === 'tx' ? e.fromDevice : undefined;
    const iface = e.type === 'tx' ? e.fromIface : e.type === 'rx' ? e.iface : undefined;
    if (deviceId) {
      const m = machineFor(e, kindOf(deviceId));
      if (m) acts.push({ seq: e.seq, v0, v1, deviceId, machine: m, iface, event: e });
      const s = writer.speak(e);
      if (s) {
        const hold = Math.max(dur, 1.3 + 0.045 * s.text.length);
        const prev = bubbles[bubbles.length - 1];
        if (prev && prev.deviceId === deviceId && prev.v1 > v0) prev.v1 = v0; // superseded
        bubbles.push({ seq: e.seq, v0, v1: v0 + hold, deviceId, machine: s.machine, iface: s.iface ?? iface, text: s.text, tone: s.tone, important: s.important });
      }
    }

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
            if (e.deviceId === sc.startDevice && !operatorDone.has('drag-cell')) {
              operatorDone.add('drag-cell');
              gates.push({ id: `g${e.seq}`, v: v0, kind: 'operator', seq: e.seq, deviceId: e.deviceId, machine: 'tcpClerk', action: 'drag-cell', hint: 'Drag the data cell into the TCP chassis' });
            }
          }
        } else {
          const prev = lastKf(t)!;
          t.kfs.push({ v0, v1, mode: 'encap', pduId: e.pduId, row, fromRow: prev.row, seq: e.seq });
        }
        if (e.protocol === 'tcp' && pk?.tcp) {
          const syn = pk.tcp.flags & 0x02 ? 1 : 0;
          const fin = pk.tcp.flags & 0x01 ? 1 : 0;
          const len = pk.tcp.len + syn + fin;
          if (len > 0 && !pk.retransmitOf) tcpSpans.push({ deviceId: e.deviceId, connId: pk.tcp.connId, packetId: pk.id, label: pk.label, relSeq: pk.tcp.relSeq, len, sentV: v0, ackedV: Infinity });
          if (pk.retransmitOf) {
            const orig = tcpSpans.find((s) => s.packetId === pk.retransmitOf);
            if (orig) orig.retxV = v0;
          }
        }
        if (e.protocol === 'arp' && e.deviceId === sc.startDevice && !operatorDone.has('press-arp')) {
          operatorDone.add('press-arp');
          gates.push({ id: `g${e.seq}`, v: v0, kind: 'operator', seq: e.seq, deviceId: e.deviceId, machine: 'linkStation', action: 'press-arp', hint: 'Press the megaphone to ask the LAN' });
        }
        break;
      }
      case 'tx': {
        const t = openTrack.get(`${e.packetId}@${e.fromDevice}`);
        if (t) {
          const prev = lastKf(t)!;
          t.kfs.push({ v0, v1, mode: 'tx', pduId: e.frameId, fromPduId: prev.pduId, row: 1, fromRow: prev.row, seq: e.seq, iface: e.fromIface });
          closeTrack(t, v1, 'tx');
        }
        const f: Flight = { id: `fl${e.seq}`, seq: e.seq, packetId: e.packetId, frameId: e.frameId, linkId: e.linkId, from: e.fromDevice, to: e.toDevice, fromIface: e.fromIface, toIface: e.toIface, v0: v1, v1: v1 + 1, wireBytes: e.wireBytes };
        flightCount++;
        flights.push(f);
        pendingFlights.set(e.frameId, f);
        if (e.fromDevice === sc.startDevice && !operatorDone.has('pull-lever')) {
          operatorDone.add('pull-lever');
          gates.push({ id: `g${e.seq}`, v: v0, kind: 'operator', seq: e.seq, deviceId: e.fromDevice, machine: 'port', iface: e.fromIface, action: 'pull-lever', hint: 'Pull the lever to send the bits' });
        }
        break;
      }
      case 'rx': {
        const t = newTrack(e.packetId, e.deviceId);
        t.kfs.push({ v0, v1, mode: 'rx', pduId: e.frameId, row: 2, fromRow: 1, seq: e.seq, iface: e.iface });
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
        // An incoming ACK closes spans on this device.
        if (pdu?.first === 'tcp') {
          const pk = packets.get(e.packetId);
          if (pk?.tcp && pk.tcp.flags & 0x10) {
            for (const s of tcpSpans) {
              if (s.deviceId === e.deviceId && s.ackedV === Infinity && s.relSeq + s.len <= pk.tcp.relAck) s.ackedV = v0;
            }
          }
        }
        break;
      }
      case 'forward':
      case 'nat:translate': {
        const t = openTrack.get(`${e.packetId}@${e.deviceId}`);
        if (!t) break;
        const prev = lastKf(t)!;
        t.kfs.push({ v0, v1, mode: 'change', pduId: e.pduId, fromPduId: prev.pduId, row: 3, fromRow: prev.row, diff: diffBytes(prev.pduId, e.pduId), seq: e.seq });
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
          for (const t of openTrack.values()) {
            if (t.deviceId === e.deviceId && lastKf(t)?.row === 5 && !t.isStream && e.action === 'dns-answer') closeTrack(t, v1, 'absorb');
          }
          const inc = lastIncoming.get(e.deviceId);
          if (inc && e.action === 'dns-serve') closeTrack(inc, v1, 'absorb');
          if (e.action === 'dns-answer') dnsAnswers.push({ v: v0, deviceId: e.deviceId, ips: (e.info?.addresses as string[]) ?? [] });
        }
        if ((e.action === 'http-request-received' || e.action === 'http-response-received') && e.pduId) {
          const pdu = pdus.get(e.pduId)!;
          const t = newTrack(pdu.packetId, e.deviceId, true);
          t.kfs.push({ v0, v1, mode: 'appear', pduId: e.pduId, row: 5, fromRow: 5, seq: e.seq });
          if (e.action === 'http-request-received') closeTrack(t, v1 + 1.6, 'absorb');
          else {
            closeTrack(t, Infinity, 'final');
            pageReadyV = v1;
            pageDevice = e.deviceId;
          }
        }
        break;
      }
      case 'arp:learn':
        arpLearns.push({ v: v0, deviceId: e.deviceId, ip: e.ip, mac: e.mac });
        break;
      case 'nat:add':
        natAdds.push({ v: v0, deviceId: e.deviceId, entry: e.entry });
        break;
      case 'route':
        routes.push({ v: v0, deviceId: e.deviceId, dst: e.dst, nextHop: e.nextHop, outIface: e.outIface });
        break;
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
      t.end = Math.max(lk?.v1 ?? 0, lastTouch.get(t) ?? 0) + 0.5;
      t.endKind = 'consume';
    }
    if (t.end === Infinity) t.end = duration + 100;
  }
  for (const f of pendingFlights.values()) f.v1 = f.v0 + 1.5;
  for (const s of timers) if (s.v1 === Infinity) s.v1 = duration;
  for (const s of tcpSpans) if (s.ackedV === Infinity) s.ackedV = duration;

  // Bubble gates (one per bubble) + operator gates, sorted.
  for (const b of bubbles) gates.push({ id: `b${b.seq}`, v: b.v0 + 0.3, kind: 'bubble', seq: b.seq, deviceId: b.deviceId, machine: b.machine, iface: b.iface, hint: '' });
  gates.sort((a, b) => a.v - b.v || a.seq - b.seq);

  const busySpans = new Map<string, [number, number][]>();
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
    busySpans.set(dev, merged);
  }

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

  const seeds = new Map<string, { ip: string; mac: string }[]>();
  for (const d of sc.devices) seeds.set(d.id, Object.entries(d.arp ?? {}).map(([ip, mac]) => ({ ip, mac })));

  const deviceStateAt = (deviceId: string, v: number): DeviceState => {
    const arp = [...(seeds.get(deviceId) ?? [])];
    for (const a of arpLearns) if (a.deviceId === deviceId && a.v <= v && !arp.some((x) => x.ip === a.ip)) arp.push({ ip: a.ip, mac: a.mac });
    const nat = natAdds.filter((n) => n.deviceId === deviceId && n.v <= v).map((n) => n.entry);
    let tcpState: TcpState | undefined;
    for (const s of tcpStates) if (s.deviceId === deviceId && s.v <= v) tcpState = s.state;
    const outstanding = tcpSpans.filter((s) => s.deviceId === deviceId && s.sentV <= v && v < s.ackedV);
    let timer: DeviceState['timer'];
    for (const t of timers) {
      if (t.deviceId === deviceId && t.v0 <= v && v < t.v1) {
        const elapsed = simTimeAt(v) - simTimeAt(t.v0);
        timer = { kind: t.kind, fraction: Math.max(0, Math.min(1, elapsed / t.seconds)), remaining: Math.max(0, t.seconds - elapsed) };
      }
    }
    let route: DeviceState['route'];
    for (const r of routes) if (r.deviceId === deviceId && r.v <= v) route = r;
    let dnsAnswer: string[] | undefined;
    for (const d of dnsAnswers) if (d.deviceId === deviceId && d.v <= v) dnsAnswer = d.ips;
    return { arp, nat, tcpState, outstanding, timer, route, dnsAnswer, pageReady: deviceId === pageDevice && v >= pageReadyV };
  };

  return { result, duration, tracks, flights, bubbles, acts, timers, skips, tcpStates, tcpSpans, gates, eventV, busySpans, simTimeAt, deviceStateAt };
}
