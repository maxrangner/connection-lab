import {
  clientHelloSni,
  flagNames,
  openRecords,
  sessionStream,
  TCP_ACK,
  TCP_FIN,
  TCP_SYN,
  TLS_ALERT,
  TLS_APPLICATION_DATA,
  type LayerPdu,
  type OpenedRecord,
  type PacketInfo,
  type PduSnapshot,
  type SimEvent,
  type SimResult,
  type TlsSession,
  WG_TAG_LEN,
} from '../sim';

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

/** Pieces that go around the data: transport (TCP or UDP), IP, the VPN case, and the link layer's frame (Ethernet or Wi-Fi). */
export type Wrap = 'l4' | 'ip' | 'vpn' | 'eth';
/**
 * What a snoop on a line can read from the real bytes of a frame. `open`: plain text; `name`: scrambled, except for
 * the site name; `scrambled`: only unreadable bytes; `empty`: no content at all.
 */
export interface Seen {
  from: string;
  to: string;
  lines: string[];
  kind: 'open' | 'name' | 'scrambled' | 'empty';
}

/** Which kind of frame a link uses, with its real header and trailer sizes. */
export interface Frame {
  l2: 'ethernet' | 'wifi';
  head: number;
  tail: number;
}
export type Chapter = 'dns' | 'hello' | 'secret' | 'page';

export type Step =
  | { kind: 'appear'; device: string }
  | { kind: 'wrap'; device: string; layer: Wrap; /** For the frame (layer 'eth'): which kind and its sizes. */ frame?: Frame; /** For the VPN case: the addresses showing from here on. */ addr?: { from: string; to: string } }
  | { kind: 'unwrap'; device: string; layer: Wrap; frame?: Frame; addr?: { from: string; to: string } }
  | { kind: 'nat'; device: string; which: 'from' | 'to'; before: string; after: string }
  | { kind: 'travel'; from: string; to: string; link: string; /** Sim time the frame was sent. */ at: number; /** What anyone on this line could read. */ seen?: Seen }
  /** Knocked off the cable on the way from `from` to `to`. */
  | { kind: 'lost'; from: string; to: string; link: string; at: number; seen?: Seen; /** It fell into a cut in the cable. */ cut?: boolean }
  | { kind: 'read'; device: string }
  /** HTTPS: the sender puts a padlock on the card with its session key, the receiver opens it with the same key. */
  | { kind: 'lock'; device: string }
  | { kind: 'unlock'; device: string };

export interface Trip {
  packetId: string;
  chapter: Chapter;
  /** Sim time the packet was made. */
  start: number;
  origin: string;
  /** Sent by the device the page is opened on (rather than coming back to it). */
  outward: boolean;
  /** Text on the data card ("GET /", "example.com?"), or null for a packet with no data (SYN, ACK). */
  card: string | null;
  dataBytes: number;
  l4: 'tcp' | 'udp';
  /** What the transport collar says: "TCP", "UDP", or the flags of an empty segment ("SYN-ACK"). */
  l4Label: string;
  /** Header bytes per wrap, and the Ethernet trailer (FCS). */
  header: Record<Exclude<Wrap, 'vpn'>, number>;
  /** What the VPN case adds: outer IP, UDP and WireGuard header plus its tag; 0 without a VPN on this trip. */
  tunnel: number;
  trailer: number;
  /** IP addresses as the sender wrote them, before any VPN case. */
  from: string;
  to: string;
  steps: Step[];
  lost: boolean;
  /** A resend of an earlier, lost packet. */
  retry: boolean;
  /** When the page needs several packets: which one this is (1-based) and how many there are. */
  part?: { n: number; of: number };
  /** HTTPS: the card travels locked; only the two ends can open it. */
  locked?: boolean;
  /** One of several packets of the same message that is not the last: no reaction when it arrives. */
  quiet?: boolean;
}

