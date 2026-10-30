import { flagNames, TCP_ACK, TCP_FIN, TCP_SYN, type LayerPdu, type PacketInfo, type PduSnapshot, type SimEvent, type SimResult } from '../sim';

/**
 * The simple story: the packets a learner needs to follow, in order. Everything is read from the real event
 * log and PDU snapshots; nothing is invented, we only leave things out (ARP, plain ACKs, teardown, TTL, ports).
 *
 *   1 Find the address  DNS question to the resolver and the answer back (UDP)
 *   2 Say hello         SYN, SYN-ACK, ACK
 *   3 Get the page      GET / out, 200 OK back
 *
 * A packet knocked off a cable (a manual fault) ends its trip with `lost`; the retry that the sim then sends
 * is simply the next trip.
 */

/** Pieces that go around the data: transport (TCP or UDP), IP, Ethernet. */
export type Wrap = 'l4' | 'ip' | 'eth';
export type Chapter = 'dns' | 'hello' | 'page';

export type Step =
  | { kind: 'appear'; device: string }
  | { kind: 'wrap'; device: string; layer: Wrap }
  | { kind: 'unwrap'; device: string; layer: Wrap }
  | { kind: 'nat'; device: string; which: 'from' | 'to'; before: string; after: string }
  | { kind: 'travel'; from: string; to: string; link: string; /** Sim time the frame was sent. */ at: number }
  /** Knocked off the cable on the way from `from` to `to`. */
  | { kind: 'lost'; from: string; to: string; link: string; at: number }
  | { kind: 'read'; device: string };

export interface Trip {
  packetId: string;
  chapter: Chapter;
  /** Sim time the packet was made. */
  start: number;
  origin: string;
  /** Text on the data card ("GET /", "example.com?"), or null for a packet with no data (SYN, ACK). */
  card: string | null;
  dataBytes: number;
  l4: 'tcp' | 'udp';
  /** What the transport collar says: "TCP", "UDP", or the flags of an empty segment ("SYN-ACK"). */
  l4Label: string;
  /** Header bytes per wrap, and the Ethernet trailer (FCS). */
  header: Record<Wrap, number>;
  trailer: number;
  /** IP addresses as the sender wrote them. */
  from: string;
  to: string;
  steps: Step[];
  lost: boolean;
  /** A resend of an earlier, lost packet. */
  retry: boolean;
  /** When the page needs several packets: which one this is (1-based) and how many there are. */
  part?: { n: number; of: number };
}

export interface Story {
  /** The site the browser asked for ("example.com"). */
  site: string;
  devices: { id: string; label: string; kind: string }[];
  /** Cables, with their one-way delay in seconds. */
  links: { id: string; a: string; b: string; delay: number }[];
  trips: Trip[];
  /** The page's <title> if the page arrived, else null. */
  pageTitle: string | null;
  /** The address the DNS answer gave, if it arrived. */
  dnsAnswer: string | null;
  /** On a second visit: the address the laptop still remembered, so it asked nobody. */
  remembered: string | null;
}

const WRAP_OF_LAYER: Record<number, Wrap | undefined> = { 4: 'l4', 3: 'ip', 2: 'eth' };

function layer(s: PduSnapshot, protocol: LayerPdu['protocol']): LayerPdu | undefined {
  return s.layers.find((l) => l.protocol === protocol);
}

function field(l: LayerPdu | undefined, key: string): string {
  return l?.fields.find((f) => f.key === key)?.display ?? '';
}

/** "HTTP GET / HTTP/1.1" → "GET /", "HTTP HTTP/1.1 200 OK" → "200 OK". */
export function cardLabel(summary: string): string {
  const s = summary.replace(/^HTTP /, '').replace(/ ?HTTP\/1\.[01] ?/, '').trim();
  // A long path keeps only its last part: "GET /hypertext/WWW/TheProject.html" → "GET …/TheProject.html".
  const m = /^(GET|HEAD|POST) (\/\S+)$/.exec(s);
  if (m && m[2]!.length > 12) return `${m[1]} …/${m[2]!.split('/').pop()}`;
  return s;
}

