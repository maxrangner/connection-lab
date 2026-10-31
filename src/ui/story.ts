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
  type Field,
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
 * log and PDU snapshots; nothing is invented, we only leave things out (ARP, teardown). Plain ACKs run as small blocks.
 * TTL only shows in an opened pill, and ports there and at a NAT.
 *
 *   1 Find the address  DNS question to the resolver and the answer back (UDP); a cold resolver first walks
 *                       root → TLD → authoritative, each referral a card saying who to ask next
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

/** One piece of a packet, by where it sits. */
export type PartKey = 'ethH' | 'vpn' | 'ip' | 'l4' | 'card' | 'ethT';
/** A header field in a pill: its name and value, read from the real bytes. */
export interface Row {
  name: string;
  value: string;
}
export type Details = Partial<Record<PartKey, Row[]>>;
export type Message = { kind: 'dns-answer'; name: string } | { kind: 'http-request'; path: string } | { kind: 'http-response' };

export type Step = (
  | { kind: 'appear'; device: string }
  | { kind: 'wrap'; device: string; layer: Wrap; /** For the frame (layer 'eth'): which kind and its sizes. */ frame?: Frame; /** For the VPN case: the addresses showing from here on. */ addr?: { from: string; to: string } }
  | { kind: 'unwrap'; device: string; layer: Wrap; frame?: Frame; addr?: { from: string; to: string } }
  | { kind: 'nat'; device: string; which: 'from' | 'to'; before: string; after: string; /** The port changes with the address: it is how the way back is found. */ beforePort: number; afterPort: number }
  | { kind: 'travel'; from: string; to: string; link: string; /** Sim time the frame was sent. */ at: number; /** What anyone on this line could read. */ seen?: Seen }
  /** Knocked off the cable on the way from `from` to `to`. */
  | { kind: 'lost'; from: string; to: string; link: string; at: number; seen?: Seen }
  | { kind: 'read'; device: string }
  /** A server does its job before it answers: the resolver finds the name in its book, the web server the file on its shelf. */
  | { kind: 'lookup'; device: string; what: 'dns' | 'web'; /** What was asked. */ ask: string; /** What it found. */ found: string }
  /** HTTPS: the sender puts a padlock on the card with its session key, the receiver opens it with the same key. */
  | { kind: 'lock'; device: string }
  | { kind: 'unlock'; device: string }
  /** A reply of many packets: they and their ACKs stream along the cables at once, drawn small. */
  | { kind: 'flow'; packets: Trip[] }
) & { /** The packet's header fields once this step is done, if it changes them. */ details?: Details };

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
  /** What the application message is, read from its real layer or, under HTTPS, from the opened record. */
  message?: Message;
  steps: Step[];
  lost: boolean;
  /** A resend of an earlier, lost packet. */
  retry: boolean;
  /** The packet this one sends again. */
  retransmitOf?: string;
  /** A resend because the sender's timer ran out, rather than because ACKs told it. */
  timedOut?: boolean;
  /** The timer that ran out, in real seconds. */
  waited?: number;
  /** HTTPS: this hello carries the sender's public share of the key. */
  keyShare?: boolean;
  /** HTTPS: the end of the server's proof of who it is: the name its certificate really names. */
  identity?: string;
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
  /** Which device each address belongs to. */
  names: Record<string, string>;
  devices: { id: string; label: string; kind: string }[];
  /** Cables, with their one-way delay in seconds. */
  links: { id: string; a: string; b: string; delay: number; medium: 'cable' | 'wifi' }[];
  trips: Trip[];
  /** The page's <title> if the page arrived, else null. */
  pageTitle: string | null;
  /** What was asked for, if it is a picture: its real bytes as a data URL. */
  image: string | null;
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

/**
 * "DNS query 0x85bb: example.com A?" → "example.com?", a response → its first address, a referral → who to ask next:
 * "ask .com" for a top-level zone, else the first server named, shortened to its first label and ending ("ask hera…com").
 */
export function dnsCardLabel(summary: string): string {
  const q = /^DNS query \S+: (\S+)/.exec(summary);
  if (q) return `${q[1]}?`;
  const ref = /^DNS referral \S+: \S+ → (\S+) NS ([^,\s]+)/.exec(summary);
  if (ref) {
    const zone = ref[1]!;
    const server = ref[2]!;
    if (!zone.includes('.')) return `ask .${zone}`;
    const labels = server.split('.');
    return `ask ${server.length > 16 ? `${labels[0]}…${labels[labels.length - 1]}` : server}`;
  }
  return /\d+\.\d+\.\d+\.\d+/.exec(summary)?.[0] ?? 'DNS';
}

