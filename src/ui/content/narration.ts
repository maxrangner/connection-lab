import { flagNames, type LayerPdu, type SimEvent, type SimResult } from '../../sim';

export function fmtTime(s: number): string {
  const a = Math.abs(s);
  if (a === 0) return '0 s';
  if (a < 1e-6) return `${(s * 1e9).toFixed(0)} ns`;
  if (a < 1e-3) return `${(s * 1e6).toFixed(a < 1e-5 ? 2 : 1)} µs`;
  if (a < 1) return `${(s * 1e3).toFixed(a < 0.01 ? 3 : 2)} ms`;
  return `${s.toFixed(2)} s`;
}

export function fmtRate(bps: number): string {
  if (bps >= 1e9) return `${bps / 1e9} Gbit/s`;
  if (bps >= 1e6) return `${bps / 1e6} Mbit/s`;
  return `${bps / 1e3} kbit/s`;
}

export interface Narration {
  /** One or two sentences for the caption bar, or undefined for silent bookkeeping events. */
  caption?: string;
  /** A few words shown next to the device. */
  badge?: string;
  /** Badge tone. */
  tone?: 'info' | 'good' | 'warn' | 'bad';
}

const STATE_MEANING: Record<string, string> = {
  SYN_SENT: 'it has asked to open a connection and waits for the answer',
  SYN_RCVD: 'it has answered a connection request and waits for the final ACK',
  ESTABLISHED: 'the connection is open; data can flow both ways',
  FIN_WAIT_1: 'it has sent FIN and waits for it to be acknowledged',
  FIN_WAIT_2: 'its FIN was acknowledged; it waits for the other side to finish',
  CLOSE_WAIT: 'the other side has finished sending; the application should close too',
  LAST_ACK: 'it has sent its own FIN and waits for the final ACK',
  TIME_WAIT: 'it waits 60 s (2 × maximum segment lifetime) so stray old segments die out before the port pair is reused',
  CLOSING: 'both sides sent FIN at the same time',
  CLOSED: 'the connection no longer exists',
};

/** Builds captions and badges from events. Keeps per-run memory so repeated events are not over-explained. */
export class Narrator {
  private seen = new Set<string>();

  constructor(private readonly r: SimResult) {}

  private first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private label(deviceId: string): string {
    return this.r.scenario.devices.find((d) => d.id === deviceId)?.label ?? deviceId;
  }

  private layers(pduId: string | undefined): LayerPdu[] {
    return (pduId && this.r.pdus.get(pduId)?.layers) || [];
  }

  private field(pduId: string | undefined, key: string): string {
    for (const l of this.layers(pduId)) {
      const stack = [...l.fields];
      while (stack.length) {
        const f = stack.shift()!;
        if (f.key === key) return f.display;
        if (f.children) stack.push(...f.children);
      }
    }
    return '';
  }

