import type { Ip4 } from '../bytes/addr';
import { concat } from '../bytes/bytes';
import type { TcpState } from '../events/SimEvent';
import type { Protocol } from '../proto/types';
import {
  buildTcp,
  TCP_ACK,
  TCP_FIN,
  TCP_PSH,
  TCP_RST,
  TCP_SYN,
  type ParsedTcp,
  type TcpOption,
} from '../proto/tcp';
import type { Host } from './Host';

// Real-world constants (Linux-like stack following the RFCs).
const INITIAL_RTO = 1; // RFC 6298 §2.1
const MIN_RTO = 1; // RFC 6298 §2.4 (Linux uses 200 ms; we follow the RFC)
const MAX_RTO = 60;
const SYN_RETRIES = 6; // Linux net.ipv4.tcp_syn_retries
const DATA_RETRIES = 15; // Linux net.ipv4.tcp_retries2
const TIME_WAIT = 60; // Linux TCP_TIMEWAIT_LEN (2 × MSL)
const RECV_BUFFER = 64240; // first window Linux advertises: 44 × 1460
const DEFAULT_PEER_MSS = 536; // RFC 9293: assume 536 if the peer sends no MSS option
const INITIAL_CWND_SEGMENTS = 10; // RFC 6928
const APP_WAKEUP = 0.0001; // time for a blocked application to be scheduled and read from its socket

// Sequence numbers wrap at 2^32: compare by signed distance, never by size.
export const seqAdd = (a: number, n: number): number => (a + n) >>> 0;
export const seqDiff = (a: number, b: number): number => (a - b) | 0; // signed distance a - b
export const seqLt = (a: number, b: number): boolean => seqDiff(a, b) < 0;
export const seqLe = (a: number, b: number): boolean => seqDiff(a, b) <= 0;

interface OutSegment {
  seq: number;
  data: Uint8Array;
  syn: boolean;
  fin: boolean;
  psh: boolean;
  sentAt: number;
  retransmits: number;
  /** Written off by a timeout: to be sent again as the window allows. */
  lost: boolean;
  packetId: string;
  label: string;
}

interface WriteRecord {
  start: number; // stream offset
  end: number;
  label: string;
  parts: number;
}

export interface TcpHandlers {
  onConnected?(conn: TcpConnection): void;
  onData?(conn: TcpConnection, data: Uint8Array, packetId: string): void;
  onPeerClose?(conn: TcpConnection): void;
  onClosed?(conn: TcpConnection): void;
  onError?(conn: TcpConnection, reason: string): void;
}

export interface TcpConnOptions {
  /** MSS this side advertises. */
  mss: number;
  /** Window scale shift this side offers. */
  wscale: number;
  /** Application protocol carried, for decoding snapshots. */
  app: Protocol;
}

export class TcpConnection {
  state: TcpState = 'CLOSED';
  readonly id: string;
  handlers: TcpHandlers = {};

  // send side
  private iss = 0;
  private sndUna = 0;
  private sndNxt = 0;
  private sndWnd = 0;
  private pending: Uint8Array = new Uint8Array(0);
  private pendingStreamOffset = 0; // stream offset of pending[0]
  private writes: WriteRecord[] = [];
  private streamWritten = 0;
  private outstanding: OutSegment[] = [];
  private finQueued = false;
  private finSent = false;
  private dupAcks = 0;
  /** After a fast retransmit: everything sent up to here must be ACKed before recovery is over (RFC 6582). */
  private recover: number | undefined;
  /** What the peer's latest SACK option says it already holds beyond its ACK: a timeout need not resend it (RFC 6675, in short). */
  private sacked: [number, number][] = [];
  // congestion control (RFC 5681); the window opens with the first data
  private cwnd: number | undefined;
  private ssthresh = Infinity;

  // receive side
  private irs = 0;
  private rcvNxt = 0;
  private ooo = new Map<number, { data: Uint8Array; fin: boolean; packetId: string }>();
  private delivered = 0;

  // negotiated options
  private peerMss = DEFAULT_PEER_MSS;
  private peerWscale = 0;
  private wsOk = false;
  private sackOk = false;
  private tsOk = false;
  private tsOffset = 0;
  private tsRecent = 0;
  private peerSackPerm = false;