/** "DNS query 0x85bb: example.com A?" → "example.com?", a response → its first address. */
export function dnsCardLabel(summary: string): string {
  const q = /^DNS query \S+: (\S+)/.exec(summary);
  if (q) return `${q[1]}?`;
  return /\d+\.\d+\.\d+\.\d+/.exec(summary)?.[0] ?? 'DNS';
}

/** Which packets the story follows. */
function chosen(r: SimResult): PacketInfo[] {
  const out: PacketInfo[] = [];
  const helloAckFrom = new Set<string>();
  for (const p of r.packets.values()) {
    if (p.kind === 'dns') {
      out.push(p);
      continue;
    }
    if (p.kind !== 'tcp' || !p.tcp) continue;
    const { flags, len } = p.tcp;
    if (flags & TCP_FIN) continue;
    if (flags & TCP_SYN || len > 0) {
      out.push(p);
      continue;
    }
    // The third handshake packet: the first empty ACK from whoever sent the first SYN.
    const opener = [...r.packets.values()].find((q) => q.tcp && q.tcp.flags === TCP_SYN && q.tcp.connId === p.tcp!.connId);
    if (flags === TCP_ACK && opener?.origin === p.origin && !helloAckFrom.has(p.tcp.connId)) {
      helloAckFrom.add(p.tcp.connId);
      out.push(p);
    }
  }
  return out;
}

function trip(r: SimResult, p: PacketInfo, retried: Set<string>): Trip | null {
  const steps: Step[] = [];
  let frame: PduSnapshot | undefined;
  let lost = false;
  let firstSeq = -1;
  let done = false;
  for (const e of r.events as SimEvent[]) {
    if (done) break;
    if (!('packetId' in e) || e.packetId !== p.id) continue;
    if (firstSeq < 0) firstSeq = e.seq;
    switch (e.type) {
      case 'encapsulate': {
        const w = WRAP_OF_LAYER[e.layer];
        if (w) steps.push({ kind: 'wrap', device: e.deviceId, layer: w });
        if (w === 'eth') frame ??= r.pdus.get(e.pduId);
        break;
      }
      case 'decapsulate': {
        const w = WRAP_OF_LAYER[e.layer];
        if (w) steps.push({ kind: 'unwrap', device: e.deviceId, layer: w });
        if (w === 'l4') done = true;
        break;
      }
      case 'nat:translate':
        steps.push({
          kind: 'nat',
          device: e.deviceId,
          // Going out NAT rewrites the source; coming back in it rewrites the destination.
          which: e.direction === 'out' ? 'from' : 'to',
          before: e.before.ip,
          after: e.after.ip,
        });
        break;
      case 'tx':
        steps.push({ kind: 'travel', from: e.fromDevice, to: e.toDevice, link: e.linkId, at: e.start });
        break;
      case 'drop': {
        const last = steps[steps.length - 1];
        if (e.reason === 'fault' && last?.kind === 'travel') {
          steps[steps.length - 1] = { ...last, kind: 'lost' };
          lost = true;
        }
        done = true;
        break;
      }
    }
  }
  if (!frame || !steps.some((s) => s.kind === 'travel' || s.kind === 'lost')) return null;

  const eth = layer(frame, 'ethernet')!;
  const ip = layer(frame, 'ipv4')!;
  const l4 = layer(frame, 'tcp') ?? layer(frame, 'udp')!;
  const app = layer(frame, 'http') ?? layer(frame, 'dns');
  const dataBytes = l4.payloadEnd - l4.headerEnd;
  const card = dataBytes > 0 ? (app ? (app.protocol === 'http' ? cardLabel(app.summary) : dnsCardLabel(app.summary)) : 'data') : null;
  const isTcp = l4.protocol === 'tcp';
  const origin = steps[0]!.kind === 'travel' || steps[0]!.kind === 'lost' ? (steps[0] as { from: string }).from : (steps[0] as { device: string }).device;

  if (card) steps.unshift({ kind: 'appear', device: origin });
  const last = steps[steps.length - 1];
  if (card && last?.kind === 'unwrap' && last.layer === 'l4') steps.push({ kind: 'read', device: last.device });

  const flags = p.tcp?.flags ?? 0;
  const retry = !!p.retransmitOf || (p.kind === 'dns' && retried.has(`${origin}|dns`));
  if (p.kind === 'dns' && !frame.layers.some((x) => x.summary.startsWith('DNS response'))) retried.add(`${origin}|dns`);
  return {
    packetId: p.id,
    chapter: p.kind === 'dns' ? 'dns' : dataBytes > 0 ? 'page' : 'hello',
    start: p.createdAt,
    origin,
    card,
    dataBytes,
    l4: isTcp ? 'tcp' : 'udp',
    l4Label: isTcp ? (dataBytes > 0 ? 'TCP' : flagNames(flags).replace(/, /g, '-')) : 'UDP',
    header: { eth: eth.headerEnd - eth.start, ip: ip.headerEnd - ip.start, l4: l4.headerEnd - l4.start },
    trailer: eth.end - eth.payloadEnd,
    from: field(ip, 'ipv4.src'),
    to: field(ip, 'ipv4.dst'),
    steps,
    lost,
    retry,
  };
}