  narrate(e: SimEvent): Narration {
    const r = this.r;
    switch (e.type) {
      case 'app':
        return this.app(e);
      case 'encapsulate':
        return this.encapsulate(e);
      case 'decapsulate':
        return this.decapsulate(e);
      case 'route': {
        const dev = r.scenario.devices.find((d) => d.id === e.deviceId)!;
        const isRouter = dev.kind === 'router' || dev.kind === 'home-router';
        const badge = `route ${e.dst} → ${e.route === 'default' ? `gateway ${e.nextHop}` : e.route}`;
        if (!isRouter) {
          if (!this.first(`route:${e.deviceId}:${e.dst}`)) return { badge };
          const local = dev.routes.find((x) => x.prefixLen > 0);
          return {
            badge,
            caption:
              e.route === 'default'
                ? `${e.dst} is not on the local network ${local ? `${local.network}/${local.prefixLen}` : ''}, so the laptop sends it to its default gateway, ${e.nextHop} (the home router).`
                : `${e.dst} is on the local network, so it can be delivered directly.`,
          };
        }
        if (!this.first(`route:${e.deviceId}:${e.dst}`)) return { badge };
        return {
          badge,
          caption: `${this.label(e.deviceId)} looks up ${e.dst} in its routing table: the longest matching prefix is ${e.route}, so it goes out of ${e.outIface.split('.')[1]} towards ${e.nextHop}.`,
        };
      }
      case 'arp:miss':
        if (!this.first(`arpmiss:${e.deviceId}:${e.ip}`)) return { badge: 'waiting for ARP…', tone: 'warn' };
        return {
          badge: `ARP cache: no MAC for ${e.ip}`,
          tone: 'warn',
          caption: `To put the packet in an Ethernet frame, the ${this.label(e.deviceId).toLowerCase()} needs the gateway's MAC address. Its ARP cache has no entry for ${e.ip}, so the packet waits while it asks.`,
        };
      case 'arp:hit':
        return { badge: `ARP cache: ${e.ip} = ${e.mac}` };
      case 'arp:learn':
        return {
          badge: `ARP cache + ${e.ip} → ${e.mac}`,
          tone: 'good',
          caption: `${this.label(e.deviceId)} stores ${e.ip} → ${e.mac} in its ARP cache, so it won't have to ask again for a while.`,
        };
      case 'tx': {
        const link = r.scenario.links.find((l) => l.id === e.linkId)!;
        const bits = e.wireBytes * 8;
        const key = `tx:${e.linkId}`;
        const caption = this.first(key)
          ? `Out on ${link.name}: ${e.wireBytes} bytes (incl. 8 bytes of preamble) = ${bits.toLocaleString('en')} bits. At ${fmtRate(link.bitsPerSecond)} sending takes ${fmtTime(e.txEnd - e.start)}; the signal then needs ${fmtTime(link.delay)} to reach the other end.`
          : undefined;
        return { caption };
      }
      case 'rx':
        return {};
      case 'forward':
        return {
          badge: `TTL ${e.ttlBefore} → ${e.ttlAfter}`,
          caption: this.first(`fwd:${e.deviceId}`)
            ? `${this.label(e.deviceId)} is a router: it decrements Time to Live ${e.ttlBefore} → ${e.ttlAfter} and recomputes the IP header checksum, because the header changed.`
            : undefined,
        };
      case 'nat:add':
        return {
          badge: `NAT + ${e.entry.inside.ip}:${e.entry.inside.port} ⇄ ${e.entry.outside.ip}:${e.entry.outside.port}`,
          tone: 'good',
          caption: `New NAT entry (${e.entry.proto.toUpperCase()}): ${e.entry.inside.ip}:${e.entry.inside.port} ⇄ ${e.entry.outside.ip}:${e.entry.outside.port} for traffic with ${e.entry.remote.ip}:${e.entry.remote.port}. Replies to the public port will find their way back.`,
        };
      case 'nat:translate': {
        const badge = `NAT ${e.direction === 'out' ? 'src' : 'dst'} ${e.before.ip}:${e.before.port} → ${e.after.ip}:${e.after.port}`;
        const key = `nat:${e.direction}:${e.deviceId}`;
        if (!this.first(key)) return { badge };
        return {
          badge,
          caption:
            e.direction === 'out'
              ? `NAT rewrites the source ${e.before.ip}:${e.before.port} → ${e.after.ip}:${e.after.port}. Private 192.168.x.x addresses are not routable on the internet, so all your devices share one public address. The IP and transport checksums are recomputed.`
              : `A reply to ${e.before.ip}:${e.before.port}: NAT looks up its table and rewrites the destination back to ${e.after.ip}:${e.after.port}.`,
        };
      }
      case 'drop': {
        if (e.reason === 'fault')
          return {
            badge: 'lost!',
            tone: 'bad',
            caption: 'Lost! The frame never arrives (a full queue, interference, a bad cable). Nobody is told: the sender has to notice on its own.',
          };
        const why: Record<string, string> = {
          'not-for-me': 'is not addressed to it, so it ignores it',
          'bad-checksum': 'has a bad checksum, so it discards it',
          'ttl-expired': 'has TTL 1, so it discards it',
          'no-route': 'has no route for it',
          'no-socket': 'has no program listening on that port',
          'no-nat-mapping': 'has no NAT mapping for it',
          'arp-failed': 'never got an ARP answer',
        };
        return {
          badge: `dropped: ${e.reason}`,
          tone: 'bad',
          caption: e.deviceId ? `${this.label(e.deviceId)} sees the packet ${why[e.reason] ?? e.reason}.` : undefined,
        };
      }
      case 'timer:set': {
        const secs = fmtTime(e.fireAt - e.t);
        if (e.kind === 'tcp-rto')
          return {
            badge: `⏱ RTO ${secs}`,
            caption: this.first(`rto:${e.deviceId}`)
              ? `TCP keeps a copy of what it sent and starts a retransmission timer (${secs}). If no ACK arrives in time, it sends the data again.`
              : undefined,
          };
        if (e.kind === 'dns-retry')
          return {
            badge: `⏱ DNS timeout ${secs}`,
            caption: this.first(`dnst:${e.deviceId}`) ? `UDP has no retransmission, so the resolver library sets its own ${secs} timeout.` : undefined,
          };
        if (e.kind === 'arp-retry') return { badge: `⏱ ARP retry ${secs}` };
        return { badge: `⏱ TIME_WAIT ${secs}` };
      }
      case 'timer:cancel':
        return {};
      case 'timer:fire': {
        if (e.kind === 'tcp-timewait') return { badge: 'TIME_WAIT over' };
        const what = e.kind === 'tcp-rto' ? 'No ACK arrived before the retransmission timer ran out.' : e.kind === 'dns-retry' ? 'No DNS answer within 5 s.' : 'No ARP reply within 1 s.';
        return { badge: '⏰ timeout', tone: 'warn', caption: what };
      }
      case 'tcp:state':
        return {
          badge: `TCP ${e.from} → ${e.to}`,
          caption: `${this.label(e.deviceId)} TCP: ${e.from} → ${e.to}: ${STATE_MEANING[e.to] ?? ''}.`,
        };
      case 'tcp:retransmit':
        return {
          badge: e.cause === 'fast' ? 'fast retransmit' : 'retransmit',
          tone: 'warn',
          caption:
            e.cause === 'fast'
              ? 'Three duplicate ACKs: TCP retransmits the missing segment right away instead of waiting for the timer (fast retransmit).'
              : `TCP sends the oldest unacknowledged segment again and doubles the timer to ${fmtTime(e.rto * 2)} (exponential backoff).`,
        };
      case 'tcp:dup-ack':
        return { badge: `dup ACK #${e.count}`, tone: 'warn' };
      case 'tcp:ooo':
        return {
          badge: 'out of order: buffered',
          tone: 'warn',
          caption: 'This segment arrived after a gap. TCP keeps it, but can only hand data to the application in order. It sends a duplicate ACK with a SACK block: "I still need the bytes before this."',
        };
      case 'tcp:duplicate':
        return { badge: 'duplicate: ACK again', caption: 'TCP already has these bytes, so it drops the copy and acknowledges again.' };
      case 'tcp:deliver':
        return { badge: `+${e.bytes} B → app`, tone: 'good' };
      case 'tcp:rtt':
        return { badge: `RTT ${fmtTime(e.sample)}` };
    }
  }