const TLS_HANDSHAKE = 22;
const SERVER_HELLO = 2;

const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '·');
const clip = (s: string, n = 36): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The start of some bytes as hex, the way scrambled data looks to anyone without the key. */
const hexStart = (b: Uint8Array): string => [...b.subarray(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join(' ') + (b.length > 12 ? ' …' : '');

/** The most telling readable lines of plain text: its first line, and the Host or the page title if they are there. */
function readable(b: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(b);
  // Bytes that are not text, like a piece of a photo, are not scrambled: anyone can put them together.
  const start = text.slice(0, 200);
  if (start.replace(/[\t\r\n\x20-\x7e]/g, '').length > start.length / 8) return ['photo data, not scrambled'];
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
    // The server's hello is as open as the laptop's: only what comes after it is sealed.
    if (data[0] === TLS_HANDSHAKE && data[5] === SERVER_HELLO) return { ...base, lines: ['server hello', hexStart(data)], kind: 'name' };
    return name ? { ...base, lines: [name, hexStart(data)], kind: 'name' } : { ...base, lines: [hexStart(data)], kind: 'scrambled' };
  }
  const wg = layer(pdu, 'wireguard');
  if (wg) return { ...base, lines: [hexStart(pdu.bytes.subarray(wg.headerEnd, wg.end))], kind: 'scrambled' };
  const tcp = layer(pdu, 'tcp');
  if (tcp && tcp.payloadEnd > tcp.headerEnd) return { ...base, lines: readable(pdu.bytes.subarray(tcp.headerEnd, tcp.payloadEnd)), kind: 'open' };
  return { ...base, lines: tcp ? [flagNames(p.tcp?.flags ?? 0).replace(/, /g, '-')] : [], kind: 'empty' };
}

const rowsOf = (fields: Field[]): Row[] =>
  fields.filter((f) => f.importance === 'key').flatMap((f) => [{ name: f.name, value: clip(f.display, 30) }, ...rowsOf(f.children ?? [])]);

/** The fields of each piece in a snapshot, which may hold only part of a packet. A sealed packet shows only its case. */
function detailsOf(pdu: PduSnapshot | undefined): Details {
  if (!pdu) return {};
  const d: Details = {};
  const link = layer(pdu, 'ethernet') ?? layer(pdu, 'wifi');
  const ip = layer(pdu, 'ipv4');
  const wg = layer(pdu, 'wireguard');
  if (link) {
    d.ethH = rowsOf(link.fields.filter((f) => f.offset < link.headerEnd));
    d.ethT = link.fields.filter((f) => f.offset >= link.payloadEnd).map((f) => ({ name: f.name, value: clip(f.display, 30) }));
  }
  if (wg) {
    d.vpn = [...rowsOf((ip?.fields ?? []).filter((f) => f.key === 'ipv4.src' || f.key === 'ipv4.dst')), ...rowsOf(wg.fields)];
    return d;
  }
  if (ip) d.ip = rowsOf(ip.fields);
  const l4 = layer(pdu, 'tcp') ?? layer(pdu, 'udp');
  if (l4) d.l4 = rowsOf(l4.fields);
  const app = layer(pdu, 'http') ?? layer(pdu, 'dns') ?? layer(pdu, 'tls');
  if (app) d.card = rowsOf(app.fields);
  return d;
}

/** An HTTP start line: a request and its path, or a response. */
function httpMessage(line: string): Message | undefined {
  const request = /^[A-Z]+ (\S+) HTTP\/1\.[01]/.exec(line);
  if (request) return { kind: 'http-request', path: request[1]! };
  return /^HTTP\/1\.[01] \d{3}/.test(line) ? { kind: 'http-response' } : undefined;
}

function messageOf(app: LayerPdu | undefined): Message | undefined {
  if (app?.protocol === 'http') return httpMessage(app.summary.replace(/^HTTP /, ''));
  // A referral is a server's answer too: "not me, ask these"; it looked the name up to say so.
  if (app?.protocol === 'dns' && /^DNS (response|referral)/.test(app.summary)) return { kind: 'dns-answer', name: field(app, 'dns.question').split(' ')[0]! };
  return undefined;
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
    const hello = flags === TCP_ACK && opener?.origin === p.origin && !helloAckFrom.has(p.tcp.connId);
    if (hello) helloAckFrom.add(p.tcp.connId);
    if (hello || (flags === TCP_ACK && !answersFin(r, p))) out.push(p);
  }
  return out;
}

