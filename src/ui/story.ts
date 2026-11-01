import {
  clientHelloSni,
  flagNames,
  openRecords,
  sessionStream,
  TCP_ACK,
  TCP_FIN,
  TCP_RST,
  TCP_SYN,
  TLS_ALERT,
  TLS_APPLICATION_DATA,
  type AppAction,
  type Job,
  type Field,
  type LayerPdu,
  type OpenedRecord,
  type PacketInfo,
  type PduSnapshot,
  RTP_SAMPLES_PER_PACKET,
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
 * is simply the next trip. A voice call (scenario option `call`) has the DNS chapter and then one `call` chapter:
 * all its RTP packets, both ways, in one flow; a lost one is a gap nobody fills.
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
export type Chapter = 'address' | 'arp' | 'dns' | 'hello' | 'secret' | 'page' | 'call' | 'ping' | 'trace' | 'traffic' | 'attack';

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
  | { kind: 'travel'; from: string; to: string; link: string; /** Sim time the frame was sent. */ at: number; /** What anyone on this line could read. */ seen?: Seen; /** Seconds it waited in the port's buffer before it started on the cable; absent when it did not wait. */ queued?: number; /** Noisy Wi-Fi: the same frame sent again by the radio after an earlier copy was lost (the `lost` step just before it on this link). */ retry?: boolean; /** Noisy Wi-Fi: the receiver's Ack for this copy came back. */ acked?: boolean }
  /**
   * Knocked off the cable on the way from `from` to `to`. For a packet the port's full buffer turned away (`Trip.droppedAtQueue`)
   * `at` is when it was dropped and there is nothing `seen`: it never reached the cable.
   */
  | { kind: 'lost'; from: string; to: string; link: string; at: number; seen?: Seen }
  | { kind: 'read'; device: string }
  /** A server does its job before it answers: the resolver finds the name in its book, the web server the file on its shelf. */
  | { kind: 'lookup'; device: string; what: 'dns' | 'web'; /** What was asked. */ ask: string; /** What it found. */ found: string }
  /** HTTPS: the sender puts a padlock on the card with its session key, the receiver opens it with the same key. */
  | { kind: 'lock'; device: string }
  | { kind: 'unlock'; device: string }
  /** A reply of many packets: they and their ACKs stream along the cables at once, drawn small. */
  | { kind: 'flow'; packets: Trip[] }
) & { /** The packet's header fields once this step is done, if it changes them. */ details?: Details; /** The exact bytes it left behind, for the hex view. */ pdu?: PduSnapshot };

export interface Trip {
  packetId: string;
  chapter: Chapter;
  /** Sim time the packet was made. */
  start: number;
  /** Sim time it first set off on a cable: the order the trips are told in. A question made before the router's address was known comes after the ARP that found it. */
  sent: number;
  origin: string;
  /** Sent by a device a page is opened on (rather than coming back to one). */
  outward: boolean;
  /** The device whose fetch this packet belongs to: the one that sent it, or the one its reply is for. */
  client: string;
  /** The ACK that ends the three-way hello: a whole packet, not a small block. */
  hello?: boolean;
  /** Text on the data card ("GET /", "example.com?"), or null for a packet with no data (SYN, ACK). */
  card: string | null;
  dataBytes: number;
  /** The transport, or none: an ARP message rides straight in the frame. */
  l4: 'tcp' | 'udp' | 'none';
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
  /** Lost before it left: the port's transmit buffer was full, so it fell off the tray at that device, not off the cable. */
  droppedAtQueue?: boolean;
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
  /** A voice call gathered into one flow: every RTP packet of both directions, each with its `part` and `client`. */
  kind?: 'call';
  /** A voice packet's sound: its real µ-law bytes. */
  audio?: Uint8Array;
  /** A traceroute probe: the TTL it set out with, which is how many hops it may go. */
  probeTtl?: number;
}

/** A frame the stranger picked out of the air, and what it could read of it. */
export interface Heard {
  packetId: string;
  seen: Seen;
}

/** What a port scan found, from its own events. */
export interface Scan {
  device: string;
  /** The address it scanned. */
  to: string;
  /** Every port it tried. No answer may mean anything: the door is walled up, or the knock or the answer was lost. */
  ports: { port: number; answer: 'open' | 'closed' | null; packetId: string }[];
}

/** What ping or traceroute found out, from the app's own events: the replies with their round trips, or the hops. */
export interface Probe {
  kind: 'ping' | 'traceroute';
  /** What was asked for ("example.com"). */
  to: string;
  /** Ping: each echo reply as it came in, and the packet that brought it. */
  replies: { seq: number; from: string; ttl: number; rttMs: number; packetId: string }[];
  /** Traceroute: each answered probe and the packet that answered it; `reached` when that came from the destination itself. */
  hops: { ttl: number; probe: number; from: string; rttMs: number; reached: boolean; packetId: string }[];
  /** The closing line (ping: sent, received, lossPct, minMs, avgMs, maxMs; traceroute: hops, reached, path), once it is there. */
  done: Record<string, string | number | string[]> | null;
}

/** What a device doing something this run has to show on its screen. */
export interface Screenful {
  /** What it asked for ("example.com"), and the address that turned into, if it did. */
  site: string;
  address: string | null;
  /** It wanted a page, so none arriving is a failure. */
  browsing: boolean;
  /** The page's <title> if the page arrived, else null. */
  pageTitle: string | null;
  /** What it was sent, if that is a picture: its real bytes as a data URL. */
  image: string | null;
}