  private app(e: Extract<SimEvent, { type: 'app' }>): Narration {
    const i = e.info ?? {};
    const n = e.pduId ? this.r.pdus.get(e.pduId)?.bytes.length ?? 0 : 0;
    switch (e.action) {
      case 'start':
        return { badge: `${i.url}`, caption: `You asked the browser for ${i.url}. Before it can connect, it needs the IP address of example.com.` };
      case 'dns-lookup':
        return Number(i.attempt) > 1
          ? { badge: 'DNS: asking again', tone: 'warn', caption: 'No answer in time, so the resolver library sends the same question again.' }
          : {
              badge: 'DNS: example.com A?',
              caption: `The stub resolver writes a ${n}-byte DNS question: "What is the IPv4 address (A record) of ${i.name}?" It will ask the resolver at ${i.resolver}.`,
            };
      case 'dns-serve':
        return {
          badge: `cache hit: ${(i.addresses as string[]).join(', ')}`,
          tone: 'good',
          caption: `The resolver has example.com in its cache and answers immediately with ${(i.addresses as string[]).length} addresses. (Without the cache it would first ask the root, .com and example.com's own name servers.)`,
        };
      case 'dns-answer': {
        const a = i.addresses as string[];
        return {
          badge: `example.com = ${a[0]}`,
          tone: 'good',
          caption: `The answer arrives: example.com is at ${a.join(' and ')} (cacheable for ${i.ttl} s). The browser connects to the first one.`,
        };
      }
      case 'http-request-sent':
        return { badge: 'HTTP GET /', caption: `Connected. The browser writes its HTTP request: ${n} bytes of plain text starting with "GET / HTTP/1.1". TCP will deliver it reliably.` };
      case 'http-request-received':
        return { badge: String(i.requestLine), tone: 'good', caption: `TCP hands the bytes to the web server in order. It parses "${i.requestLine}" and the Host header: example.com.` };
      case 'http-response-sent':
        return {
          badge: 'HTTP 200 OK',
          caption: `The server (a Cloudflare edge, answering from its cache) writes the ${n}-byte response: status line, headers and the HTML, in chunked encoding. "Connection: close" means it will close right after.`,
        };
      case 'http-response-received':
        return {
          badge: `${i.status}`,
          tone: 'good',
          caption: `All ${i.bytes} bytes arrived, in order, with every checksum correct. The browser parses "${i.status}" and the HTML: this is the page.`,
        };
      case 'done':
        return { badge: 'page loaded ✓', tone: 'good', caption: 'The server closed its side, so the browser closes too. Each direction is closed with its own FIN and ACK.' };
      case 'error':
        return { badge: `error: ${i.reason}`, tone: 'bad', caption: `The browser gives up: ${i.reason}.` };
    }
    return {};
  }