  // timers (RFC 6298)
  private rto = INITIAL_RTO;
  private srtt: number | undefined;
  private rttvar = 0;
  private rtoTimer: number | undefined;
  private rtoTimerId: string | undefined;
  private twTimer: number | undefined;

  constructor(
    readonly host: Host,
    readonly localIp: Ip4,
    readonly localPort: number,
    readonly remoteIp: Ip4,
    readonly remotePort: number,
    readonly opts: TcpConnOptions,
  ) {
    this.id = `${host.id}:${localPort}-${remoteIp}:${remotePort}`;
    this.tsOffset = host.random32();
  }

  get key(): string {
    return `${this.localPort}|${this.remoteIp}|${this.remotePort}`;
  }

  // ───────────────────────────── public API ─────────────────────────────

  connect(): void {
    this.iss = this.host.random32();
    this.sndUna = this.iss;
    this.sndNxt = this.iss;
    this.setState('SYN_SENT');
    this.sendNew({ syn: true, fin: false, data: new Uint8Array(0), label: 'SYN' });
  }

  /** Passive open: called by the host's listener with the incoming SYN. */
  acceptSyn(seg: ParsedTcp): void {
    this.state = 'LISTEN'; // spawned from the listening socket
    this.irs = seg.seq;
    this.rcvNxt = seqAdd(seg.seq, 1);
    this.readSynOptions(seg);
    this.updateTs(seg, true);
    this.iss = this.host.random32();
    this.sndUna = this.iss;
    this.sndNxt = this.iss;
    this.sndWnd = seg.window; // SYN windows are never scaled
    this.setState('SYN_RCVD');
    this.sendNew({ syn: true, fin: false, data: new Uint8Array(0), label: 'SYN-ACK' });
  }

  write(data: Uint8Array, label: string): void {
    const parts = Math.max(1, Math.ceil(data.length / this.sendMss()));
    this.writes.push({ start: this.streamWritten, end: this.streamWritten + data.length, label, parts });
    this.streamWritten += data.length;
    this.pending = concat(this.pending, data);
    this.output();
  }

  close(): void {
    this.finQueued = true;
    this.output();
  }

  // ───────────────────────────── input ─────────────────────────────