export interface Story {
  /** The site the browser asked for ("example.com"). */
  site: string;
  /** The device the page is opened on (laptop or phone). */
  client: string;
  /** Every device with a job this run, in the order of their job numbers: the client, the attackers, those that joined in. */
  clients: string[];
  /** The devices that had an action added during the run, in the order of their job numbers. */
  joiners: string[];
  /** The attackers sending packets this run. Whatever they send runs alongside the rest from the start. */
  attackers: string[];
  /** The stranger by the Wi-Fi, who only hears, and what it heard. */
  listener?: string;
  heard: Heard[];
  scan?: Scan;
  /** The devices whose browser got what it asked for. */
  fetched: string[];
  /** What each of those devices shows. */
  screens: Record<string, Screenful>;
  /** All traffic goes through the VPN server. */
  vpn: boolean;
  /** The resolver has nothing cached and walks root → TLD → authoritative: those three servers are on the table. */
  cold: boolean;
  /** The device starts with no address and gets one by DHCP first. */
  dhcp: boolean;
  /** A voice call to the friend instead of a page. */
  call: boolean;
  /**
   * The call's sound, as G.711 µ-law bytes (decode with ulawDecode): what the caller says, and what it heard, one entry per
   * packet of the friend's clip: the bytes that came, or null for a packet that never arrived.
   */
  voice?: { sent: Uint8Array; heard: (Uint8Array | null)[] };
  /** A thin pipe: the line to the ISP is slow and its port's buffer small, so packets queue there and the tail can be dropped. */
  thin: boolean;
  /** Noisy Wi-Fi: the chance any one frame on the air is lost to interference; 0 when the radio is a perfect cable. */
  noise: number;
  /** Which device each address belongs to. */
  names: Record<string, string>;
  devices: { id: string; label: string; kind: string; actions: Job[]; color?: string }[];
  /** Cables, with their one-way delay in seconds, and the frames a port's buffer holds when it is finite. */
  links: { id: string; a: string; b: string; delay: number; medium: 'cable' | 'wifi'; queue?: number }[];
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
  /** When the device pings or traces the path to the site instead of fetching the page. */
  probe?: Probe;
  /** The same for each ping or trace added on another device. */
  joinProbes: { device: string; probe: Probe }[];
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

/** "ARP who has 192.168.1.1? tell 192.168.1.23" → "who has 192.168.1.1?", "ARP 192.168.1.1 is at a4:…" → "at a4:…". */
export function arpCardLabel(summary: string): string {
  const who = /^ARP (who has \S+\?)/.exec(summary);
  if (who) return who[1]!;
  return /is at (\S+)/.exec(summary)?.[1] !== undefined ? `at ${/is at (\S+)/.exec(summary)![1]}` : 'ARP';
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

/** "DHCP DISCOVER · xid 0x1a2b3c4d" → "DISCOVER", "DHCP OFFER 192.168.1.23 · xid …" → "OFFER 192.168.1.23". */
export function dhcpCardLabel(summary: string): string {
  const m = /^DHCP (\w+)( \d+\.\d+\.\d+\.\d+)?/.exec(summary);
  return m ? `${m[1]}${m[2] ?? ''}` : 'DHCP';
}

/**
 * "ICMP echo request · id 0x9977 seq 1 · 56 B data" → "ping 1/4", a reply → "pong 1/4" (with ping's count when known),
 * "ICMP time exceeded: …" → "TTL ran out", "ICMP destination unreachable: port unreachable" → "no such port".
 */
export function icmpCardLabel(summary: string, count?: number): string {
  const echo = /^ICMP echo (request|reply) · id \S+ seq (\d+)/.exec(summary);
  if (echo) return `${echo[1] === 'request' ? 'ping' : 'pong'} ${echo[2]}${count ? `/${count}` : ''}`;
  if (summary.startsWith('ICMP time exceeded')) return 'TTL ran out';
  if (summary.includes('port unreachable')) return 'no such port';
  return summary.startsWith('ICMP destination unreachable') ? 'unreachable' : 'ICMP';
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
  const arp = pdu && layer(pdu, 'arp');
  if (arp) return { from: field(arp, 'arp.spa'), to: field(arp, 'arp.tpa'), lines: [arpCardLabel(arp.summary)], kind: 'open' };
  const ip = pdu && layer(pdu, 'ipv4');
  if (!pdu || !ip) return undefined;
  const base = { from: field(ip, 'ipv4.src'), to: field(ip, 'ipv4.dst') };
  const dns = layer(pdu, 'dns');
  if (dns) return { ...base, lines: [dnsCardLabel(dns.summary)], kind: 'open' };
  const dhcp = layer(pdu, 'dhcp');
  if (dhcp) return { ...base, lines: [dhcpCardLabel(dhcp.summary)], kind: 'open' };
  // Plain RTP: anyone on the line could listen in.
  const rtp = layer(pdu, 'rtp');
  if (rtp) return { ...base, lines: [`voice, ${field(rtp, 'rtp.payload')}`], kind: 'open' };
  if (p.kind === 'flood') return { ...base, lines: ['junk'], kind: 'open' };
  const icmp = layer(pdu, 'icmp');
  if (icmp) return { ...base, lines: [icmpCardLabel(icmp.summary)], kind: 'open' };
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
  // An ICMP message has no transport: like an ARP message, the whole thing is the card.
  const app = layer(pdu, 'http') ?? layer(pdu, 'dns') ?? layer(pdu, 'dhcp') ?? layer(pdu, 'rtp') ?? layer(pdu, 'tls') ?? layer(pdu, 'arp') ?? layer(pdu, 'icmp');
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

/**
 * Which packets the story follows, and which of them end a hello. ARP only when asked for: it is the first thing on the
 * cable, and the dullest. Pings, probes and the ICMP answers to them are the whole point of a probe run.
 */
function chosen(r: SimResult, arp: boolean): { packets: PacketInfo[]; hellos: Set<string> } {
  const packets: PacketInfo[] = [];
  const hellos = new Set<string>();
  const helloAckFrom = new Set<string>();
  for (const p of r.packets.values()) {
    // A Wi-Fi Ack is the radio's own business: the frame it answers gets `acked` on its travel step instead.
    if (p.kind === 'wifi-ack') continue;
    if (p.kind === 'dns' || p.kind === 'dhcp' || p.kind === 'rtp' || p.kind === 'icmp' || p.kind === 'probe' || p.kind === 'flood' || (p.kind === 'arp' && arp)) {
      packets.push(p);
      continue;
    }
    if (p.kind !== 'tcp' || !p.tcp) continue;
    const { flags, len } = p.tcp;
    if (flags & TCP_FIN) continue;
    // A reset is the whole answer a port scan gets, and what ends a connection the other side has forgotten.
    if (flags & TCP_SYN || flags & TCP_RST || len > 0) {
      packets.push(p);
      continue;
    }
    // The third handshake packet: the first empty ACK from whoever sent the first SYN.
    const opener = [...r.packets.values()].find((q) => q.tcp && q.tcp.flags === TCP_SYN && q.tcp.connId === p.tcp!.connId);
    const hello = flags === TCP_ACK && opener?.origin === p.origin && !helloAckFrom.has(p.tcp.connId);
    if (hello) {
      helloAckFrom.add(p.tcp.connId);
      hellos.add(p.id);
    }
    if (hello || (flags === TCP_ACK && !answersFin(r, p))) packets.push(p);
  }
  return { packets, hellos };
}

/** The device at the other end of a link from `device`. */
function otherEnd(r: SimResult, linkId: string, device: string): string {
  const link = r.scenario.links.find((l) => l.id === linkId);
  const owner = (iface: string): string | undefined => r.scenario.devices.find((d) => d.ifaces.some((i) => i.id === iface))?.id;
  return (link ? [owner(link.a), owner(link.b)] : []).find((d) => d && d !== device) ?? device;
}

/** An ACK beyond all the data the other side sent: it answers that side's FIN, which is teardown. */
function answersFin(r: SimResult, ack: PacketInfo): boolean {
  const other = [...r.packets.values()].filter((q) => q.tcp?.len && q.origin !== ack.origin && q.job === ack.job);
  return (ack.tcp?.relAck ?? 0) > Math.max(...other.map((q) => (q.tcp?.relSeq ?? 0) + (q.tcp?.len ?? 0)));
}

function trip(r: SimResult, p: PacketInfo, asked: Map<string, number>, clients: string[], attackers: string[]): Trip | null {
  const steps: Step[] = [];
  let frame: PduSnapshot | undefined;
  /** The packet as the sender first made it, before any VPN sealed it. */
  let inner: PduSnapshot | undefined;
  let tunnel = 0;
  let droppedAtQueue = false;
  /** A noisy radio sends a lost frame again by itself, so a loss there does not end the trip. */
  const noisy = (link: string): boolean => (r.scenario.links.find((l) => l.id === link)?.noise ?? 0) > 0;
  /** The last time this packet was on `link`: a travel that got across, or a lost copy. */
  const lastOn = (link: string): Extract<Step, { kind: 'travel' | 'lost' }> | undefined =>
    [...steps].reverse().find((s): s is Extract<Step, { kind: 'travel' | 'lost' }> => (s.kind === 'travel' || s.kind === 'lost') && s.link === link);
  /** Seconds the frame about to travel waited in a port's buffer, from the queue event just before its tx. */
  let queued = 0;
  let firstSeq = -1;
  let done = false;
  /** The frame on the current link, so the receiver unwraps the same kind it was sent in. */
  let onLink: Frame | undefined;
  /** The packet as it is right now: built up by the sender, then rewritten hop by hop. */
  let now: Details = {};
  let nowPdu: PduSnapshot | undefined;
  const update = (pduId: string): void => {
    nowPdu = r.pdus.get(pduId);
    now = { ...now, ...detailsOf(nowPdu) };
  };
  for (const e of r.events as SimEvent[]) {
    if (done) break;
    if (!('packetId' in e) || e.packetId !== p.id) continue;
    if (firstSeq < 0) firstSeq = e.seq;
    const count = steps.length;
    switch (e.type) {
      case 'encapsulate': {
        update(e.pduId);
        // The ARP or ICMP message itself is made, not wrapped: its frame, or its IP header, comes next.
        if (e.protocol === 'arp' || e.protocol === 'icmp') break;
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
        if (w === 'l4' || (w === 'eth' && p.kind === 'arp') || (w === 'ip' && p.kind === 'icmp')) done = true;
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
      case 'queue':
        queued = e.wait;
        break;
      case 'tx': {
        const before = lastOn(e.linkId);
        // Sent again on a noisy radio after it had already got across: its Ack was lost, and the far end throws the copy
        // away. The trip has moved on; the copy is not shown.
        if (before?.kind === 'travel' && noisy(e.linkId)) break;
        steps.push({ kind: 'travel', from: e.fromDevice, to: e.toDevice, link: e.linkId, at: e.start, seen: seenOn(r.pdus.get(e.frameId), p), ...(queued > 0 ? { queued } : {}), ...(before?.kind === 'lost' ? { retry: true } : {}) });
        queued = 0;
        break;
      }
      case 'wifi:retry':
        // The copy about to go has the Retry bit set: that is the frame the next travel shows, unless it is a needless copy.
        if (lastOn(e.linkId)?.kind === 'lost') update(e.frameId);
        break;
      case 'wifi:ack': {
        const got = lastOn(e.linkId);
        if (got?.kind === 'travel') got.acked = true;
        break;
      }
      case 'drop': {
        const last = steps[steps.length - 1];
        if (e.reason === 'duplicate-frame') break;
        if ((e.reason === 'fault' || e.reason === 'cut' || e.reason === 'interference') && last?.kind === 'travel' && (!e.linkId || last.link === e.linkId)) {
          steps[steps.length - 1] = { ...last, kind: 'lost' };
          // On a noisy radio the sender tries the same frame again by itself: the next tx on this link is the retry, and
          // only giving up (retry-limit) ends the trip.
          if (noisy(last.link)) break;
        } else if ((e.reason === 'interference' || e.reason === 'retry-limit') && e.linkId && lastOn(e.linkId)?.kind === 'travel') {
          // A needless copy (the frame had got across, only its Ack was lost) fell or was given up: the trip has moved on.
          break;
        } else if (e.reason === 'queue-full' && e.deviceId && e.linkId) {
          // The port's buffer was full, so it never left: there is no travel to turn into a loss. Its fall is told on the
          // line it was bound for, from the moment it was turned away, after the wrap at that device; nobody on the line saw it.
          steps.push({ kind: 'lost', from: e.deviceId, to: otherEnd(r, e.linkId, e.deviceId), link: e.linkId, at: e.t });
          droppedAtQueue = true;
        }
        done = true;
        break;
      }
    }
    if (steps.length > count) Object.assign(steps[steps.length - 1]!, { details: now, pdu: nowPdu });
  }
  if (!frame || !steps.some((s) => s.kind === 'travel' || s.kind === 'lost')) return null;
  // Lost for good only when the last thing that happened was a fall: a radio's retry that got across goes on.
  const lost = steps[steps.length - 1]!.kind === 'lost';

  const eth = layer(frame, 'ethernet') ?? layer(frame, 'wifi')!;
  const packet = inner ?? frame;
  // An ARP message has no IP or transport: the whole thing is its card. An ICMP message has IP but no transport: same.
  const arp = p.kind === 'arp' ? layer(packet, 'arp') : undefined;
  const icmp = p.kind === 'icmp' ? layer(packet, 'icmp') : undefined;
  const ip = layer(packet, 'ipv4');
  const l4 = layer(packet, 'tcp') ?? layer(packet, 'udp');
  if (!arp && (!ip || (!l4 && !icmp))) return null;
  const app = layer(packet, 'http') ?? layer(packet, 'dns') ?? layer(packet, 'dhcp') ?? layer(packet, 'rtp');
  const dataBytes = arp ? arp.end - arp.start : icmp ? icmp.end - icmp.start : l4!.payloadEnd - l4!.headerEnd;
  const appCard = (a: LayerPdu): string => (a.protocol === 'http' ? cardLabel(a.summary) : a.protocol === 'dhcp' ? dhcpCardLabel(a.summary) : a.protocol === 'rtp' ? 'voice' : dnsCardLabel(a.summary));
  // What the device is running: ping numbers its cards out of its count, traceroute's probes say their TTL.
  const apps = r.scenario.devices.flatMap((d) => d.apps);
  const probeApp = apps.find((a) => a.kind === 'ping');
  const probeTtl = p.kind === 'probe' ? parseInt(field(ip, 'ipv4.ttl'), 10) : undefined;
  const card = arp ? arpCardLabel(arp.summary) : icmp ? icmpCardLabel(icmp.summary, probeApp?.count) : probeTtl !== undefined ? `TTL ${probeTtl}` : p.kind === 'flood' ? 'junk' : dataBytes > 0 ? (app ? appCard(app) : 'data') : null;
  const isTcp = l4?.protocol === 'tcp';
  const origin = steps[0]!.kind === 'travel' || steps[0]!.kind === 'lost' ? (steps[0] as { from: string }).from : (steps[0] as { device: string }).device;

  if (card) steps.unshift({ kind: 'appear', device: origin, details: detailsOf(packet), pdu: packet });
  const last = steps[steps.length - 1];
  if (card && last?.kind === 'unwrap' && (last.layer === 'l4' || (arp && last.layer === 'eth') || (icmp && last.layer === 'ip'))) steps.push({ kind: 'read', device: last.device });

  const flags = p.tcp?.flags ?? 0;
  const firstTx = steps.find((s): s is Extract<Step, { kind: 'travel' | 'lost' }> => s.kind === 'travel' || s.kind === 'lost');
  const to = arp ? field(arp, 'arp.tpa') : field(ip, 'ipv4.dst');
  // A DNS question asked again by the same device of the same server, or the same DHCP message sent again: its timer ran
  // out. (A cold resolver asks the same question of one server after another on its way down the hierarchy; those are not
  // retries, and nor is a walk it makes for another job.)
  const askKey = p.kind === 'dhcp' ? `${origin}|${card}` : `${p.job}|${origin}>${to}`;
  const ownDhcp = p.kind === 'dhcp' && clients.includes(origin);
  const askedAt = p.kind === 'dns' || ownDhcp ? asked.get(askKey) : undefined;
  if ((p.kind === 'dns' && packet.layers.some((x) => x.summary.startsWith('DNS query'))) || ownDhcp) asked.set(askKey, p.createdAt);
  const resend = r.events.find((e) => e.type === 'tcp:retransmit' && e.packetId === p.id);
  const timer = resend?.type === 'tcp:retransmit' && resend.cause === 'rto' ? resend.rto : askedAt !== undefined ? p.createdAt - askedAt : undefined;
  const client = clients[p.job]!;
  const tracing = r.scenario.devices.find((d) => d.id === client)?.apps.some((a) => a.kind === 'traceroute');
  // Echoes are ping's; probes, and the errors they provoke, traceroute's (an error in a ping run is ping's too).
  const chapter: Chapter = attackers.includes(client) ? 'attack' : arp ? 'arp' : p.kind === 'dhcp' ? 'address' : p.kind === 'dns' ? 'dns' : p.kind === 'rtp' ? 'call' : p.kind === 'probe' ? 'trace' : icmp ? (icmp.summary.startsWith('ICMP echo') || !tracing ? 'ping' : 'trace') : dataBytes > 0 || flags & TCP_RST ? 'page' : 'hello';
  return {
    packetId: p.id,
    chapter,
    ...(probeTtl !== undefined ? { probeTtl } : {}),
    start: p.createdAt,
    sent: firstTx?.at ?? p.createdAt,
    origin,
    outward: clients.includes(origin),
    client,
    card,
    dataBytes,
    l4: arp || icmp ? 'none' : isTcp ? 'tcp' : 'udp',
    l4Label: arp || icmp ? '' : isTcp ? (dataBytes > 0 ? 'TCP' : flagNames(flags).replace(/, /g, '-')) : 'UDP',
    header: { eth: eth.headerEnd - eth.start, ip: ip ? ip.headerEnd - ip.start : 0, l4: l4 ? l4.headerEnd - l4.start : 0 },
    tunnel,
    trailer: eth.end - eth.payloadEnd,
    from: arp ? field(arp, 'arp.spa') : field(ip, 'ipv4.src'),
    to,
    message: messageOf(app),
    steps,
    lost,
    ...(droppedAtQueue ? { droppedAtQueue } : {}),
    retry: !!p.retransmitOf || askedAt !== undefined,
    retransmitOf: p.retransmitOf,
    timedOut: timer !== undefined,
    waited: timer,
    // A voice packet is one of its clip's 50, in either direction.
    ...(p.rtp ? { part: { n: p.rtp.part, of: p.rtp.of } } : {}),
    ...(p.rtp && app ? { audio: packet.bytes.slice(app.headerEnd, app.payloadEnd) } : {}),
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

/** The real picture the server sends this job (it is known before it arrives, so a sheet can show what has come so far). */
function imageOf(r: SimResult, job: number): string | null {
  const pduOf = (e: SimEvent): PduSnapshot | undefined => ('pduId' in e && e.pduId ? r.pdus.get(e.pduId) : undefined);
  const sent = r.events.find((e) => {
    const pdu = pduOf(e);
    return e.type === 'app' && e.action === 'http-response-sent' && !!pdu && r.packets.get(pdu.packetId)?.job === job;
  });
  const bytes = sent && pduOf(sent)?.bytes;
  if (!bytes) return null;
  const text = new TextDecoder('latin1').decode(bytes);
  const end = text.indexOf('\r\n\r\n');
  if (end < 0 || !/^content-type: image\/jpeg/im.test(text.slice(0, end))) return null;
  return `data:image/jpeg;base64,${btoa(Array.from(bytes.subarray(end + 4), (b) => String.fromCharCode(b)).join(''))}`;
}

/** What the client's browser got (another device fetching at the same time does not count). */
function pageTitle(r: SimResult, client: string): string | null {
  const got = r.events.find((e) => e.type === 'app' && e.action === 'http-response-received' && e.deviceId === client);
  const pdu = got && 'pduId' in got && got.pduId ? r.pdus.get(got.pduId) : undefined;
  if (!pdu) return null;
  const text = new TextDecoder('latin1').decode(pdu.bytes);
  if (/^content-type: image\//im.test(text)) return 'photo';
  return /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || 'example.com';
}

/**
 * The call's sound: the caller's own clip, and what it heard of the friend's, packet by packet from the real bytes of each
 * 'rtp-received' (the friend's clip is known, so a packet that never came is a null the UI can show as a hole).
 */
function voiceOf(r: SimResult, client: string): Story['voice'] {
  const call = r.scenario.devices.find((d) => d.id === client)?.apps.find((a) => a.kind === 'voice-call');
  if (call?.kind !== 'voice-call') return undefined;
  const peer = r.scenario.devices.flatMap((d) => d.apps).find((a) => a.kind === 'voice-peer');
  const heard: (Uint8Array | null)[] = Array.from({ length: peer?.kind === 'voice-peer' ? Math.ceil(peer.clip.length / RTP_SAMPLES_PER_PACKET) : 0 }, () => null);
  for (const e of r.events) {
    if (e.type !== 'app' || e.action !== 'rtp-received' || e.deviceId !== client || !e.pduId) continue;
    const pdu = r.pdus.get(e.pduId);
    const rtp = pdu && layer(pdu, 'rtp');
    const part = pdu && r.packets.get(pdu.packetId)?.rtp?.part;
    if (rtp && part) heard[part - 1] = pdu.bytes.slice(rtp.headerEnd, rtp.payloadEnd);
  }
  return { sent: call.clip, heard };
}

/** What ping or traceroute reported, from its own events, for the owner to show as it likes. */
function probeOf(r: SimResult, client: string): Probe | undefined {
  const start = r.events.find((e) => e.type === 'app' && (e.app === 'ping' || e.app === 'traceroute') && e.action === 'start' && e.deviceId === client);
  if (start?.type !== 'app') return undefined;
  const infos = (action: AppAction): Record<string, string | number | string[]>[] =>
    r.events.flatMap((e) => (e.type === 'app' && e.deviceId === client && e.action === action ? [e.info ?? {}] : []));
  /** The packet each of these events was about, in the same order as `infos`. */
  const packets = (action: AppAction): string[] =>
    r.events.flatMap((e) => (e.type === 'app' && e.deviceId === client && e.action === action ? [r.pdus.get(e.pduId ?? '')?.packetId ?? ''] : []));
  const num = (v: unknown): number => Number(v ?? 0);
  const str = (v: unknown): string => String(v ?? '');
  return {
    kind: start.app === 'ping' ? 'ping' : 'traceroute',
    to: str(start.info?.to),
    replies: infos('ping-reply').map((i, n) => ({ seq: num(i.seq), from: str(i.from), ttl: num(i.ttl), rttMs: num(i.rttMs), packetId: packets('ping-reply')[n]! })),
    hops: infos('trace-hop').map((i, n) => ({ ttl: num(i.ttl), probe: num(i.probe), from: str(i.from), rttMs: num(i.rttMs), reached: i.reached === 1, packetId: packets('trace-hop')[n]! })),
    done: infos('ping-done')[0] ?? infos('trace-done')[0] ?? null,
  };
}

function dnsAnswer(r: SimResult, client: string, action: 'dns-answer' | 'dns-cache-hit' = 'dns-answer'): string | null {
  const e = r.events.find((x) => x.type === 'app' && x.action === action && x.deviceId === client);
  const a = e?.type === 'app' ? e.info?.addresses : undefined;
  return Array.isArray(a) ? (a[0] ?? null) : null;
}

/** What a device has to show for its job. */
function screenOf(r: SimResult, device: string, job: number): Screenful {
  const start = r.events.find((e) => e.type === 'app' && e.action === 'start' && e.deviceId === device);
  const url = start?.type === 'app' ? String(start.info?.url ?? '') : '';
  return {
    // A call starts with the friend's name instead of a URL.
    site: url ? new URL(url).hostname : start?.type === 'app' ? String(start.info?.to ?? '') : '',
    address: dnsAnswer(r, device, 'dns-cache-hit') ?? dnsAnswer(r, device),
    browsing: !!r.scenario.devices.find((d) => d.id === device)?.apps.some((a) => a.kind === 'browser'),
    pageTitle: pageTitle(r, device),
    image: imageOf(r, job),
  };
}

/** What the stranger heard: every frame on the air, read from its bytes as anyone without the keys would. */
function heardOf(r: SimResult): Heard[] {
  const heard = new Map<string, Heard>();
  for (const e of r.events) {
    if (e.type !== 'app' || e.action !== 'overheard' || !e.pduId) continue;
    const pdu = r.pdus.get(e.pduId);
    const p = pdu && r.packets.get(pdu.packetId);
    const seen = p && seenOn(pdu, p);
    if (seen && !heard.has(p.id)) heard.set(p.id, { packetId: p.id, seen });
  }
  return [...heard.values()];
}

/** What a port scan reported. */
function scanOf(r: SimResult): Scan | undefined {
  const start = r.events.find((e) => e.type === 'app' && e.action === 'scan-start');
  if (start?.type !== 'app') return undefined;
  const answers = new Map(r.events.flatMap((e) => (e.type === 'app' && e.action === 'scan-port' ? [[Number(e.info?.port), e] as const] : [])));
  const tried = Array.isArray(start.info?.ports) ? start.info.ports.map(Number) : [];
  const ports = tried.map((port) => {
    const e = answers.get(port);
    return { port, answer: e ? (e.info?.open === 1 ? ('open' as const) : ('closed' as const)) : null, packetId: r.pdus.get(e?.pduId ?? '')?.packetId ?? '' };
  });
  return { device: start.deviceId, to: String(start.info?.to ?? ''), ports };
}

export interface StoryOptions {
  /** Follow the ARP exchange too (who has the router's address?), before the DNS question. */
  arp?: boolean;
}

export function buildStory(r: SimResult, opts: StoryOptions = {}): Story {
  const asked = new Map<string, number>();
  const client = r.scenario.startDevice;
  const attackers = (r.scenario.attackers ?? []).map((a) => a.device);
  const joiners = (r.scenario.companions ?? []).map((c) => c.device);
  const clients = [client, ...attackers, ...joiners];
  const listener = r.scenario.links.find((l) => l.overheardBy)?.overheardBy;
  const scan = scanOf(r);
  const { packets, hellos } = chosen(r, !!opts.arp);
  const trips = packets
    .map((p) => trip(r, p, asked, clients, attackers))
    .filter((t): t is Trip => !!t)
    .sort((a, b) => a.sent - b.sent || a.start - b.start);
  for (const t of trips) if (hellos.has(t.packetId)) t.hello = true;
  const tls = r.scenario.devices.find((d) => d.id === client)?.apps.find((a) => a.kind === 'browser')?.tls;
  if (tls) labelTls(trips, r, tls, client);
  numberParts(trips, r, client);
  const title = pageTitle(r, client);
  addLookups(trips, title);
  const voice = voiceOf(r, client);
  const probe = probeOf(r, client);
  const joinProbes = joiners.flatMap((device) => {
    const found = probeOf(r, device);
    return found ? [{ device, probe: found }] : [];
  });
  // A job that joined in goes after the first job's own story: dropping a card must not change what was told before it.
  const own = trips.filter((t) => t.client === client);
  const gathered = gatherProbes(probe ? quickLookup(own) : own);
  const told = voice ? gatherCall(gathered) : streams(r) ? gatherStream(gathered, client) : smallAcks(gathered);
  const shown = [...told, ...trips.filter((t) => t.client !== client)];
  const screens = Object.fromEntries(clients.map((c, job) => [c, screenOf(r, c, job)]));
  const wifiIfaces = new Set(r.scenario.devices.flatMap((d) => d.ifaces.filter((i) => i.wifi).map((i) => i.id)));
  const ifaceDevice = new Map(r.scenario.devices.flatMap((d) => d.ifaces.map((i) => [i.id, d.id] as const)));
  return {
    devices: r.scenario.devices.map((d) => ({ id: d.id, label: d.label, kind: d.kind, actions: d.actions ?? [], ...(d.color ? { color: d.color } : {}) })),
    links: r.scenario.links.map((l) => ({
      id: l.id,
      a: ifaceDevice.get(l.a) ?? l.a,
      b: ifaceDevice.get(l.b) ?? l.b,
      delay: l.delay,
      medium: wifiIfaces.has(l.a) || wifiIfaces.has(l.b) ? ('wifi' as const) : ('cable' as const),
      ...(l.queue !== undefined ? { queue: l.queue } : {}),
    })),
    site: screens[client]!.site,
    client,
    clients,
    joiners,
    attackers,
    ...(listener ? { listener } : {}),
    heard: heardOf(r),
    ...(scan ? { scan } : {}),
    fetched: clients.filter((c) => r.events.some((e) => e.type === 'app' && e.action === 'http-response-received' && e.deviceId === c)),
    screens,
    vpn: r.scenario.devices.some((d) => d.tunnel),
    cold: r.scenario.devices.some((d) => d.apps.some((a) => a.kind === 'dns-server' && !!a.upstream)),
    dhcp: r.scenario.devices.some((d) => d.id === client && d.apps.some((a) => a.kind === 'dhcp-client')),
    call: !!voice,
    ...(voice ? { voice } : {}),
    thin: r.scenario.links.some((l) => l.queue !== undefined),
    noise: Math.max(0, ...r.scenario.links.map((l) => l.noise ?? 0)),
    // An address a device gets by DHCP belongs to whoever has the MAC it is leased to.
    names: Object.fromEntries(r.scenario.devices.flatMap((d) => [
      ...d.ifaces.flatMap((i) => [i.ip, ...(i.aliases ?? [])].map((ip) => [ip, d.label])),
      ...(d.tunnel ? [[d.tunnel.ip, d.label]] : []),
      ...Object.entries(d.dhcp?.leases ?? {}).flatMap(([mac, ip]) => r.scenario.devices.filter((x) => x.ifaces.some((i) => i.mac === mac)).map((x) => [ip, x.label])),
    ])),
    trips: shown,
    pageTitle: title,
    image: screens[client]!.image,
    dnsAnswer: dnsAnswer(r, client),
    dnsTtl: (() => {
      const e = r.events.find((x) => x.type === 'app' && x.action === 'dns-answer' && x.deviceId === client);
      const ttl = e?.type === 'app' ? Number(e.info?.ttl) : NaN;
      return Number.isFinite(ttl) ? ttl : null;
    })(),
    remembered: dnsAnswer(r, client, 'dns-cache-hit'),
    ...(probe ? { probe } : {}),
    joinProbes,
  };
}

/**
 * The ACK that ends the hello is a whole packet. The rest run as small blocks, as in a stream: there is nothing to open, but
 * you see the receiver answer, so a sender that hears nothing has a visible reason to wait.
 */
function smallAcks(trips: Trip[], from: Chapter = 'dns'): Trip[] {
  let chapter = from;
  return trips.map((t) => {
    if (t.l4Label !== 'ACK' || t.hello) {
      chapter = t.chapter;
      return t;
    }
    return { ...t, chapter, lost: false, retry: false, timedOut: false, steps: [{ kind: 'flow', packets: [t] }] };
  });
}

/**
 * The reply and the ACKs for it become one step from its first packet on. What else was said then (a TLS goodbye and the ACK
 * for that, another device's own fetch) goes on after it. A lookup stays in front of the stream.
 */
function gatherStream(trips: Trip[], client: string): Trip[] {
  const inStream = (t: Trip): boolean => t.client === client && (!!t.part || (t.l4Label === 'ACK' && !t.hello && t.outward));
  const first = trips.findIndex((t) => t.part);
  if (first < 0) return smallAcks(trips);
  const packets = trips.slice(first).filter(inStream);
  const lookups = packets.flatMap((t) => t.steps.filter((s) => s.kind === 'lookup'));
  const stream: Trip = { ...trips[first]!, part: undefined, retry: false, timedOut: false, lost: false, locked: false, steps: [...lookups, { kind: 'flow', packets }] };
  return [...smallAcks(trips.slice(0, first)), stream, ...smallAcks(trips.slice(first).filter((t) => !inStream(t)), 'page')];
}

/**
 * A call: from its first voice packet on, every voice packet of both directions becomes one flow step on one trip (as the
 * photo's reply does), each packet keeping its own part number and client. What is not voice goes on after it.
 */
function gatherCall(trips: Trip[]): Trip[] {
  const first = trips.findIndex((t) => t.chapter === 'call');
  if (first < 0) return smallAcks(trips);
  const packets = trips.slice(first).filter((t) => t.chapter === 'call');
  const call: Trip = { ...trips[first]!, part: undefined, retry: false, timedOut: false, lost: false, kind: 'call', steps: [{ kind: 'flow', packets }] };
  return [...smallAcks(trips.slice(0, first)), call, ...smallAcks(trips.slice(first).filter((t) => t.chapter !== 'call'), 'call')];
}

/**
 * Ping and traceroute are not about the name, so its lookup runs as small blocks, every packet of it still there.
 */
function quickLookup(trips: Trip[]): Trip[] {
  const first = trips.findIndex((t) => t.chapter === 'dns');
  if (first < 0) return trips;
  let end = first;
  while (trips[end]?.chapter === 'dns') end++;
  const packets = trips.slice(first, end);
  return [...trips.slice(0, first), { ...packets[0]!, retry: false, timedOut: false, lost: false, steps: [{ kind: 'flow', packets }] }, ...trips.slice(end)];
}

/**
 * Traceroute's three probes of a TTL differ only in their port and their timing, and ping's echoes hardly at all. The first
 * and its answer go in full; the others and their answers run as small blocks, so all of them are there but each is only
 * watched once.
 */
function gatherProbes(trips: Trip[]): Trip[] {
  const shown: Trip[] = [];
  const seen = new Set<number>();
  let quick: Trip[] = [];
  const flush = (): void => {
    if (quick.length) shown.push({ ...quick[0]!, retry: false, timedOut: false, lost: false, steps: [{ kind: 'flow', packets: quick }] });
    quick = [];
  };
  for (const t of trips) {
    const again = (t.probeTtl !== undefined && seen.has(t.probeTtl)) || (t.card?.startsWith('ping ') && !t.card.startsWith('ping 1/'));
    if (t.probeTtl !== undefined) seen.add(t.probeTtl);
    const answer = (t.chapter === 'trace' && t.probeTtl === undefined) || t.chapter === 'ping';
    if (again || (quick.length && answer)) quick.push(t);
    else {
      flush();
      shown.push(t);
    }
  }
  flush();
  return shown;
}

/**
 * Before a server answers it does its job. The resolver finds the name in its book, for each answer it sends; the web
 * server takes the file off its shelf once per fetch, for the first packet of the reply. Both show what the real messages carry.
 */
function addLookups(trips: Trip[], title: string | null): void {
  const path = new Map<string, string>();
  const served = new Set<string>();
  for (const t of trips) {
    const m = t.message;
    if (m?.kind === 'http-request') path.set(t.client, m.path);
    if (m?.kind === 'dns-answer') t.steps.unshift({ kind: 'lookup', device: t.origin, what: 'dns', ask: m.name, found: t.card ?? '' });
    if (m?.kind === 'http-response' && !served.has(t.client)) {
      served.add(t.client);
      t.steps.unshift({ kind: 'lookup', device: t.origin, what: 'web', ask: path.get(t.client) ?? '/', found: (t.client === trips[0]?.client ? title : null) ?? t.card ?? '' });
    }
  }
}

/**
 * A reply too big for one packet goes out in numbered parts (by where each sits in the byte stream; a resend keeps
 * its number). The first part's card says "200 OK 1/2", the rest just "2/2". Only the client's own page: a device
 * fetching alongside gets the plain one-packet page.
 */
function numberParts(trips: Trip[], r: SimResult, client: string): void {
  const parts = trips.filter((t) => t.chapter === 'page' && !t.outward && t.client === client && t.dataBytes > 0);
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
function labelTls(trips: Trip[], r: SimResult, session: TlsSession, client: string): void {
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
    if (!info || !t.dataBytes || t.client !== client) continue;
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