export interface Story {
  /** The site the browser asked for ("example.com"). */
  site: string;
  /** The device the page is opened on (laptop or phone). */
  client: string;
  /** All traffic goes through the VPN server. */
  vpn: boolean;
  devices: { id: string; label: string; kind: string }[];
  /** Cables, with their one-way delay in seconds. */
  links: { id: string; a: string; b: string; delay: number; medium: 'cable' | 'wifi' }[];
  trips: Trip[];
  /** The page's <title> if the page arrived, else null. */
  pageTitle: string | null;
  /** The address the DNS answer gave, if it arrived. */
  dnsAnswer: string | null;
  /** How long (seconds) the DNS answer may be remembered, from the record's real TTL. */
  dnsTtl: number | null;
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

const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '·');
const clip = (s: string, n = 36): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The start of some bytes as hex, the way scrambled data looks to anyone without the key. */
const hexStart = (b: Uint8Array): string => [...b.subarray(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join(' ') + (b.length > 12 ? ' …' : '');

/** The most telling readable lines of plain text: its first line, and the Host or the page title if they are there. */
function readable(b: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(b);
  const first = text.split('\r\n').find((l) => l.trim()) ?? '';
  const more = /^Host: .*$/im.exec(text)?.[0] ?? /<title>[^<]*<\/title>/i.exec(text)?.[0];
  return [first, ...(more && more !== first ? [more] : [])].map((l) => clip(printable(l)));
}

/** Reads a frame the way a snoop on the line would: from its bytes, with no keys. */
function seenOn(pdu: PduSnapshot | undefined, p: PacketInfo): Seen | undefined {
  const ip = pdu && layer(pdu, 'ipv4');
  if (!pdu || !ip) return undefined;
  const base = { from: field(ip, 'ipv4.src'), to: field(ip, 'ipv4.dst') };
  const dns = layer(pdu, 'dns');
  if (dns) return { ...base, lines: [dnsCardLabel(dns.summary)], kind: 'open' };
  const tls = layer(pdu, 'tls');
  if (tls) {
    const data = pdu.bytes.subarray(tls.start, tls.payloadEnd);
    const name = clientHelloSni(data);
    return name ? { ...base, lines: [name, hexStart(data)], kind: 'name' } : { ...base, lines: [hexStart(data)], kind: 'scrambled' };
  }
  const wg = layer(pdu, 'wireguard');
  if (wg) return { ...base, lines: [hexStart(pdu.bytes.subarray(wg.headerEnd, wg.end))], kind: 'scrambled' };
  const tcp = layer(pdu, 'tcp');
  if (tcp && tcp.payloadEnd > tcp.headerEnd) return { ...base, lines: readable(pdu.bytes.subarray(tcp.headerEnd, tcp.payloadEnd)), kind: 'open' };
  return { ...base, lines: tcp ? [flagNames(p.tcp?.flags ?? 0).replace(/, /g, '-')] : [], kind: 'empty' };
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

function trip(r: SimResult, p: PacketInfo, retried: Set<string>, client: string): Trip | null {
  const steps: Step[] = [];
  let frame: PduSnapshot | undefined;
  /** The packet as the sender first made it, before any VPN sealed it. */
  let inner: PduSnapshot | undefined;
  let tunnel = 0;
  let lost = false;
  let firstSeq = -1;
  let done = false;
  /** The frame on the current link, so the receiver unwraps the same kind it was sent in. */
  let onLink: Frame | undefined;
  for (const e of r.events as SimEvent[]) {
    if (done) break;
    if (!('packetId' in e) || e.packetId !== p.id) continue;
    if (firstSeq < 0) firstSeq = e.seq;
    switch (e.type) {
      case 'encapsulate': {
        if (e.layer === 3) inner ??= r.pdus.get(e.pduId);
        const w = WRAP_OF_LAYER[e.layer];
        if (w === 'eth') {
          const pdu = r.pdus.get(e.pduId);
          frame ??= pdu;
          const l2 = pdu?.layers[0];
          onLink = l2 && { l2: e.protocol === 'wifi' ? 'wifi' : 'ethernet', head: l2.headerEnd - l2.start, tail: l2.end - l2.payloadEnd };
          steps.push({ kind: 'wrap', device: e.deviceId, layer: w, frame: onLink });
        } else if (w) steps.push({ kind: 'wrap', device: e.deviceId, layer: w });
        break;
      }
      case 'decapsulate': {
        const w = WRAP_OF_LAYER[e.layer];
        if (w) steps.push({ kind: 'unwrap', device: e.deviceId, layer: w, ...(w === 'eth' && onLink ? { frame: onLink } : {}) });
        if (w === 'l4') done = true;
        break;
      }
      case 'tunnel:wrap': {
        const wg = layer(r.pdus.get(e.pduId)!, 'wireguard');
        tunnel = (wg?.headerEnd ?? 0) + WG_TAG_LEN;
        steps.push({ kind: 'wrap', device: e.deviceId, layer: 'vpn', addr: { from: e.addr.src, to: e.addr.dst } });
        break;
      }
      case 'tunnel:unwrap':
        steps.push({ kind: 'unwrap', device: e.deviceId, layer: 'vpn', addr: { from: e.addr.src, to: e.addr.dst } });
        break;
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
        steps.push({ kind: 'travel', from: e.fromDevice, to: e.toDevice, link: e.linkId, at: e.start, seen: seenOn(r.pdus.get(e.frameId), p) });
        break;
      case 'drop': {
        const last = steps[steps.length - 1];
        if ((e.reason === 'fault' || e.reason === 'cut') && last?.kind === 'travel') {
          steps[steps.length - 1] = { ...last, kind: 'lost', cut: e.reason === 'cut' };
          lost = true;
        }
        done = true;
        break;
      }
    }
  }
  if (!frame || !steps.some((s) => s.kind === 'travel' || s.kind === 'lost')) return null;

  const eth = layer(frame, 'ethernet') ?? layer(frame, 'wifi')!;
  const packet = inner ?? frame;
  const ip = layer(packet, 'ipv4')!;
  const l4 = layer(packet, 'tcp') ?? layer(packet, 'udp')!;
  const app = layer(packet, 'http') ?? layer(packet, 'dns');
  const dataBytes = l4.payloadEnd - l4.headerEnd;
  const card = dataBytes > 0 ? (app ? (app.protocol === 'http' ? cardLabel(app.summary) : dnsCardLabel(app.summary)) : 'data') : null;
  const isTcp = l4.protocol === 'tcp';
  const origin = steps[0]!.kind === 'travel' || steps[0]!.kind === 'lost' ? (steps[0] as { from: string }).from : (steps[0] as { device: string }).device;

  if (card) steps.unshift({ kind: 'appear', device: origin });
  const last = steps[steps.length - 1];
  if (card && last?.kind === 'unwrap' && last.layer === 'l4') steps.push({ kind: 'read', device: last.device });

  const flags = p.tcp?.flags ?? 0;
  const retry = !!p.retransmitOf || (p.kind === 'dns' && retried.has(`${origin}|dns`));
  if (p.kind === 'dns' && !packet.layers.some((x) => x.summary.startsWith('DNS response'))) retried.add(`${origin}|dns`);
  return {
    packetId: p.id,
    chapter: p.kind === 'dns' ? 'dns' : dataBytes > 0 ? 'page' : 'hello',
    start: p.createdAt,
    origin,
    outward: origin === client,
    card,
    dataBytes,
    l4: isTcp ? 'tcp' : 'udp',
    l4Label: isTcp ? (dataBytes > 0 ? 'TCP' : flagNames(flags).replace(/, /g, '-')) : 'UDP',
    header: { eth: eth.headerEnd - eth.start, ip: ip.headerEnd - ip.start, l4: l4.headerEnd - l4.start },
    tunnel,
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
  const start = r.events.find((e) => e.type === 'app' && e.action === 'start');
  const client = start?.type === 'app' ? start.deviceId : r.scenario.startDevice;
  const trips = chosen(r)
    .map((p) => trip(r, p, retried, client))
    .filter((t): t is Trip => !!t)
    .sort((a, b) => a.start - b.start);
  const tls = r.scenario.devices.flatMap((d) => d.apps).find((a) => a.kind === 'browser')?.tls;
  if (tls) labelTls(trips, r, tls);
  numberParts(trips, r);
  const url = start?.type === 'app' ? String(start.info?.url ?? '') : '';
  const wifiIfaces = new Set(r.scenario.devices.flatMap((d) => d.ifaces.filter((i) => i.wifi).map((i) => i.id)));
  const ifaceDevice = new Map(r.scenario.devices.flatMap((d) => d.ifaces.map((i) => [i.id, d.id] as const)));
  return {
    devices: r.scenario.devices.map((d) => ({ id: d.id, label: d.label, kind: d.kind })),
    links: r.scenario.links.map((l) => ({
      id: l.id,
      a: ifaceDevice.get(l.a) ?? l.a,
      b: ifaceDevice.get(l.b) ?? l.b,
      delay: l.delay,
      medium: wifiIfaces.has(l.a) || wifiIfaces.has(l.b) ? ('wifi' as const) : ('cable' as const),
    })),
    site: url ? new URL(url).hostname : '',
    client,
    vpn: r.scenario.devices.some((d) => d.tunnel),
    trips,
    pageTitle: pageTitle(r),
    dnsAnswer: dnsAnswer(r),
    dnsTtl: (() => {
      const e = r.events.find((x) => x.type === 'app' && x.action === 'dns-answer');
      const ttl = e?.type === 'app' ? Number(e.info?.ttl) : NaN;
      return Number.isFinite(ttl) ? ttl : null;
    })(),
    remembered: dnsAnswer(r, 'dns-cache-hit'),
  };
}

/**
 * A reply too big for one packet goes out in numbered parts (by where each sits in the byte stream; a resend keeps
 * its number). The first part's card says "200 OK 1/2", the rest just "2/2".
 */
function numberParts(trips: Trip[], r: SimResult): void {
  const parts = trips.filter((t) => t.chapter === 'page' && !t.outward);
  const seqOf = (t: Trip): number => r.packets.get(t.packetId)?.tcp?.relSeq ?? 0;
  const seqs = [...new Set(parts.map(seqOf))].sort((a, b) => a - b);
  if (seqs.length < 2) return;
  const status = parts.find((t) => t.card && t.card !== 'data' && t.card !== 'page' && t.card !== 'ticket')?.card ?? '';
  for (const t of parts) {
    const n = seqs.indexOf(seqOf(t)) + 1;
    t.part = { n, of: seqs.length };
    t.card = n === 1 && status ? `${status} 1/${seqs.length}` : `${n}/${seqs.length}`;
  }
}

/** The most telling name for what a TLS record carries. */
function recordLabel(rec: OpenedRecord): string {
  if (rec.inner === TLS_APPLICATION_DATA) {
    const line = new TextDecoder('latin1').decode(rec.plaintext.subarray(0, 80)).split('\r\n')[0] ?? '';
    return /^(GET|HEAD|POST) |^HTTP\//.test(line) ? cardLabel(`HTTP ${line}`) : 'page';
  }
  if (rec.inner === TLS_ALERT) return 'bye';
  const h = rec.handshakes;
  if (h.includes('ClientHello') || h.includes('ServerHello')) return 'hello';
  if (h.includes('Certificate')) return 'certificate';
  if (h.includes('NewSessionTicket')) return 'ticket';
  if (h.includes('CertificateVerify')) return 'signature';
  if (h.includes('Finished')) return 'done';
  return h[0] ?? 'TLS';
}

const RANK = (rec: OpenedRecord): number =>
  rec.inner === TLS_APPLICATION_DATA ? 5 : rec.handshakes.some((h) => /Hello|Certificate/.test(h)) ? 4 : rec.inner === TLS_ALERT ? 1 : rec.handshakes.length ? 2 : 0;

/**
 * HTTPS: name each data segment after the TLS records in it (opened with the session's keys, as either end could),
 * mark it locked when what it carries is encrypted, and put the handshake into its own chapter. Segments of the same
 * flight get numbered ("certificate 2/4").
 */
function labelTls(trips: Trip[], r: SimResult, session: TlsSession): void {
  const opened = {
    client: openRecords(session, 'client', sessionStream(session, 'client')),
    server: openRecords(session, 'server', sessionStream(session, 'server')),
  };
  // Where each flight starts and ends in its sender's stream.
  const flightOf = (side: 'client' | 'server', offset: number): number => {
    let o = 0;
    let n = 0;
    for (const f of session.flights) {
      if (f.from !== side) continue;
      const len = Math.ceil((f.base64.length * 3) / 4) - (f.base64.endsWith('==') ? 2 : f.base64.endsWith('=') ? 1 : 0);
      if (offset < o + len) return n;
      o += len;
      n++;
    }
    return n;
  };
  const groups = new Map<string, Trip[]>();
  for (const t of trips) {
    const info = r.packets.get(t.packetId)?.tcp;
    if (!info || !t.dataBytes) continue;
    const side = t.outward ? 'client' : 'server';
    const from = info.relSeq - 1;
    const to = from + t.dataBytes;
    const recs = opened[side];
    const touching = recs.filter((x, i) => x.offset < to && (recs[i + 1]?.offset ?? Infinity) > from);
    const starting = touching.filter((x) => x.offset >= from);
    const main = [...(starting.length ? starting : touching)].sort((a, b) => RANK(b) - RANK(a))[0];
    if (!main) continue;
    t.card = recordLabel(main);
    t.locked = main.inner === TLS_APPLICATION_DATA || !main.handshakes.some((h) => /Hello/.test(h));
    if (t.locked) {
      // The padlock goes on right after the card appears and comes off just before it is read.
      const appear = t.steps.findIndex((x) => x.kind === 'appear');
      if (appear >= 0) t.steps.splice(appear + 1, 0, { kind: 'lock', device: t.origin });
      const read = t.steps.findIndex((x) => x.kind === 'read');
      const reader = t.steps[read];
      if (reader?.kind === 'read') t.steps.splice(read, 0, { kind: 'unlock', device: reader.device });
    }
    t.chapter = touching.some((x) => x.inner === TLS_APPLICATION_DATA || x.inner === TLS_ALERT || x.handshakes.includes('NewSessionTicket')) ? 'page' : 'secret';
    if (t.chapter === 'secret') {
      const key = `${side}|${flightOf(side, from)}`;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
  }
  // Number the packets of a handshake flight; retransmissions keep their number.
  for (const g of groups.values()) {
    const seqs = [...new Set(g.map((t) => r.packets.get(t.packetId)?.tcp?.relSeq ?? 0))].sort((a, b) => a - b);
    if (seqs.length < 2) continue;
    for (const t of g) {
      const n = seqs.indexOf(r.packets.get(t.packetId)?.tcp?.relSeq ?? 0) + 1;
      t.card = `${t.card} ${n}/${seqs.length}`;
      t.quiet = n < seqs.length;
    }
  }
}