  private encapsulate(e: Extract<SimEvent, { type: 'encapsulate' }>): Narration {
    const pk = this.r.packets.get(e.packetId);
    const L = this.layers(e.pduId);
    const top = L[0];
    if (!top) return {};
    const retx = pk?.retransmitOf ? 'Retransmission: ' : '';
    switch (e.protocol) {
      case 'dns':
      case 'http':
        return {};
      case 'udp': {
        const sp = this.field(e.pduId, 'udp.srcport');
        const dp = this.field(e.pduId, 'udp.dstport');
        return {
          badge: `+UDP 8 B`,
          caption: this.first('encap:udp')
            ? `UDP adds an 8-byte header: source port ${sp}, destination port ${dp}. No connection, no retransmission: just ports, a length and a checksum.`
            : undefined,
        };
      }
      case 'tcp': {
        const hl = top.headerEnd - top.start;
        const t = pk?.tcp;
        const fl = t ? flagNames(t.flags) : '';
        let caption: string | undefined;
        if (t && t.flags & 0x02 && !(t.flags & 0x10)) {
          caption = `TCP builds a SYN segment: ${hl} bytes of header, no data. It picks a random initial sequence number (${this.field(e.pduId, 'tcp.seq')}) and offers options: MSS ${this.field(e.pduId, 'tcp.opt.mss')}, SACK, timestamps and window scaling.`;
        } else if (t && t.flags & 0x02) {
          caption = `The server's TCP answers SYN-ACK: its own random sequence number, and acknowledgment = the client's number + 1 ("I got your SYN").`;
        } else if (t && t.flags & 0x01) {
          caption = this.first(`fin:${e.deviceId}`) ? `${retx}Nothing more to send: TCP sends FIN. The ${top.headerEnd - top.start}-byte segment still acknowledges everything received so far.` : undefined;
        } else if (t && t.len > 0) {
          caption = `${retx}TCP puts ${t.len} bytes into a segment with a ${hl}-byte header: relative sequence number ${t.relSeq}, ACK ${t.relAck}, flags ${fl}.`;
        } else if (t) {
          caption = this.first(`ack:${e.deviceId}`)
            ? `TCP sends a pure ACK (no data): "I have everything up to byte ${t.relAck}" (relative numbering; real numbers start at the random ISN).`
            : undefined;
        }
        return { badge: `+TCP ${hl} B [${fl}]`, caption };
      }
      case 'ipv4':
        return {
          badge: '+IPv4 20 B',
          caption: this.first(`encap:ip:${e.deviceId}`)
            ? `IPv4 adds a 20-byte header: from ${this.field(e.pduId, 'ipv4.src')} to ${this.field(e.pduId, 'ipv4.dst')}, TTL ${this.field(e.pduId, 'ipv4.ttl')}, protocol ${this.field(e.pduId, 'ipv4.proto')}. These addresses are what routers read.`
            : undefined,
        };
      case 'arp': {
        const req = top.summary.startsWith('ARP who');
        return {
          badge: req ? 'ARP request' : 'ARP reply',
          caption: req
            ? `ARP request: "Who has ${this.field(e.pduId, 'arp.tpa')}? Tell ${this.field(e.pduId, 'arp.spa')}." It is sent to every device on the LAN.`
            : `${this.label(e.deviceId)} owns ${this.field(e.pduId, 'arp.spa')}, so it replies directly: "${this.field(e.pduId, 'arp.spa')} is at ${this.field(e.pduId, 'arp.sha')}."`,
        };
      }
      case 'ethernet': {
        const dst = this.field(e.pduId, 'eth.dst');
        const pad = this.field(e.pduId, 'eth.padding');
        return {
          badge: '+Ethernet 14 B +FCS 4 B',
          caption: this.first(`encap:eth:${e.deviceId}`)
            ? `Ethernet wraps it for this one hop: to ${dst}, from ${this.field(e.pduId, 'eth.src')}.${pad ? ` The frame is padded with ${pad} to the 64-byte minimum.` : ''} A 4-byte CRC at the end lets the receiver detect damage.`
            : undefined,
        };
      }
    }
  }