  input(seg: ParsedTcp, payload: Uint8Array, packetId: string): void {
    const syn = (seg.flags & TCP_SYN) !== 0;
    const fin = (seg.flags & TCP_FIN) !== 0;
    const ack = (seg.flags & TCP_ACK) !== 0;

    if (seg.flags & TCP_RST) {
      this.reset(seg);
      return;
    }

    if (this.state === 'SYN_SENT') {
      if (syn && ack && seg.ack === seqAdd(this.iss, 1)) {
        this.irs = seg.seq;
        this.rcvNxt = seqAdd(seg.seq, 1);
        this.readSynOptions(seg);
        this.updateTs(seg, true);
        this.sndWnd = seg.window;
        this.processAck(seg);
        this.setState('ESTABLISHED');
        this.sendAck('ACK');
        this.handlers.onConnected?.(this);
        this.output();
      }
      return;
    }

    if (syn) {
      // A retransmitted SYN (our SYN-ACK was lost) or SYN-ACK (our ACK was lost): answer again.
      if (this.state === 'SYN_RCVD' && seg.seq === this.irs) {
        this.host.sim.emit({ type: 'tcp:duplicate', deviceId: this.host.id, connId: this.id, packetId });
        const synAck = this.outstanding.find((s) => s.syn);
        if (synAck) this.retransmit(synAck, 'dup-syn', false);
      } else {
        this.host.sim.emit({ type: 'tcp:duplicate', deviceId: this.host.id, connId: this.id, packetId });
        this.sendAck('ACK');
      }
      return;
    }

    // Only a segment at or before what we last ACKed may set the clock we echo (RFC 7323 §4.3).
    if (this.tsOk && seqLe(seg.seq, this.rcvNxt)) this.updateTs(seg);

    if (ack) {
      const sack = seg.options.find((o) => o.kind === 'sack');
      if (sack?.kind === 'sack') this.sacked = sack.blocks;
      if (this.state === 'SYN_RCVD' && seqLt(this.iss, seg.ack) && seqLe(seg.ack, this.sndNxt)) {
        this.processAck(seg);
        this.setState('ESTABLISHED');
        this.handlers.onConnected?.(this);
      } else if (seqLt(this.sndUna, seg.ack) && seqLe(seg.ack, this.sndNxt)) {
        this.processAck(seg);
      } else if (
        seg.ack === this.sndUna &&
        payload.length === 0 &&
        !fin &&
        this.outstanding.length > 0 &&
        (this.wsOk ? seg.window << this.peerWscale : seg.window) === this.sndWnd
      ) {
        this.dupAcks++;
        this.host.sim.emit({ type: 'tcp:dup-ack', deviceId: this.host.id, connId: this.id, count: this.dupAcks, packetId });
        // Already recovering, dup ACKs are only new data arriving behind a hole being filled (RFC 6582 section 3.2).
        if (this.dupAcks === 3 && this.recover === undefined) {
          const first = this.outstanding[0];
          if (first) {
            this.recover = this.sndNxt;
            this.retransmit(first, 'fast', false);
          }
        }
      }
      this.sndWnd = this.wsOk ? seg.window << this.peerWscale : seg.window;
    }

    if (payload.length > 0 || fin) this.receiveData(seg.seq, payload, fin, packetId);
    this.output();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private receiveData(seq: number, payload: Uint8Array, fin: boolean, packetId: string): void {
    const sim = this.host.sim;
    if (this.state === 'TIME_WAIT' || this.state === 'CLOSED') {
      this.sendAck('ACK');
      return;
    }
    let data = payload;
    let s = seq;
    // Trim bytes we already have (a retransmission that overlaps).
    if (seqLt(s, this.rcvNxt)) {
      const already = seqDiff(this.rcvNxt, s);
      if (already >= data.length + (fin ? 1 : 0)) {
        sim.emit({ type: 'tcp:duplicate', deviceId: this.host.id, connId: this.id, packetId });
        this.sendAck('ACK');
        return;
      }
      data = data.subarray(Math.min(already, data.length));
      s = this.rcvNxt;
    }
    if (s !== this.rcvNxt) {
      // Out of order: keep it, and tell the sender what we are still missing. Sent twice, it is just a duplicate.
      if (this.ooo.has(s)) sim.emit({ type: 'tcp:duplicate', deviceId: this.host.id, connId: this.id, packetId });
      else {
        this.ooo.set(s, { data: data.slice(), fin, packetId });
        sim.emit({ type: 'tcp:ooo', deviceId: this.host.id, connId: this.id, packetId, seq: seqDiff(s, this.irs), len: data.length });
      }
      this.sendAck('dup ACK');
      return;
    }
    this.accept(data, fin, packetId);
    // Pull in anything that was waiting behind the gap.
    for (;;) {
      const next = this.ooo.get(this.rcvNxt);
      if (!next) break;
      this.ooo.delete(this.rcvNxt);
      this.accept(next.data, next.fin, next.packetId);
    }
    this.sendAck('ACK');
  }

  private accept(data: Uint8Array, fin: boolean, packetId: string): void {
    if (data.length) {
      this.rcvNxt = seqAdd(this.rcvNxt, data.length);
      this.delivered += data.length;
      // Now the bytes really reach the application: unwrap them for it.
      this.host.sim.emit({
        type: 'decapsulate',
        deviceId: this.host.id,
        packetId,
        layer: 4,
        protocol: 'tcp',
        pduId: this.host.sim.pdu(packetId, data, this.opts.app),
      });
      this.host.sim.emit({
        type: 'tcp:deliver',
        deviceId: this.host.id,
        connId: this.id,
        packetId,
        bytes: data.length,
        totalDelivered: this.delivered,
      });
      this.handlers.onData?.(this, data, packetId);
    }
    if (fin) {
      this.rcvNxt = seqAdd(this.rcvNxt, 1);
      if (this.state === 'ESTABLISHED') {
        this.setState('CLOSE_WAIT');
        // The application learns about end-of-stream on its next read, after the kernel has ACKed the FIN.
        this.host.sim.after(APP_WAKEUP, () => this.handlers.onPeerClose?.(this));
      } else if (this.state === 'FIN_WAIT_1') {
        this.setState('CLOSING');
      } else if (this.state === 'FIN_WAIT_2') {
        this.enterTimeWait();
      }
    }
  }

  private processAck(seg: ParsedTcp): void {
    const sim = this.host.sim;
    const ack = seg.ack;
    this.dupAcks = 0;
    let finAcked = false;
    let fresh: number | undefined;
    let resent = false;
    this.growCwnd(seqDiff(ack, this.sndUna));
    while (this.outstanding.length) {
      const s = this.outstanding[0]!;
      const end = seqAdd(s.seq, s.data.length + (s.syn ? 1 : 0) + (s.fin ? 1 : 0));
      if (!seqLe(end, ack)) break;
      this.outstanding.shift();
      if (s.retransmits === 0) fresh = sim.now - s.sentAt; // Karn's algorithm: only a segment sent once is measured
      else resent = true;
      if (s.fin) finAcked = true;
    }
    this.sndUna = ack;
    this.sacked = this.sacked.filter(([, end]) => seqLt(ack, end));
    // An ACK answering a resend also covers what waited behind the hole, so only the timestamp echo says how long the
    // resend took (RFC 7323); that is also how a backed-off timer recovers.
    const sample = resent ? this.echoedRtt(seg) : fresh ?? this.echoedRtt(seg);
    if (sample !== undefined) this.updateRtt(sample);
    // A partial ACK: the next hole is lost too, and no more duplicate ACKs will say so (RFC 6582).
    const next = this.recover !== undefined && seqLt(ack, this.recover) ? this.outstanding[0] : undefined;
    if (!next) this.recover = undefined;
    if (next) this.retransmit(next, 'recovery', false); // restarts the timer itself
    else this.restartRtoTimer();
    if (finAcked) {
      if (this.state === 'FIN_WAIT_1') this.setState('FIN_WAIT_2');
      else if (this.state === 'CLOSING') this.enterTimeWait();
      else if (this.state === 'LAST_ACK') {
        this.closeNow();
        this.handlers.onClosed?.(this);
      }
    }
  }

  private echoedRtt(seg: ParsedTcp): number | undefined {
    const ts = seg.options.find((o) => o.kind === 'ts');
    if (!this.tsOk || ts?.kind !== 'ts' || !ts.ecr) return undefined;
    return ((this.tsNow() - ts.ecr) >>> 0) / 1000;
  }

  /** Slow start doubles the window each round trip; past ssthresh it grows by about one segment per round trip. */
  private growCwnd(acked: number): void {
    if (this.cwnd === undefined) return;
    const mss = this.sendMss();
    this.cwnd += this.cwnd < this.ssthresh ? Math.min(acked, mss) : Math.max(1, Math.floor((mss * mss) / this.cwnd));
  }

  /** A lost segment means the network is full: halve, and after a timeout start again from one segment. */
  private shrinkCwnd(seg: OutSegment, cause: 'rto' | 'fast'): void {
    if (this.cwnd === undefined || seg.syn) return;
    const mss = this.sendMss();
    if (seg.retransmits === 0) this.ssthresh = Math.max(seqDiff(this.sndNxt, this.sndUna) / 2, 2 * mss);
    this.cwnd = cause === 'rto' ? mss : this.ssthresh;
  }

  private updateRtt(r: number): void {
    // RFC 6298 §2.2–2.3
    if (this.srtt === undefined) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
      this.srtt = 0.875 * this.srtt + 0.125 * r;
    }
    this.rto = Math.min(MAX_RTO, Math.max(MIN_RTO, this.srtt + Math.max(0.001, 4 * this.rttvar)));
    this.host.sim.emit({ type: 'tcp:rtt', deviceId: this.host.id, connId: this.id, sample: r, srtt: this.srtt, rto: this.rto });
  }