/** An ACK beyond all the data the other side sent: it answers that side's FIN, which is teardown. */
function answersFin(r: SimResult, ack: PacketInfo): boolean {
  const other = [...r.packets.values()].filter((q) => q.tcp?.len && q.origin !== ack.origin);
  return (ack.tcp?.relAck ?? 0) > Math.max(...other.map((q) => (q.tcp?.relSeq ?? 0) + (q.tcp?.len ?? 0)));
}

function trip(r: SimResult, p: PacketInfo, asked: Map<string, number>, client: string): Trip | null {
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
  /** The packet as it is right now: built up by the sender, then rewritten hop by hop. */
  let now: Details = {};
  const update = (pduId: string): void => {
    now = { ...now, ...detailsOf(r.pdus.get(pduId)) };
  };
  for (const e of r.events as SimEvent[]) {
    if (done) break;
    if (!('packetId' in e) || e.packetId !== p.id) continue;
    if (firstSeq < 0) firstSeq = e.seq;
    const count = steps.length;
    switch (e.type) {
      case 'encapsulate': {
        update(e.pduId);
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
      case 'forward':
        update(e.pduId);
        break;
      case 'tunnel:wrap': {
        update(e.pduId);
        const wg = layer(r.pdus.get(e.pduId)!, 'wireguard');
        tunnel = (wg?.headerEnd ?? 0) + WG_TAG_LEN;
        steps.push({ kind: 'wrap', device: e.deviceId, layer: 'vpn', addr: { from: e.addr.src, to: e.addr.dst } });
        break;
      }
      case 'tunnel:unwrap':
        update(e.pduId);
        delete now.vpn;
        steps.push({ kind: 'unwrap', device: e.deviceId, layer: 'vpn', addr: { from: e.addr.src, to: e.addr.dst } });
        break;
      case 'nat:translate':
        update(e.pduId);
        steps.push({
          kind: 'nat',
          device: e.deviceId,
          // Going out NAT rewrites the source; coming back in it rewrites the destination.
          which: e.direction === 'out' ? 'from' : 'to',
          before: e.before.ip,
          after: e.after.ip,
          beforePort: e.before.port,
          afterPort: e.after.port,
        });
        break;
      case 'tx':
        steps.push({ kind: 'travel', from: e.fromDevice, to: e.toDevice, link: e.linkId, at: e.start, seen: seenOn(r.pdus.get(e.frameId), p) });
        break;
      case 'drop': {
        const last = steps[steps.length - 1];
        if ((e.reason === 'fault' || e.reason === 'cut') && last?.kind === 'travel') {
          steps[steps.length - 1] = { ...last, kind: 'lost' };
          lost = true;
        }
        done = true;
        break;
      }
    }
    if (steps.length > count) steps[steps.length - 1]!.details = now;
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

  if (card) steps.unshift({ kind: 'appear', device: origin, details: detailsOf(packet) });
  const last = steps[steps.length - 1];
  if (card && last?.kind === 'unwrap' && last.layer === 'l4') steps.push({ kind: 'read', device: last.device });

  const flags = p.tcp?.flags ?? 0;
  const to = field(ip, 'ipv4.dst');
  // A DNS question asked again by the same device of the same server: its timer ran out. (A cold resolver asks the same
  // question of one server after another on its way down the hierarchy; those are not retries.)
  const askKey = `${origin}>${to}`;
  const askedAt = p.kind === 'dns' ? asked.get(askKey) : undefined;
  if (p.kind === 'dns' && packet.layers.some((x) => x.summary.startsWith('DNS query'))) asked.set(askKey, p.createdAt);
  const resend = r.events.find((e) => e.type === 'tcp:retransmit' && e.packetId === p.id);
  const timer = resend?.type === 'tcp:retransmit' && resend.cause === 'rto' ? resend.rto : askedAt !== undefined ? p.createdAt - askedAt : undefined;
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
    to,
    message: messageOf(app),
    steps,
    lost,
    retry: !!p.retransmitOf || askedAt !== undefined,
    retransmitOf: p.retransmitOf,
    timedOut: timer !== undefined,
    waited: timer,
  };
}

/** A reply this many full packets long is shown as a stream rather than packet by packet. */
const STREAM_MIN = 12;
const FULL_PACKET = 1448;

/** The bytes in a flight of a TLS session, from the length of its base64. */
const flightBytes = (f: { base64: string }): number => Math.ceil((f.base64.length * 3) / 4) - (f.base64.endsWith('==') ? 2 : f.base64.endsWith('=') ? 1 : 0);

/** The bytes the web server sends in all, by size alone: what is lost on the way must not change how the reply is shown. */
function replyBytes(r: SimResult): number {
  const server = r.scenario.devices.flatMap((d) => d.apps).find((a) => a.kind === 'http-server');
  if (server?.kind !== 'http-server') return 0;
  if (!server.tls) return server.response.length;
  return server.tls.flights.filter((f) => f.from === 'server').reduce((n, f) => n + flightBytes(f), 0);
}

const streams = (r: SimResult): boolean => replyBytes(r) >= STREAM_MIN * FULL_PACKET;

/** The real picture the server sends (it is known before it arrives, so a sheet can show what has come so far). */
function imageOf(r: SimResult): string | null {
  const sent = r.events.find((e) => e.type === 'app' && e.action === 'http-response-sent');
  const bytes = sent && 'pduId' in sent && sent.pduId ? r.pdus.get(sent.pduId)?.bytes : undefined;
  if (!bytes) return null;
  const text = new TextDecoder('latin1').decode(bytes);
  const end = text.indexOf('\r\n\r\n');
  if (end < 0 || !/^content-type: image\/jpeg/im.test(text.slice(0, end))) return null;
  return `data:image/jpeg;base64,${btoa(Array.from(bytes.subarray(end + 4), (b) => String.fromCharCode(b)).join(''))}`;
}

function pageTitle(r: SimResult): string | null {
  const got = r.events.find((e) => e.type === 'app' && e.action === 'http-response-received');
  const pdu = got && 'pduId' in got && got.pduId ? r.pdus.get(got.pduId) : undefined;
  if (!pdu) return null;
  const text = new TextDecoder('latin1').decode(pdu.bytes);
  if (/^content-type: image\//im.test(text)) return 'photo';
  return /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || 'example.com';
}

function dnsAnswer(r: SimResult, action: 'dns-answer' | 'dns-cache-hit' = 'dns-answer'): string | null {
  const e = r.events.find((x) => x.type === 'app' && x.action === action);
  const a = e?.type === 'app' ? e.info?.addresses : undefined;
  return Array.isArray(a) ? (a[0] ?? null) : null;
}

export function buildStory(r: SimResult): Story {
  const asked = new Map<string, number>();
  const start = r.events.find((e) => e.type === 'app' && e.action === 'start');
  const client = start?.type === 'app' ? start.deviceId : r.scenario.startDevice;
  const trips = chosen(r)
    .map((p) => trip(r, p, asked, client))
    .filter((t): t is Trip => !!t)
    .sort((a, b) => a.start - b.start);
  const tls = r.scenario.devices.flatMap((d) => d.apps).find((a) => a.kind === 'browser')?.tls;
  if (tls) labelTls(trips, r, tls);
  numberParts(trips, r);
  const title = pageTitle(r);
  addLookups(trips, title);
  const shown = streams(r) ? gatherStream(trips) : smallAcks(trips);
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
    names: Object.fromEntries(r.scenario.devices.flatMap((d) => [...d.ifaces.map((i) => [i.ip, d.label]), ...(d.tunnel ? [[d.tunnel.ip, d.label]] : [])])),
    trips: shown,
    pageTitle: title,
    image: imageOf(r),
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
 * The ACK that ends the hello is a whole packet. The rest run as small blocks, as in a stream: there is nothing to open, but
 * you see the receiver answer, so a sender that hears nothing has a visible reason to wait.
 */
function smallAcks(trips: Trip[], hello = trips.find((t) => t.l4Label === 'ACK'), from: Chapter = 'dns'): Trip[] {
  let chapter = from;
  return trips.map((t) => {
    if (t.l4Label !== 'ACK' || t === hello) {
      chapter = t.chapter;
      return t;
    }
    return { ...t, chapter, lost: false, retry: false, timedOut: false, steps: [{ kind: 'flow', packets: [t] }] };
  });
}

/**
 * The reply and the ACKs for it become one step from its first packet on. What else was said then (a TLS goodbye and the ACK
 * for that) goes on after it. A lookup stays in front of the stream.
 */
function gatherStream(trips: Trip[]): Trip[] {
  const hello = trips.find((t) => t.l4Label === 'ACK');
  const inStream = (t: Trip): boolean => !!t.part || (t.l4Label === 'ACK' && t !== hello && t.outward);
  const first = trips.findIndex((t) => t.part);
  if (first < 0) return smallAcks(trips);
  const packets = trips.slice(first).filter(inStream);
  const lookups = packets.flatMap((t) => t.steps.filter((s) => s.kind === 'lookup'));
  const stream: Trip = { ...trips[first]!, part: undefined, retry: false, timedOut: false, lost: false, locked: false, steps: [...lookups, { kind: 'flow', packets }] };
  return [...smallAcks(trips.slice(0, first), hello), stream, ...smallAcks(trips.slice(first).filter((t) => !inStream(t)), hello, 'page')];
}

/**
 * Before a server answers it does its job. The resolver finds the name in its book, for each answer it sends; the web
 * server takes the file off its shelf once, for the first packet of the reply. Both show what the real messages carry.
 */
function addLookups(trips: Trip[], title: string | null): void {
  let path = '/';
  let served = false;
  for (const t of trips) {
    const m = t.message;
    if (m?.kind === 'http-request') path = m.path;
    if (m?.kind === 'dns-answer') t.steps.unshift({ kind: 'lookup', device: t.origin, what: 'dns', ask: m.name, found: t.card ?? '' });
    if (m?.kind === 'http-response' && !served) {
      served = true;
      t.steps.unshift({ kind: 'lookup', device: t.origin, what: 'web', ask: path, found: title ?? t.card ?? '' });
    }
  }
}

/**
 * A reply too big for one packet goes out in numbered parts (by where each sits in the byte stream; a resend keeps
 * its number). The first part's card says "200 OK 1/2", the rest just "2/2".
 */
function numberParts(trips: Trip[], r: SimResult): void {
  const parts = trips.filter((t) => t.chapter === 'page' && !t.outward);
  const seqOf = (t: Trip): number => r.packets.get(t.packetId)?.tcp?.relSeq ?? 0;
  const seqs = [...new Set(parts.map(seqOf))].sort((a, b) => a - b);
  if (streams(r) && seqs.length) {
    // In a stream the parts are bands of the whole reply, also the ones that have not been sent yet.
    const size = Math.max(...parts.map((t) => t.dataBytes));
    const of = Math.ceil((replyBytes(r) - (seqs[0]! - 1)) / size);
    for (const t of parts) t.part = { n: Math.floor((seqOf(t) - seqs[0]!) / size) + 1, of };
    return;
  }
  if (seqs.length < 2) return;
  const status = parts.find((t) => t.card && t.card !== 'data' && t.card !== 'page' && t.card !== 'ticket')?.card ?? '';
  for (const t of parts) {
    const n = seqs.indexOf(seqOf(t)) + 1;
    t.part = { n, of: seqs.length };
    t.card = n === 1 && status ? `${status} 1/${seqs.length}` : `${n}/${seqs.length}`;
  }
}

/** The name a certificate covers, read from its real bytes: this host, or a wildcard over it. */
function certifiedName(rec: OpenedRecord, host: string): string | undefined {
  const text = new TextDecoder('latin1').decode(rec.plaintext);
  return text.includes(host) || text.includes(`*.${host.split('.').slice(1).join('.')}`) ? host : undefined;
}

/** The first line of what a TLS record carries. */
const recordLine = (rec: OpenedRecord): string => new TextDecoder('latin1').decode(rec.plaintext.subarray(0, 300)).split('\r\n')[0] ?? '';

/** The most telling name for what a TLS record carries. */
function recordLabel(rec: OpenedRecord): string {
  if (rec.inner === TLS_APPLICATION_DATA) {
    const line = recordLine(rec);
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
      const len = flightBytes(f);
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
    if (main.inner === TLS_APPLICATION_DATA) t.message = httpMessage(recordLine(main));
    t.locked = main.inner === TLS_APPLICATION_DATA || !main.handshakes.some((h) => /Hello/.test(h));
    t.keyShare = !t.locked && starting.length > 0;
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
  const cert = opened.server.find((x) => x.handshakes.includes('Certificate'));
  const proof = cert && groups.get(`server|${flightOf('server', cert.offset)}`);
  for (const g of groups.values()) {
    const seqs = [...new Set(g.map((t) => r.packets.get(t.packetId)?.tcp?.relSeq ?? 0))].sort((a, b) => a - b);
    if (g === proof) for (const t of g) if ((r.packets.get(t.packetId)?.tcp?.relSeq ?? 0) === seqs[seqs.length - 1]) t.identity = certifiedName(cert!, session.host);
    if (seqs.length < 2) continue;
    for (const t of g) {
      const n = seqs.indexOf(r.packets.get(t.packetId)?.tcp?.relSeq ?? 0) + 1;
      t.card = `${t.card} ${n}/${seqs.length}`;
      t.quiet = n < seqs.length;
    }
  }
}
