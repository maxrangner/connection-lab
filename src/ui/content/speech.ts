import { flagNames, type LayerPdu, type SimEvent, type SimResult } from '../../sim';
import { machineFor, type MachineKind } from '../iso/machines/Machine';
import { fmtRate, fmtTime } from './format';

export type Tone = 'info' | 'good' | 'warn' | 'bad';

/** Trouble and results get a speech bubble; everything else is told by the animation (and the receipt). */
export type Category = 'trouble' | 'result' | 'info';

export interface Speech {
  machine: MachineKind;
  /** For port machines: which interface. */
  iface?: string;
  text: string;
  tone: Tone;
  /** First-time explanations and recovery events. */
  important: boolean;
  category: Category;
}

/** Which events deserve a bubble on stage. */
export function categoryOf(e: SimEvent, startDevice: string): Category {
  switch (e.type) {
    case 'drop':
    case 'tcp:retransmit':
    case 'tcp:ooo':
    case 'tcp:duplicate':
      return 'trouble';
    case 'timer:fire':
      return e.kind === 'tcp-timewait' ? 'info' : 'trouble';
    case 'tcp:dup-ack':
      return e.count === 1 ? 'trouble' : 'info';
    case 'tcp:state':
      return e.to === 'ESTABLISHED' && e.deviceId === startDevice ? 'result' : 'info';
    case 'app':
      if (e.action === 'error') return 'trouble';
      if (e.action === 'dns-lookup' && Number(e.info?.attempt) > 1) return 'trouble';
      if (e.action === 'dns-answer' || e.action === 'http-response-received' || e.action === 'done') return 'result';
      return 'info';
    default:
      return 'info';
  }
}

const STATE_MEANING: Record<string, string> = {
  SYN_SENT: 'asked to open a connection, waiting for the answer',
  SYN_RCVD: 'answered a connection request, waiting for the final ACK',
  ESTABLISHED: 'connection open, data can flow both ways',
  FIN_WAIT_1: 'sent FIN, waiting for it to be acknowledged',
  FIN_WAIT_2: 'my FIN was acknowledged, waiting for the other side to finish',
  CLOSE_WAIT: 'the other side has finished sending; the application should close too',
  LAST_ACK: 'sent my own FIN, waiting for the final ACK',
  TIME_WAIT: 'waiting 60 s (2 × maximum segment lifetime) so stray old segments die out before this port pair is reused',
  CLOSING: 'both sides sent FIN at the same time',
  CLOSED: 'the connection no longer exists',
};

/**
 * Turns events into what the acting machine says. Keeps per-run memory so the same explanation is given once
 * and repeats are short.
 */
export class SpeechWriter {
  private seen = new Set<string>();

  constructor(private readonly r: SimResult) {}