  /** Effective payload per segment: peer's MSS minus the timestamp option we put on every segment. */
  private sendMss(): number {
    return Math.min(this.peerMss, this.opts.mss) - (this.tsOk ? 12 : 0);
  }

  /** What is really on its way: everything outstanding but what a timeout wrote off and what the peer says it has (RFC 6675). */
  private pipe(): number {
    return this.outstanding.reduce((n, s) => n + (s.lost || this.isSacked(s) ? 0 : s.data.length + (s.syn ? 1 : 0) + (s.fin ? 1 : 0)), 0);
  }

  /** Did the peer's SACK blocks say it has this whole segment? (They describe data only, so never a FIN.) */
  private isSacked(s: OutSegment): boolean {
    const end = seqAdd(s.seq, s.data.length);
    return s.data.length > 0 && !s.fin && this.sacked.some(([b, e]) => seqLe(b, s.seq) && seqLe(end, e));
  }

  /** After a timeout everything still out is sent again from the first lost byte, in slow start (RFC 5681 §3.1). */
  private resendLost(): void {
    const window = Math.min(this.sndWnd, this.cwnd ?? Infinity);
    for (const s of this.outstanding) {
      if (!s.lost) continue;
      if (this.pipe() + s.data.length > window) break;
      s.lost = false;
      this.retransmit(s, 'recovery', false);
    }
  }