function pageTitle(r: SimResult): string | null {
  const got = r.events.find((e) => e.type === 'app' && e.action === 'http-response-received');
  const pdu = got && 'pduId' in got && got.pduId ? r.pdus.get(got.pduId) : undefined;
  if (!pdu) return null;
  const text = new TextDecoder('latin1').decode(pdu.bytes);
  return /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || 'example.com';
}

function dnsAnswer(r: SimResult, action: 'dns-answer' | 'dns-cache-hit' = 'dns-answer'): string | null {
  const e = r.events.find((x) => x.type === 'app' && x.action === action);
  const a = e?.type === 'app' ? e.info?.addresses : undefined;
  return Array.isArray(a) ? (a[0] ?? null) : null;
}

export function buildStory(r: SimResult): Story {
  const retried = new Set<string>();
  const trips = chosen(r)
    .map((p) => trip(r, p, retried))
    .filter((t): t is Trip => !!t)
    .sort((a, b) => a.start - b.start);
  numberParts(trips, r);
  const start = r.events.find((e) => e.type === 'app' && e.action === 'start');
  const url = start?.type === 'app' ? String(start.info?.url ?? '') : '';
  const ifaceDevice = new Map(r.scenario.devices.flatMap((d) => d.ifaces.map((i) => [i.id, d.id] as const)));
  return {
    devices: r.scenario.devices.map((d) => ({ id: d.id, label: d.label, kind: d.kind })),
    links: r.scenario.links.map((l) => ({ id: l.id, a: ifaceDevice.get(l.a) ?? l.a, b: ifaceDevice.get(l.b) ?? l.b, delay: l.delay })),
    site: url ? new URL(url).hostname : '',
    trips,
    pageTitle: pageTitle(r),
    dnsAnswer: dnsAnswer(r),
    remembered: dnsAnswer(r, 'dns-cache-hit'),
  };
}

/**
 * A reply too big for one packet goes out in numbered parts (by where each sits in the byte stream; a resend keeps
 * its number). The first part's card says "200 OK 1/2", the rest just "2/2".
 */
function numberParts(trips: Trip[], r: SimResult): void {
  const parts = trips.filter((t) => t.chapter === 'page' && t.origin !== 'laptop');
  const seqOf = (t: Trip): number => r.packets.get(t.packetId)?.tcp?.relSeq ?? 0;
  const seqs = [...new Set(parts.map(seqOf))].sort((a, b) => a - b);
  if (seqs.length < 2) return;
  const status = parts.find((t) => t.card && t.card !== 'data')?.card ?? '';
  for (const t of parts) {
    const n = seqs.indexOf(seqOf(t)) + 1;
    t.part = { n, of: seqs.length };
    t.card = n === 1 && status ? `${status} 1/${seqs.length}` : `${n}/${seqs.length}`;
  }
}