  private first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private kindOf(deviceId: string) {
    return this.r.scenario.devices.find((d) => d.id === deviceId)?.kind ?? 'laptop';
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

  speak(e: SimEvent): Speech | undefined {
    const s = this.speakRaw(e);
    if (s) s.category = categoryOf(e, this.r.scenario.startDevice);
    return s;
  }

  private speakRaw(e: SimEvent): Speech | undefined {
    const deviceId = 'deviceId' in e ? e.deviceId : e.type === 'tx' ? e.fromDevice : undefined;
    if (!deviceId) return undefined;
    const kind = this.kindOf(deviceId);
    const machine = machineFor(e, kind);
    if (!machine) return undefined;
    const say = (text: string | undefined, tone: Tone = 'info', important = false, iface?: string): Speech | undefined =>
      text ? { machine, text, tone, important, iface, category: 'info' } : undefined;
    const r = this.r;
    switch (e.type) {
      case 'app':
        return this.app(e, machine);
      case 'encapsulate':
        return this.encapsulate(e, machine);
      case 'decapsulate':
        return this.decapsulate(e, machine);
      case 'route': {
        const dev = r.scenario.devices.find((d) => d.id === deviceId)!;
        const isRouter = dev.kind === 'router' || dev.kind === 'home-router';
        if (!this.first(`route:${deviceId}:${e.dst}`)) return undefined;
        if (!isRouter) {
          const local = dev.routes.find((x) => x.prefixLen > 0);
          return say(
            e.route === 'default'
              ? `${e.dst} is not on my network ${local ? `${local.network}/${local.prefixLen}` : ''}. Default route: hand it to the gateway ${e.nextHop}.`
              : `${e.dst} is on my own network, I can deliver it directly.`,
            'info',
            true,
          );
        }
        return say(`Routing table: longest matching prefix for ${e.dst} is ${e.route}, so out of ${e.outIface.split('.')[1]} towards ${e.nextHop}.`, 'info', true);
      }
      case 'arp:miss':
        if (!this.first(`arpmiss:${deviceId}:${e.ip}`)) return undefined;
        return say(`I need the gateway's MAC address to build the frame, but my ARP cache has nothing for ${e.ip}. The packet waits while I ask.`, 'warn', true);
      case 'arp:hit':
        return undefined;
      case 'arp:learn':
        return say(this.first(`arplearn:${deviceId}`) ? `Noted: ${e.ip} is at ${e.mac}. I keep it in my ARP cache so I won't have to ask again for a while.` : `Noted: ${e.ip} is at ${e.mac}.`, 'good', this.first(`arplearn2:${deviceId}`));
      case 'tx': {
        const link = r.scenario.links.find((l) => l.id === e.linkId)!;
        if (!this.first(`tx:${e.linkId}`)) return undefined;
        return say(
          `${e.wireBytes} bytes (8 of them preamble) = ${(e.wireBytes * 8).toLocaleString('en')} bits onto ${link.name}. At ${fmtRate(link.bitsPerSecond)} that takes ${fmtTime(e.txEnd - e.start)}; the signal needs ${fmtTime(link.delay)} to reach the other end.`,
          'info',
          true,
          e.fromIface,
        );
      }
      case 'rx':
        return undefined;
      case 'forward':
        return say(this.first(`fwd:${deviceId}`) ? `Not for me, I forward it: TTL ${e.ttlBefore} → ${e.ttlAfter}, and a fresh header checksum because the header changed.` : `TTL ${e.ttlBefore} → ${e.ttlAfter}.`, 'info', this.first(`fwd2:${deviceId}`));
      case 'nat:add':
        return say(`New mapping: ${e.entry.inside.ip}:${e.entry.inside.port} ⇄ ${e.entry.outside.ip}:${e.entry.outside.port} for ${e.entry.proto.toUpperCase()} with ${e.entry.remote.ip}:${e.entry.remote.port}. Replies to that public port will find their way back.`, 'good', true);
      case 'nat:translate': {
        const key = `nat:${e.direction}:${deviceId}`;
        if (!this.first(key)) return say(`${e.direction === 'out' ? 'Source' : 'Destination'} ${e.before.ip}:${e.before.port} → ${e.after.ip}:${e.after.port}.`);
        return say(
          e.direction === 'out'
            ? `Private 192.168.x.x addresses are not routable on the internet, so I swap the source ${e.before.ip}:${e.before.port} → ${e.after.ip}:${e.after.port}: all your devices share my one public address. Checksums recomputed.`
            : `A reply to ${e.before.ip}:${e.before.port}: my table says that belongs to ${e.after.ip}:${e.after.port}. Rewritten.`,
          'info',
          true,
        );
      }
      case 'drop': {
        const why: Record<string, string> = {
          'not-for-me': 'This is not addressed to me, I ignore it.',
          'bad-checksum': 'Bad checksum. The bytes were damaged on the way; I throw the frame away.',
          'ttl-expired': 'TTL is 1: I may not forward this. Dropped.',
          'no-route': 'I have no route for this destination. Dropped.',
          'no-socket': 'No program is listening on that port. Dropped.',
          'no-nat-mapping': 'No NAT mapping for this: nobody inside asked for it. Dropped.',
          'arp-failed': 'Nobody answered my ARP requests. I give up on this packet.',
          fault: 'Lost.',
        };
        return say(why[e.reason], 'bad', true);
      }
      case 'timer:set': {
        const secs = fmtTime(e.fireAt - e.t);
        if (e.kind === 'tcp-rto') return say(this.first(`rto:${deviceId}`) ? `Copy kept on the shelf, retransmission timer set to ${secs}. If no ACK comes back in time I send it again.` : undefined, 'info', true);
        if (e.kind === 'dns-retry') return say(this.first(`dnst:${deviceId}`) ? `UDP never retransmits, so I keep my own ${secs} timeout for the DNS answer.` : undefined, 'info', true);
        if (e.kind === 'arp-retry') return say(this.first(`arpt:${deviceId}`) ? `If nobody answers within ${secs} I ask again.` : undefined);
        return say(this.first(`tw:${deviceId}`) ? `TIME_WAIT: I hold the port pair for ${secs} so late duplicates cannot confuse a new connection.` : undefined);
      }
      case 'timer:cancel':
        return undefined;
      case 'timer:fire':
        if (e.kind === 'tcp-timewait') return say('TIME_WAIT over, the connection is gone.');
        return say(e.kind === 'tcp-rto' ? 'Timer ran out and no ACK arrived. I assume the segment was lost.' : e.kind === 'dns-retry' ? 'No DNS answer within 5 s.' : 'No ARP reply within 1 s.', 'warn', true);
      case 'tcp:state':
        return say(`${e.from} → ${e.to}: ${STATE_MEANING[e.to] ?? ''}.`, e.to === 'ESTABLISHED' ? 'good' : 'info', e.to === 'ESTABLISHED' || e.to === 'CLOSED');
      case 'tcp:retransmit':
        return say(
          e.cause === 'fast'
            ? 'Three duplicate ACKs: the receiver is missing exactly one segment. I resend it now instead of waiting for the timer (fast retransmit).'
            : `Resending the oldest unacknowledged segment from my shelf, and doubling the timer to ${fmtTime(e.rto * 2)} (exponential backoff).`,
          'warn',
          true,
        );
      case 'tcp:dup-ack':
        return say(`Duplicate ACK #${e.count}: the other side still wants the same byte.`, 'warn', e.count === 1);
      case 'tcp:ooo':
        return say('This came after a gap. I keep it, but I can only hand bytes to the application in order. Duplicate ACK with a SACK block: "I still need the bytes before this".', 'warn', true);
      case 'tcp:duplicate':
        return say('I already have these bytes; dropping the copy and acknowledging again.', 'info', true);
      case 'tcp:deliver':
        return say(this.first(`deliver:${deviceId}`) ? `${e.bytes} bytes are exactly the next ones expected. Up to the application they go.` : `+${e.bytes} B to the application.`, 'good', this.first(`deliver2:${deviceId}`));
      case 'tcp:rtt':
        return undefined;
    }
  }

  private app(e: Extract<SimEvent, { type: 'app' }>, machine: MachineKind): Speech | undefined {
    const i = e.info ?? {};
    const n = e.pduId ? (this.r.pdus.get(e.pduId)?.bytes.length ?? 0) : 0;
    const say = (text: string, tone: Tone = 'info', important = true): Speech => ({ machine, text, tone, important, category: 'info' });
    switch (e.action) {
      case 'start':
        return say(`${i.url}? First I need the IP address of example.com.`);
      case 'dns-lookup':
        return Number(i.attempt) > 1
          ? say('No answer in time. I ask the same question again.', 'warn')
          : say(`Writing a ${n}-byte DNS question: "What is the IPv4 address of ${i.name}?" for the resolver at ${i.resolver}.`);
      case 'dns-serve':
        return say(`${i.name}? In my cache: ${(i.addresses as string[]).join(', ')}. (Without the cache I would ask the root, .com and example.com's own name servers.)`, 'good');
      case 'dns-answer': {
        const a = i.addresses as string[];
        return say(`example.com is at ${a.join(' and ')}, cacheable for ${i.ttl} s. I connect to the first one.`, 'good');
      }
      case 'http-request-sent':
        return say(`Connected. My request is ${n} bytes of plain text starting with "GET / HTTP/1.1". TCP will deliver it reliably.`);
      case 'http-request-received':
        return say(`"${i.requestLine}" for Host example.com. I have that.`, 'good');
      case 'http-response-sent':
        return say(`Here is the page: ${n} bytes, status line, headers and the HTML in chunked encoding. "Connection: close": I will close right after.`);
      case 'http-response-received':
        return say(`All ${i.bytes} bytes, in order, every checksum fine. "${i.status}". Rendering the page.`, 'good');
      case 'done':
        return say('The server closed its side, so I close mine. Each direction ends with its own FIN and ACK.', 'good');
      case 'error':
        return say(`Giving up: ${i.reason}.`, 'bad');
    }
    return undefined;
  }

  private encapsulate(e: Extract<SimEvent, { type: 'encapsulate' }>, machine: MachineKind): Speech | undefined {
    const pk = this.r.packets.get(e.packetId);
    const L = this.layers(e.pduId);
    const top = L[0];
    if (!top) return undefined;
    const say = (text: string | undefined, tone: Tone = 'info', important = false): Speech | undefined => (text ? { machine, text, tone, important, category: 'info' } : undefined);
    const retx = pk?.retransmitOf ? 'Again: ' : '';
    switch (e.protocol) {
      case 'dns':
      case 'http':
        return undefined;
      case 'udp':
        return say(this.first('encap:udp') ? `UDP bracket, 8 bytes: port ${this.field(e.pduId, 'udp.srcport')} → ${this.field(e.pduId, 'udp.dstport')}, a length and a checksum. No connection, no retransmission.` : undefined, 'info', true);
      case 'tcp': {
        const hl = top.headerEnd - top.start;
        const t = pk?.tcp;
        if (!t) return undefined;
        const fl = flagNames(t.flags);
        if (t.flags & 0x02 && !(t.flags & 0x10)) return say(`SYN chassis, ${hl} bytes: my random starting number is ${this.field(e.pduId, 'tcp.seq')}, and I offer MSS ${this.field(e.pduId, 'tcp.opt.mss')}, SACK, timestamps and window scaling.`, 'info', true);
        if (t.flags & 0x02) return say(`SYN-ACK: my own random number, and acknowledgment = their number + 1 ("I got your SYN").`, 'info', true);
        if (t.flags & 0x01) return say(this.first(`fin:${e.deviceId}`) ? `${retx}Nothing more to send: FIN. It still acknowledges everything received so far.` : undefined, 'info', true);
        if (t.len > 0) return say(`${retx}${t.len} bytes into a chassis with a ${hl}-byte header: seq ${t.relSeq}, ack ${t.relAck}, [${fl}].`, 'info', this.first(`data:${e.deviceId}`));
        return say(this.first(`ack:${e.deviceId}`) ? `Pure ACK, no data: "I have everything up to byte ${t.relAck}".` : undefined, 'info', true);
      }
      case 'ipv4':
        return say(this.first(`encap:ip:${e.deviceId}`) ? `IP plate, 20 bytes: from ${this.field(e.pduId, 'ipv4.src')} to ${this.field(e.pduId, 'ipv4.dst')}, TTL ${this.field(e.pduId, 'ipv4.ttl')}. Routers read this plate and nothing deeper.` : undefined, 'info', true);
      case 'arp': {
        const req = top.summary.startsWith('ARP who');
        return say(
          req
            ? `Everyone on the LAN: who has ${this.field(e.pduId, 'arp.tpa')}? Tell ${this.field(e.pduId, 'arp.spa')}.`
            : `That is me! ${this.field(e.pduId, 'arp.spa')} is at ${this.field(e.pduId, 'arp.sha')}. Replying directly.`,
          'info',
          true,
        );
      }
      case 'ethernet': {
        const pad = this.field(e.pduId, 'eth.padding');
        return say(this.first(`encap:eth:${e.deviceId}`) ? `Ethernet shell for this one hop: to ${this.field(e.pduId, 'eth.dst')}, from ${this.field(e.pduId, 'eth.src')}.${pad ? ` Padded with ${pad} to the 64-byte minimum.` : ''} The CRC seal at the back lets the receiver detect damage.` : undefined, 'info', true);
      }
    }
  }

  private decapsulate(e: Extract<SimEvent, { type: 'decapsulate' }>, machine: MachineKind): Speech | undefined {
    const L = this.layers(e.pduId);
    const say = (text: string | undefined, tone: Tone = 'info', important = false): Speech | undefined => (text ? { machine, text, tone, important, category: 'info' } : undefined);
    switch (e.layer) {
      case 2: {
        const inner = L[0]?.protocol === 'arp' ? 'ARP' : 'IPv4';
        return say(this.first(`decap2:${e.deviceId}:${inner}`) ? `CRC checks out and the MAC is mine${inner === 'ARP' ? ' (broadcast)' : ''}. EtherType says ${inner} inside. Shell off.` : undefined, 'good', true);
      }
      case 3: {
        const ip = this.r.scenario.devices.find((d) => d.id === e.deviceId)?.ifaces[0]?.ip;
        return say(this.first(`decap3:${e.deviceId}`) ? `Destination ${ip}: that is my own address, I keep it. Protocol field says ${L[0]?.protocol.toUpperCase()} inside. Plate off.` : undefined, 'good', true);
      }
      case 4: {
        const p = L[0]?.protocol;
        return say(
          p === 'dns'
            ? this.first(`decap4dns:${e.deviceId}`)
              ? 'Destination port tells me which program gets this. Bracket off, DNS message goes up.'
              : undefined
            : this.first(`decap4tcp:${e.deviceId}`)
              ? 'Sequence number checks out: these are exactly the next bytes. Chassis off, data goes up.'
              : undefined,
          'good',
          true,
        );
      }
      default:
        return undefined;
    }
  }
}