  private output(): void {
    this.resendLost();
    if (this.outstanding.some((s) => s.lost)) return;
    if (this.state !== 'ESTABLISHED' && this.state !== 'CLOSE_WAIT') return;
    const mss = this.sendMss();
    if (this.pending.length > 0) this.cwnd ??= INITIAL_CWND_SEGMENTS * mss;
    while (this.pending.length > 0) {
      const room = Math.min(this.sndWnd, this.cwnd!) - this.pipe();
      const len = Math.min(mss, this.pending.length);
      // Whole segments only, so a window that opens by a few bytes doesn't send a few bytes.
      if (room < len) break;
      const data = this.pending.slice(0, len);
      const streamStart = this.pendingStreamOffset;
      this.pending = this.pending.slice(len);
      this.pendingStreamOffset += len;
      const w = this.writes.find((x) => streamStart >= x.start && streamStart < x.end);
      const endsWrite = !!w && streamStart + len >= w.end;
      let label = w?.label ?? 'data';
      if (w && w.parts > 1) label += ` (part ${Math.floor((streamStart - w.start) / mss) + 1}/${w.parts})`;
      this.sendNew({ syn: false, fin: false, data, label, psh: endsWrite });
    }
    if (this.finQueued && !this.finSent && this.pending.length === 0) {
      this.finSent = true;
      this.sendNew({ syn: false, fin: true, data: new Uint8Array(0), label: 'FIN' });
      this.setState(this.state === 'CLOSE_WAIT' ? 'LAST_ACK' : 'FIN_WAIT_1');
    }
  }

  private sendNew(p: { syn: boolean; fin: boolean; data: Uint8Array; label: string; psh?: boolean }): void {
    const seg: OutSegment = {
      seq: this.sndNxt,
      data: p.data,
      syn: p.syn,
      fin: p.fin,
      psh: !!p.psh,
      sentAt: this.host.sim.now,
      retransmits: 0,
      lost: false,
      packetId: '',
      label: p.label,
    };
    this.sndNxt = seqAdd(this.sndNxt, p.data.length + (p.syn ? 1 : 0) + (p.fin ? 1 : 0));
    this.outstanding.push(seg);
    seg.packetId = this.transmit(seg, p.label);
    if (this.rtoTimer === undefined) this.restartRtoTimer();
  }

  private retransmit(seg: OutSegment, cause: 'rto' | 'fast' | 'recovery' | 'dup-syn', backoff: boolean): void {
    const original = seg.packetId;
    if (cause === 'rto' || cause === 'fast') this.shrinkCwnd(seg, cause);
    seg.retransmits++;
    seg.sentAt = this.host.sim.now;
    seg.packetId = this.transmit(seg, `${seg.label} (retransmission)`, original);
    this.host.sim.emit({
      type: 'tcp:retransmit',
      deviceId: this.host.id,
      connId: this.id,
      packetId: seg.packetId,
      originalPacketId: original,
      cause,
      rto: this.rto,
    });
    if (backoff) this.rto = Math.min(MAX_RTO, this.rto * 2); // RFC 6298 §5.5
    this.restartRtoTimer();
  }

