import type { Probe, Scan, Story, Trip } from './story';

/**
 * What ping and traceroute print, and when. A line goes up when the answer reaches the program, since that is when the
 * program knows; a probe nobody answered gets its star when the next one goes, or when the run ends.
 */
export interface Readout {
  /** What the terminal says from each moment on, oldest first. */
  screens: { t: number; lines: string[] }[];
  /** Traceroute: the hops found, each flagged on the device that answered. */
  flags: { t: number; device: string; text: string }[];
}

/** When a packet set off and when it was done, in visual seconds. */
export type Timing = ReadonlyMap<string, { t0: number; t1: number }>;

/** The last hop's address is at most this long: 255.255.255.255. */
const ADDRESS = 15;

const short = (ms: number): string => (ms < 1 ? '<1' : String(Math.round(ms)));
const long = (ms: number): string => (ms < 1 ? 'under 1 ms' : `${Math.round(ms)} ms`);

/** Every packet of the run, also those gathered into a flow. */
const packetsOf = (trips: Trip[]): Trip[] =>
  trips.flatMap((t) => {
    const flow = t.steps.find((s) => s.kind === 'flow');
    return flow?.kind === 'flow' ? flow.packets : [t];
  });

export function buildReadout(story: Story, client: string, probe: Probe | undefined, timing: Timing, total: number): Readout {
  if (!probe) return { screens: [], flags: [] };
  const title = `${probe.kind} ${probe.to}`;
  const trips = packetsOf(story.trips).filter((t) => t.client === client);
  const readout = probe.kind === 'ping' ? pingReadout(probe, title, trips, timing, total) : traceReadout(probe, title, trips, timing, total);
  // The name never turned into an address, so nothing went out.
  if (!readout.screens.length) readout.screens.push({ t: total, lines: [title, `can't find ${probe.to}`] });
  return readout;
}

function pingReadout(probe: Probe, title: string, trips: Trip[], timing: Timing, total: number): Readout {
  const tries = trips.filter((t) => t.outward && t.chapter === 'ping');
  const rows: string[] = [];
  const screens: Readout['screens'] = tries.length ? [{ t: timing.get(tries[0]!.packetId)?.t0 ?? 0, lines: [title] }] : [];
  tries.forEach((_, i) => {
    const reply = probe.replies.find((x) => x.seq === i + 1);
    const t = reply ? (timing.get(reply.packetId)?.t1 ?? total) : (timing.get(tries[i + 1]?.packetId ?? '')?.t0 ?? total);
    rows.push(`${i + 1}  ${reply ? `${short(reply.rttMs)} ms` : 'no reply'}`);
    screens.push({ t, lines: [title, ...rows] });
  });
  const done = probe.done;
  if (done && screens.length > 1) screens[screens.length - 1]!.lines.push(`${done.sent} sent, ${done.received} ${done.received === 1 ? 'reply' : 'replies'}${done.received ? `, average ${short(Number(done.avgMs))} ms` : ''}`);
  return { screens, flags: [] };
}

function traceReadout(probe: Probe, title: string, trips: Trip[], timing: Timing, total: number): Readout {
  const tries = trips.filter((t) => t.probeTtl !== undefined);
  const hops = new Map<number, { from: string; times: string[] }>();
  const flags: Readout['flags'] = [];
  const screens: Readout['screens'] = tries.length ? [{ t: timing.get(tries[0]!.packetId)?.t0 ?? 0, lines: [title] }] : [];
  const rows = (): string[] => [...hops].map(([ttl, h]) => (h.from ? `${ttl}  ${h.from.padEnd(ADDRESS)} ${h.times.map((x) => x.padStart(2)).join(' ')} ms` : `${ttl}  no reply`));
  tries.forEach((trip, i) => {
    const ttl = trip.probeTtl!;
    const row = hops.get(ttl) ?? { from: '', times: [] };
    hops.set(ttl, row);
    const hop = probe.hops.find((h) => h.ttl === ttl && h.probe === row.times.length + 1);
    const t = hop ? (timing.get(hop.packetId)?.t1 ?? total) : (timing.get(tries[i + 1]?.packetId ?? '')?.t0 ?? total);
    row.times.push(hop ? short(hop.rttMs) : '*');
    if (hop && !row.from) {
      row.from = hop.from;
      const answer = trips.find((x) => x.packetId === hop.packetId);
      if (answer) flags.push({ t, device: answer.origin, text: `${ttl} · ${hop.from} · ${long(hop.rttMs)}` });
    }
    screens.push({ t, lines: [title, ...rows()] });
  });
  const done = probe.done;
  if (done && screens.length > 1) screens[screens.length - 1]!.lines.push(done.reached ? `reached in ${done.hops} hops` : `not reached in ${done.hops} hops`);
  return { screens, flags };
}

/** Lines the stranger's terminal keeps up. */
const HEARD_LINES = 7;

/** What the stranger reads off the air, line by line as frames go by. Scrambled bytes all look alike, so they count once. */
export function listenReadout(story: Story, heardAt: ReadonlyMap<string, number>, total: number): Readout {
  const title = 'listening on open Wi-Fi';
  const rows: string[] = [];
  const screens: Readout['screens'] = [{ t: 0, lines: [title] }];
  const heard = story.heard.flatMap((h) => {
    const t = heardAt.get(h.packetId);
    return t === undefined || h.seen.kind === 'empty' ? [] : [{ t, seen: h.seen }];
  });
  let scrambled = false;
  for (const { t, seen } of heard.sort((a, b) => a.t - b.t)) {
    // Past the name in an open hello there are only bytes.
    const lines = seen.kind === 'scrambled' ? (scrambled ? [] : [`scrambled: ${seen.lines[0]}`]) : seen.kind === 'name' ? seen.lines.slice(0, 1) : seen.lines.map((l) => (l.startsWith('voice') ? 'voice, anyone can listen' : l));
    scrambled ||= seen.kind === 'scrambled';
    const fresh = lines.filter((l) => !rows.includes(l));
    if (!fresh.length) continue;
    rows.push(...fresh);
    screens.push({ t, lines: [title, ...rows.slice(-HEARD_LINES)] });
  }
  if (!rows.length) screens.push({ t: total, lines: [title, 'heard nothing'] });
  return { screens, flags: [] };
}

/** A port scan's report: each port as its answer comes in, those that never answered at the end, and what is open. */
export function scanReadout(scan: Scan, timing: Timing, total: number): Readout {
  const title = `port scan of ${scan.to}`;
  const rows: string[] = [];
  const screens: Readout['screens'] = [{ t: 0, lines: [title] }];
  const answers = scan.ports.map((p) => ({ ...p, t: timing.get(p.packetId)?.t1 ?? total }));
  for (const p of answers.sort((a, b) => a.t - b.t)) {
    rows.push(`${String(p.port).padEnd(6)}${p.answer ?? 'no answer'}`);
    screens.push({ t: p.t, lines: [title, ...rows] });
  }
  const open = answers.filter((p) => p.answer === 'open').length;
  screens[screens.length - 1]!.lines.push(`${open} ${open === 1 ? 'door' : 'doors'} open`);
  return { screens, flags: [] };
}

/** The terminal at visual time v, if it has anything to say yet. */
export function screenAt(readout: Readout, v: number): string[] | null {
  return readout.screens.filter((s) => s.t <= v).at(-1)?.lines ?? null;
}