  private decapsulate(e: Extract<SimEvent, { type: 'decapsulate' }>): Narration {
    const L = this.layers(e.pduId);
    const dev = this.label(e.deviceId);
    switch (e.layer) {
      case 2: {
        const inner = L[0]?.protocol === 'arp' ? 'ARP' : 'IPv4';
        return {
          badge: '−Ethernet',
          caption: this.first(`decap2:${e.deviceId}:${inner}`)
            ? `${dev} checks the frame: the CRC is correct and the destination MAC matches${inner === 'ARP' ? ' (broadcast)' : ''}. EtherType says ${inner} is inside, so the Ethernet header is removed.`
            : undefined,
        };
      }
      case 3:
        return {
          badge: '−IPv4',
          caption: this.first(`decap3:${e.deviceId}`)
            ? `The destination IP is the ${dev.toLowerCase()}'s own address (${this.r.scenario.devices.find((d) => d.id === e.deviceId)?.ifaces[0]?.ip}), so it keeps the packet. The protocol field says ${L[0]?.protocol.toUpperCase()} is inside, so the IP header is removed.`
            : undefined,
        };
      case 4: {
        const p = L[0]?.protocol;
        return {
          badge: p === 'dns' ? '−UDP → resolver' : '−TCP → app',
          caption:
            p === 'dns'
              ? this.first(`decap4dns:${e.deviceId}`)
                ? `The destination port tells ${dev.toLowerCase()} which program gets the data. UDP removes its 8-byte header and hands the DNS message over.`
                : undefined
              : this.first(`decap4tcp:${e.deviceId}`)
                ? `TCP checks the sequence number: these bytes are exactly the next ones expected, so it passes them to the application.`
                : undefined,
        };
      }
      default:
        return {};
    }
  }
}