  private transmit(seg: OutSegment, label: string, retransmitOf?: string): string {
    // Only the very first SYN of an active open lacks ACK; everything else (incl. SYN-ACK) carries it.
    const activeSyn = seg.syn && this.state === 'SYN_SENT';
    let flags = activeSyn ? TCP_SYN : TCP_ACK;
    if (seg.syn) flags |= TCP_SYN;
    if (seg.fin) flags |= TCP_FIN;
    if (seg.psh) flags |= TCP_PSH;
    return this.sendSegment(flags, seg.seq, seg.data, label, retransmitOf);
  }

  private tsNow(): number {
    return (this.tsOffset + Math.floor(this.host.sim.now * 1000)) >>> 0;
  }

  private sendAck(label: string): void {
    this.sendSegment(TCP_ACK, this.sndNxt, new Uint8Array(0), label);
  }

  private sendSegment(flags: number, seq: number, data: Uint8Array, label: string, retransmitOf?: string): string {
    const isSyn = (flags & TCP_SYN) !== 0;
    const ackOn = (flags & TCP_ACK) !== 0;
    const tsVal = this.tsNow();
    let options: TcpOption[];
    if (isSyn) {
      // Linux SYN / SYN-ACK option layout: MSS, SACK-permitted, timestamps, NOP, window scale (20 bytes).
      options = [
        { kind: 'mss', mss: this.opts.mss },
        { kind: 'sackPerm' },
        { kind: 'ts', val: tsVal, ecr: ackOn ? this.tsRecent : 0 },
        { kind: 'nop' },
        { kind: 'ws', shift: this.opts.wscale },
      ];
    } else {
      options = [];
      if (this.tsOk) options.push({ kind: 'nop' }, { kind: 'nop' }, { kind: 'ts', val: tsVal, ecr: this.tsRecent });
      if (this.sackOk && this.ooo.size && data.length === 0) {
        options.push({ kind: 'nop' }, { kind: 'nop' }, { kind: 'sack', blocks: this.sackBlocks() });
      }
    }
    const window = isSyn
      ? Math.min(RECV_BUFFER, 0xffff)
      : Math.min(0xffff, this.wsOk ? RECV_BUFFER >> this.opts.wscale : RECV_BUFFER);
    const ack = ackOn ? this.rcvNxt : 0;
    const tcpBytes = buildTcp(
      { srcPort: this.localPort, dstPort: this.remotePort, seq, ack, flags, window, options },
      data,
      this.localIp,
      this.remoteIp,
    );
    const pk = this.host.sim.newPacket(this.host.id, 'tcp', label, {
      retransmitOf,
      tcp: {
        connId: this.id,
        relSeq: seqDiff(seq, this.iss),
        relAck: ackOn ? seqDiff(this.rcvNxt, this.irs) : 0,
        len: data.length,
        flags,
      },
    });
    this.host.ipOutput(6, this.remoteIp, tcpBytes, pk.id, true, this.opts.app, this.localIp);
    return pk.id;
  }

  private sackBlocks(): [number, number][] {
    // SACK blocks describe data bytes only; a FIN waiting behind the gap is not reported.
    const starts = [...this.ooo.keys()].filter((s) => this.ooo.get(s)!.data.length > 0).sort((a, b) => seqDiff(a, b));
    const blocks: [number, number][] = [];
    for (const s of starts) {
      const e = seqAdd(s, this.ooo.get(s)!.data.length);
      const last = blocks[blocks.length - 1];
      if (last && last[1] === s) last[1] = e;
      else blocks.push([s, e]);
    }
    return blocks.slice(0, 3);
  }

  private readSynOptions(seg: ParsedTcp): void {
    let ws: number | undefined;
    for (const o of seg.options) {
      if (o.kind === 'mss') this.peerMss = o.mss;
      else if (o.kind === 'ws') ws = o.shift;
      else if (o.kind === 'sackPerm') this.peerSackPerm = true;
      else if (o.kind === 'ts') this.tsOk = true;
    }
    // Window scaling and SACK only apply if both sides offered them; we always offer them.
    this.wsOk = ws !== undefined;
    this.peerWscale = ws ?? 0;
    this.sackOk = this.peerSackPerm;
  }

