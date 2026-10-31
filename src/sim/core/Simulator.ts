import type { SimEvent, SimEventPayload } from '../events/SimEvent';
import { decodePdu, type DecodeContext } from '../proto/decode';
import type { LayerPdu, Protocol } from '../proto/types';

/** Exact bytes of a PDU at one moment (e.g. a frame on one link, or a segment inside a host). */
export interface PduSnapshot {
  id: string;
  packetId: string;
  bytes: Uint8Array;
  first: Protocol;
  layers: LayerPdu[];
}

/**
 * 'stream' = application bytes handed to TCP (or reassembled from it); not itself a packet on the wire.
 * 'icmp' = an echo request or reply, or an error a router or host sends back; 'probe' = traceroute's UDP probe.
 * 'wifi-ack' = the 14-byte 802.11 Ack a Wi-Fi receiver sends back for a data frame, on a noisy link only.
 */
export type PacketKind = 'arp' | 'dhcp' | 'dns' | 'tcp' | 'rtp' | 'icmp' | 'probe' | 'stream' | 'wifi-ack';

/** A logical packet. It keeps its id across hops even as MACs, TTL or NAT change its bytes. */
export interface PacketInfo {
  id: string;
  origin: string;
  kind: PacketKind;
  label: string;
  createdAt: number;
  retransmitOf?: string;
  /** For TCP: which connection and direction; relative seq/ack are handy for display. */
  tcp?: { connId: string; relSeq: number; relAck: number; len: number; flags: number };
  /** For RTP: the stream it belongs to and which packet of the clip this is (1-based) out of how many. */
  rtp?: { seq: number; ssrc: number; part: number; of: number };
}

interface QItem {
  at: number;
  order: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * Deterministic discrete-event simulator. Callbacks run in (time, insertion order); everything that happens is
 * appended to `events` with a monotonically increasing `seq`.
 */
export class Simulator {
  now = 0;
  readonly events: SimEvent[] = [];
  readonly pdus = new Map<string, PduSnapshot>();
  readonly packets = new Map<string, PacketInfo>();
  private heap: QItem[] = [];
  private order = 0;
  private pduCounter = 0;
  private packetCounter = 0;
  private handles = new Map<number, QItem>();

  at(time: number, fn: () => void): number {
    const item: QItem = { at: Math.max(time, this.now), order: this.order++, fn, cancelled: false };
    this.push(item);
    this.handles.set(item.order, item);
    return item.order;
  }

  after(delay: number, fn: () => void): number {
    return this.at(this.now + delay, fn);
  }

  cancel(handle: number | undefined): void {
    if (handle === undefined) return;
    const it = this.handles.get(handle);
    if (it) it.cancelled = true;
    this.handles.delete(handle);
  }

  emit(e: SimEventPayload): SimEvent {
    const ev = { ...e, t: this.now, seq: this.events.length } as SimEvent;
    this.events.push(ev);
    return ev;
  }

  /** Records an immutable snapshot of a PDU and returns its id. */
  pdu(packetId: string, bytes: Uint8Array, first: Protocol, ctx?: DecodeContext): string {
    const id = `pdu${this.pduCounter++}`;
    const copy = bytes.slice();
    this.pdus.set(id, { id, packetId, bytes: copy, first, layers: decodePdu(copy, first, ctx) });
    return id;
  }

  newPacket(origin: string, kind: PacketKind, label: string, extra: Partial<PacketInfo> = {}): PacketInfo {
    const info: PacketInfo = { id: `pk${this.packetCounter++}`, origin, kind, label, createdAt: this.now, ...extra };
    this.packets.set(info.id, info);
    return info;
  }

  run(maxTime: number): void {
    while (this.heap.length) {
      const it = this.pop();
      if (!it) break;
      if (it.cancelled) continue;
      if (it.at > maxTime) break;
      this.handles.delete(it.order);
      this.now = it.at;
      it.fn();
    }
  }

  private less(a: QItem, b: QItem): boolean {
    return a.at < b.at || (a.at === b.at && a.order < b.order);
  }

  private push(item: QItem): void {
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  private pop(): QItem | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