  /** Remember the peer's clock to echo it; it only moves forward (RFC 7323 §4.3), except when the SYN sets it. */
  private updateTs(seg: ParsedTcp, first = false): void {
    const ts = seg.options.find((o) => o.kind === 'ts');
    if (ts && ts.kind === 'ts' && (first || seqLe(this.tsRecent, ts.val))) this.tsRecent = ts.val;
  }

  private restartRtoTimer(): void {
    const sim = this.host.sim;
    if (this.rtoTimer !== undefined) {
      sim.cancel(this.rtoTimer);
      sim.emit({ type: 'timer:cancel', deviceId: this.host.id, timerId: this.rtoTimerId!, kind: 'tcp-rto' });
      this.rtoTimer = undefined;
    }
    if (this.outstanding.length === 0) return;
    const timerId = this.host.newTimerId('rto');
    this.rtoTimerId = timerId;
    sim.emit({ type: 'timer:set', deviceId: this.host.id, timerId, kind: 'tcp-rto', fireAt: sim.now + this.rto, connId: this.id });
    this.rtoTimer = sim.after(this.rto, () => {
      this.rtoTimer = undefined;
      sim.emit({ type: 'timer:fire', deviceId: this.host.id, timerId, kind: 'tcp-rto' });
      const first = this.outstanding[0];
      if (!first) return;
      const limit = first.syn ? SYN_RETRIES : DATA_RETRIES;
      if (first.retransmits >= limit) {
        this.closeNow();
        this.handlers.onError?.(this, 'connection timed out');
        return;
      }
      this.recover = undefined;
      // Everything still out is written off, except what the peer's SACK blocks say has arrived.
      for (const s of this.outstanding) s.lost = s !== first && !this.isSacked(s);
      this.retransmit(first, 'rto', true);
    });
  }

  /** Gives up on the connection without a word: when the far end has gone silent, there is nobody to say it to. */
  abort(): void {
    this.closeNow();
  }

  /** The end of the connection, however it came: nothing left to send, no timer left running. */
  private closeNow(): void {
    this.outstanding = [];
    this.restartRtoTimer();
    this.setState('CLOSED');
    this.host.tcpRemove(this);
  }

  private enterTimeWait(): void {
    this.setState('TIME_WAIT');
    const sim = this.host.sim;
    const timerId = this.host.newTimerId('timewait');
    sim.emit({ type: 'timer:set', deviceId: this.host.id, timerId, kind: 'tcp-timewait', fireAt: sim.now + TIME_WAIT, connId: this.id });
    this.twTimer = sim.after(TIME_WAIT, () => {
      sim.emit({ type: 'timer:fire', deviceId: this.host.id, timerId, kind: 'tcp-timewait' });
      this.closeNow();
      this.handlers.onClosed?.(this);
    });
  }

  /**
   * The other end wants nothing more to do with this connection. Only a reset that fits counts (RFC 9293, RFC 5961): while
   * calling, one that acknowledges our SYN; after that, one at exactly the sequence number we expect next. Anything else
   * is an old straggler, or a forgery.
   */
  private reset(seg: ParsedTcp): void {
    const calling = this.state === 'SYN_SENT';
    if (calling ? !(seg.flags & TCP_ACK) || seg.ack !== seqAdd(this.iss, 1) : seg.seq !== this.rcvNxt) return;
    const inUse = calling || this.state === 'SYN_RCVD' || this.state === 'ESTABLISHED' || this.state === 'CLOSE_WAIT';
    this.closeNow();
    if (inUse) this.handlers.onError?.(this, calling ? 'connection refused' : 'connection reset');
    this.handlers.onClosed?.(this);
  }

  private setState(to: TcpState): void {
    if (to === this.state) return;
    this.host.sim.emit({ type: 'tcp:state', deviceId: this.host.id, connId: this.id, from: this.state, to });
    this.state = to;
    if (to === 'CLOSED' && this.twTimer !== undefined) this.host.sim.cancel(this.twTimer);
  }
}
