import { BROADCAST_IP, BROADCAST_MAC, inSubnet, ZERO_MAC, type Ip4, type Mac } from '../bytes/addr';
import { hash32, type Rng } from '../core/Rng';
import type { Simulator } from '../core/Simulator';
import type { TimerKind } from '../events/SimEvent';
import type { DeviceSpec, IfaceSpec, RouteSpec } from '../model';
import { ARP_LEN, ARP_REPLY, ARP_REQUEST, buildArp, parseArp } from '../proto/arp';
import { buildEthernet, ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEthernet } from '../proto/ethernet';
import { buildIcmp, ICMP_ECHO_REPLY, icmpTypeName, isIcmpError, parseIcmp, type ICMP_DEST_UNREACHABLE, type ICMP_TIME_EXCEEDED, type ParsedIcmp } from '../proto/icmp';
import { buildIpv4, IPPROTO_ICMP, parseIpv4, type ParsedIpv4 } from '../proto/ipv4';
import {
  buildWifi,
  buildWifiAck,
  parseWifi,
  parseWifiAck,
  WIFI_ACK_TIMEOUT,
  WIFI_CW_MAX,
  WIFI_CW_MIN,
  WIFI_RETRY_LIMIT,
  WIFI_SIFS,
  WIFI_SLOT,
  wifiFrameKind,
  type WifiHeader,
} from '../proto/wifi';
import { backoffSlots } from '../faults';
import type { Link, World } from './World';

const ARP_TIMEOUT = 1; // seconds between ARP retries
const ARP_ATTEMPTS = 3;

interface PendingArp {
  iface: IfaceSpec;
  queue: { payload: Uint8Array; packetId: string }[];
  attempts: number;
  timer?: number;
  timerId?: string;
}

/** A frame waiting to go out of a Wi-Fi radio on a noisy link, or on the air waiting for its Ack. */
interface WifiTx {
  packetId: string;
  header: WifiHeader;
  payload: Uint8Array;
  /** The copy on the air now: its snapshot. */
  frameId: string;
  /** Retries so far: 0 for the first copy. */
  attempt: number;
  /** The contention window the next backoff is drawn from. */
  cw: number;
  backoff: number;
  timer?: number;
}

/** Common IPv4 + ARP + Ethernet behaviour shared by hosts and routers. */
export abstract class Device {
  readonly id: string;
  readonly sim: Simulator;
  readonly arp = new Map<Ip4, Mac>();
  /** The device's own view of its interfaces and routes: what the scenario gave it, plus what DHCP sets later. */
  readonly ifaces: IfaceSpec[];
  readonly routes: RouteSpec[];
  protected readonly rng: Rng;
  private pendingArp = new Map<Ip4, PendingArp>();
  private timerCounter = 0;
  /** 802.11 sequence numbers, one counter per Wi-Fi interface. */
  private wifiSeq = new Map<string, number>();
  /** IPv4 identification for the packets the device makes itself (its ICMP messages). A host counts its own. */
  private ownIpId: number;
  /**
   * Per Wi-Fi radio on a noisy link: the frames waiting to go, the head on the air until its Ack comes or it is given up
   * (stop-and-wait, as 802.11 does with one frame at a time).
   */
  private wifiOut = new Map<string, WifiTx[]>();
  /** The newest sequence number heard from each transmitter over Wi-Fi, to spot a frame sent again after its Ack was lost. */
  private wifiHeard = new Map<Mac, number>();

  constructor(
    readonly world: World,
    readonly spec: DeviceSpec,
  ) {
    this.id = spec.id;
    this.sim = world.sim;
    this.rng = world.rng(`device:${spec.id}`);
    this.ownIpId = hash32(`${spec.id}:ip-id`, world.seed) & 0xffff;
    this.ifaces = spec.ifaces.map((i) => ({ ...i }));
    this.routes = [...spec.routes];
    for (const [ip, mac] of Object.entries(spec.arp ?? {})) this.arp.set(ip, mac);
  }

  nextIpId(): number {
    this.ownIpId = (this.ownIpId + 1) & 0xffff;
    return this.ownIpId;
  }

  /** Sends an IP packet the device made itself. A host with a tunnel sends it through there. */
  protected transmitIp(ipBytes: Uint8Array, packetId: string): void {
    this.sendIp(ipBytes, packetId);
  }

  /** An ICMP message of the device's own, in an IP packet from `src`: an echo reply, or an error about someone's packet. */
  protected sendIcmp(src: Ip4, dst: Ip4, msg: Uint8Array, label: string): void {
    const sim = this.sim;
    const pk = sim.newPacket(this.id, 'icmp', label);
    sim.emit({ type: 'encapsulate', deviceId: this.id, packetId: pk.id, layer: 3, protocol: 'icmp', pduId: sim.pdu(pk.id, msg, 'icmp') });
    // Linux sends its ICMP replies and errors without Don't Fragment, with the default TTL.
    const ip = buildIpv4({ id: this.nextIpId(), df: false, ttl: 64, protocol: IPPROTO_ICMP, src, dst }, msg);
    sim.emit({ type: 'encapsulate', deviceId: this.id, packetId: pk.id, layer: 3, protocol: 'ipv4', pduId: sim.pdu(pk.id, ip, 'ipv4') });
    this.transmitIp(ip, pk.id);
  }

  /** Answers an echo request: the same identifier, sequence number and data back, from the address it was sent to. */
  protected echoReply(ip: ParsedIpv4, icmp: Uint8Array, m: ParsedIcmp): void {
    const reply = buildIcmp({ type: ICMP_ECHO_REPLY, id: m.id ?? 0, seq: m.seq ?? 0, data: icmp.slice(m.dataStart, m.end) });
    this.sendIcmp(ip.dst, ip.src, reply, `ICMP echo reply · seq ${m.seq}`);
  }

  /**
   * Tells the sender of `offending` that its packet could not go on: Time Exceeded from a router whose TTL count hit
   * zero, Port Unreachable from a host with nobody on that port. Never about an ICMP error, never about a broadcast
   * (RFC 1122 §3.2.2): errors about errors would never end.
   */
  protected icmpError(type: typeof ICMP_DEST_UNREACHABLE | typeof ICMP_TIME_EXCEEDED, code: number, src: Ip4, offending: Uint8Array): void {
    const ip = parseIpv4(offending, 0);
    if (ip.dst === BROADCAST_IP) return;
    if (ip.protocol === IPPROTO_ICMP && isIcmpError(parseIcmp(offending, ip.headerLen, ip.totalLength).type)) return;
    this.sendIcmp(src, ip.src, buildIcmp({ type, code, original: offending }), `ICMP ${icmpTypeName(type, code)}`);
  }

  iface(id: string): IfaceSpec {
    const f = this.ifaces.find((i) => i.id === id);
    if (!f) throw new Error(`${this.id}: no iface ${id}`);
    return f;
  }

  ownsIp(ip: Ip4): boolean {
    return this.ifaces.some((i) => i.ip === ip || i.aliases?.includes(ip));
  }

  newTimerId(kind: string): string {
    return `${this.id}:${kind}:${this.timerCounter++}`;
  }

  /** A program's retry or wait timer, in the event log. `set` starts a new one; `cancel` calls off the latest and logs it, whether it still runs or not. */
  timer(name: string, kind: TimerKind): { set(delay: number, fired: () => void): void; cancel(): void } {
    const sim = this.sim;
    let handle: number | undefined;
    let timerId = '';
    return {
      set: (delay, fired) => {
        timerId = this.newTimerId(name);
        sim.emit({ type: 'timer:set', deviceId: this.id, timerId, kind, fireAt: sim.now + delay });
        handle = sim.after(delay, () => {
          sim.emit({ type: 'timer:fire', deviceId: this.id, timerId, kind });
          fired();
        });
      },
      cancel: () => {
        sim.cancel(handle);
        sim.emit({ type: 'timer:cancel', deviceId: this.id, timerId, kind });
      },
    };
  }

  /** Longest-prefix match over the routing table. */
  lookupRoute(dst: Ip4): RouteSpec | undefined {
    let best: RouteSpec | undefined;
    for (const r of this.routes) {
      if (inSubnet(dst, r.network, r.prefixLen) && (!best || r.prefixLen > best.prefixLen)) best = r;
    }
    return best;
  }

  /** Entry point from a link: the last bit of a frame has arrived on `ifaceId`. */
  receiveFrame(ifaceId: string, frame: Uint8Array, packetId: string, frameId: string): void {
    const sim = this.sim;
    const link = this.world.ifaceLink.get(ifaceId);
    sim.emit({ type: 'rx', deviceId: this.id, iface: ifaceId, linkId: link?.spec.id ?? '', packetId, frameId });
    const iface = this.iface(ifaceId);
    const l2 = iface.wifi ? 'wifi' : 'ethernet';
    if (iface.wifi && link?.arq && wifiFrameKind(frame) === 'ack') {
      this.onWifiAck(iface, link, frame, packetId, frameId);
      return;
    }
    const wifi = iface.wifi ? parseWifi(frame) : undefined;
    const eth = wifi ?? parseEthernet(frame);
    if (!eth.fcsValid) {
      sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id, frameId });
      return;
    }
    // Over Wi-Fi the radio receiver (address 1) must be us too.
    const heard = !wifi || wifi.addr1 === iface.mac || wifi.addr1 === BROADCAST_MAC;
    const port = this.spec.bridge?.[eth.dst];
    if (!heard || (eth.dst !== iface.mac && eth.dst !== BROADCAST_MAC && !port)) {
      sim.emit({ type: 'drop', packetId, reason: 'not-for-me', deviceId: this.id, frameId });
      return;
    }
    if (wifi && link?.arq && wifi.addr1 === iface.mac) {
      // 802.11: every unicast frame heard gets an Ack after SIFS, a copy sent again (Retry bit) included, or the sender would
      // keep trying; the copy itself is dropped by its sequence number. Group-addressed frames are never acknowledged.
      const duplicate = wifi.retry && this.wifiHeard.get(wifi.addr2) === wifi.seq;
      this.wifiHeard.set(wifi.addr2, wifi.seq);
      this.sendWifiAck(iface, link, wifi.addr2);
      if (duplicate) {
        sim.emit({ type: 'drop', packetId, reason: 'duplicate-frame', deviceId: this.id, linkId: link.spec.id, frameId });
        return;
      }
    }
    if (eth.type === ETHERTYPE_ARP) {
      const arpBytes = frame.slice(eth.payloadStart, eth.payloadStart + ARP_LEN);
      const pduId = sim.pdu(packetId, arpBytes, 'arp');
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 2, protocol: l2, pduId });
      if (port) {
        this.sendFrame(this.iface(port), eth.dst, eth.type, arpBytes, packetId, eth.src);
        return;
      }
      this.floodArp(iface, arpBytes, eth.src, packetId);
      this.onArp(iface, arpBytes, packetId);
    } else if (eth.type === ETHERTYPE_IPV4) {
      const ip = parseIpv4(frame, eth.payloadStart);
      const ipBytes = frame.slice(eth.payloadStart, eth.payloadStart + ip.totalLength);
      const pduId = sim.pdu(packetId, ipBytes, 'ipv4');
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 2, protocol: l2, pduId });
      // A switch reads the frame and no further: same addresses, same TTL, nothing to translate.
      if (port) {
        this.sendFrame(this.iface(port), eth.dst, eth.type, ipBytes, packetId, eth.src);
        return;
      }
      if (!ip.checksumValid) {
        sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id });
        return;
      }
      this.onIpv4(iface, ipBytes, packetId);
    }
  }

  protected abstract onIpv4(iface: IfaceSpec, ipBytes: Uint8Array, packetId: string): void;

  /** A switch passes a broadcast on to its other ports. Who has the router's own address, only the router need answer. */
  private floodArp(from: IfaceSpec, arpBytes: Uint8Array, src: Mac, packetId: string): void {
    if (!this.spec.bridge || this.ownsIp(parseArp(arpBytes, 0).tpa)) return;
    for (const port of new Set(Object.values(this.spec.bridge))) if (port !== from.id) this.sendFrame(this.iface(port), BROADCAST_MAC, ETHERTYPE_ARP, arpBytes, packetId, src);
  }

  /** A frame picked out of the air by a radio it was not sent to. It changes nothing: nobody knows it was heard. */
  overhear(frame: Uint8Array, frameId: string): void {
    if (wifiFrameKind(frame) === 'ack' || !parseWifi(frame).fcsValid) return;
    this.sim.emit({ type: 'app', deviceId: this.id, app: 'wifi-listener', action: 'overheard', pduId: frameId });
  }

  private onArp(iface: IfaceSpec, bytes: Uint8Array, packetId: string): void {
    const a = parseArp(bytes, 0);
    const forMe = a.tpa === iface.ip;
    // RFC 826: update an existing entry from any ARP packet; add a new one only if we are the target.
    if ((forMe || this.arp.has(a.spa)) && this.arp.get(a.spa) !== a.sha) {
      this.arp.set(a.spa, a.sha);
      this.sim.emit({ type: 'arp:learn', deviceId: this.id, ip: a.spa, mac: a.sha });
    }
    if (a.oper === ARP_REQUEST && forMe) {
      const reply = this.sim.newPacket(this.id, 'arp', `ARP reply: ${iface.ip} is at ${iface.mac}`);
      const arpBytes = buildArp({ oper: ARP_REPLY, sha: iface.mac, spa: iface.ip, tha: a.sha, tpa: a.spa });
      const pduId = this.sim.pdu(reply.id, arpBytes, 'arp');
      this.sim.emit({ type: 'encapsulate', deviceId: this.id, packetId: reply.id, layer: 2, protocol: 'arp', pduId });
      this.sendFrame(iface, a.sha, ETHERTYPE_ARP, arpBytes, reply.id);
    } else if (!forMe && a.oper === ARP_REQUEST) {
      this.sim.emit({ type: 'drop', packetId, reason: 'not-for-me', deviceId: this.id });
    }
    const pending = this.pendingArp.get(a.spa);
    if (pending && this.arp.has(a.spa)) this.flushArp(a.spa, pending);
  }

  /** Routes an IPv4 packet and hands it to the link layer (resolving the next hop's MAC first if needed). */
  protected sendIp(ipBytes: Uint8Array, packetId: string, emitRoute = true): void {
    const ip = parseIpv4(ipBytes, 0);
    const route = this.lookupRoute(ip.dst);
    if (!route) {
      this.sim.emit({ type: 'drop', packetId, reason: 'no-route', deviceId: this.id });
      return;
    }
    if (emitRoute) this.emitRoute(ip.dst, route, packetId);
    this.resolveAndSend(this.iface(route.iface), route.via ?? ip.dst, ipBytes, packetId);
  }

  /**
   * Sends an IP packet straight out of one interface to a MAC it already knows: no route lookup and no ARP. This is how
   * DHCP travels, before the client has an address to route from or the server's offer has an owner to ask for.
   */
  sendOnIface(iface: IfaceSpec, dstMac: Mac, ipBytes: Uint8Array, packetId: string): void {
    this.sendFrame(iface, dstMac, ETHERTYPE_IPV4, ipBytes, packetId);
  }

  protected emitRoute(dst: Ip4, route: RouteSpec, packetId: string): void {
    this.sim.emit({
      type: 'route',
      deviceId: this.id,
      packetId,
      dst,
      route: route.prefixLen === 0 ? 'default' : `${route.network}/${route.prefixLen}`,
      nextHop: route.via ?? dst,
      outIface: route.iface,
    });
  }

  private resolveAndSend(iface: IfaceSpec, nextHop: Ip4, payload: Uint8Array, packetId: string): void {
    const mac = this.arp.get(nextHop);
    if (mac) {
      this.sim.emit({ type: 'arp:hit', deviceId: this.id, ip: nextHop, mac, packetId });
      this.sendFrame(iface, mac, ETHERTYPE_IPV4, payload, packetId);
      return;
    }
    let pending = this.pendingArp.get(nextHop);
    this.sim.emit({ type: 'arp:miss', deviceId: this.id, ip: nextHop, packetId });
    if (pending) {
      pending.queue.push({ payload, packetId });
      return;
    }
    pending = { iface, queue: [{ payload, packetId }], attempts: 0 };
    this.pendingArp.set(nextHop, pending);
    this.sendArpRequest(nextHop, pending);
  }

  private sendArpRequest(target: Ip4, pending: PendingArp): void {
    const iface = pending.iface;
    pending.attempts++;
    const pk = this.sim.newPacket(
      this.id,
      'arp',
      `ARP request: who has ${target}?${pending.attempts > 1 ? ` (attempt ${pending.attempts})` : ''}`,
    );
    const arpBytes = buildArp({ oper: ARP_REQUEST, sha: iface.mac, spa: iface.ip, tha: ZERO_MAC, tpa: target });
    const pduId = this.sim.pdu(pk.id, arpBytes, 'arp');
    this.sim.emit({ type: 'encapsulate', deviceId: this.id, packetId: pk.id, layer: 2, protocol: 'arp', pduId });
    this.sendFrame(iface, BROADCAST_MAC, ETHERTYPE_ARP, arpBytes, pk.id);
    const timerId = this.newTimerId('arp');
    pending.timerId = timerId;
    this.sim.emit({ type: 'timer:set', deviceId: this.id, timerId, kind: 'arp-retry', fireAt: this.sim.now + ARP_TIMEOUT });
    pending.timer = this.sim.after(ARP_TIMEOUT, () => {
      this.sim.emit({ type: 'timer:fire', deviceId: this.id, timerId, kind: 'arp-retry' });
      if (pending.attempts < ARP_ATTEMPTS) this.sendArpRequest(target, pending);
      else {
        this.pendingArp.delete(target);
        for (const q of pending.queue) {
          this.sim.emit({ type: 'drop', packetId: q.packetId, reason: 'arp-failed', deviceId: this.id });
        }
      }
    });
  }

  private flushArp(ip: Ip4, pending: PendingArp): void {
    this.sim.cancel(pending.timer);
    if (pending.timerId) {
      this.sim.emit({ type: 'timer:cancel', deviceId: this.id, timerId: pending.timerId, kind: 'arp-retry' });
    }
    this.pendingArp.delete(ip);
    const mac = this.arp.get(ip)!;
    for (const q of pending.queue) {
      this.sim.emit({ type: 'arp:hit', deviceId: this.id, ip, mac, packetId: q.packetId });
      this.sendFrame(pending.iface, mac, ETHERTYPE_IPV4, q.payload, q.packetId);
    }
  }

  /** The access point a station's Wi-Fi interface is connected to: the interface at the other end of its link. */
  private bssid(iface: IfaceSpec): Mac {
    const link = this.world.ifaceLink.get(iface.id);
    const other = link?.peerOf(iface.id);
    const owner = other ? this.world.ifaceOwner.get(other) : undefined;
    return owner && other ? owner.iface(other).mac : BROADCAST_MAC;
  }

  /** `from` is whose frame it is, when a switch passes on someone else's. */
  protected sendFrame(iface: IfaceSpec, dstMac: Mac, type: number, payload: Uint8Array, packetId: string, from: Mac = iface.mac): void {
    const link = this.world.ifaceLink.get(iface.id);
    if (!link) throw new Error(`${iface.id} has no link`);
    let frame: Uint8Array;
    let header: WifiHeader | undefined;
    if (iface.wifi) {
      const seq = this.wifiSeq.get(iface.id) ?? 0;
      this.wifiSeq.set(iface.id, (seq + 1) & 0xfff);
      // Going up, address 1 is the access point and 3 the real destination; coming down, 1 is the phone and 3 the sender.
      // Here the access point is built into the router, so the access point's MAC is the router's own (its BSSID).
      const up = iface.wifi === 'station';
      header = { toAp: up, addr1: up ? this.bssid(iface) : dstMac, addr2: iface.mac, addr3: up ? dstMac : from, seq, type };
      frame = buildWifi(header, payload);
    } else {
      frame = buildEthernet({ dst: dstMac, src: from, type }, payload);
    }
    const protocol = iface.wifi ? 'wifi' : 'ethernet';
    const frameId = this.sim.pdu(packetId, frame, protocol);
    this.sim.emit({ type: 'encapsulate', deviceId: this.id, packetId, layer: 2, protocol, pduId: frameId });
    if (header && link.arq) {
      // A noisy radio: the frame queues behind whatever is still waiting for its Ack.
      const out = this.wifiOut.get(iface.id) ?? [];
      this.wifiOut.set(iface.id, out);
      out.push({ packetId, header, payload, frameId, attempt: 0, cw: WIFI_CW_MIN, backoff: 0 });
      if (out.length === 1) this.wifiStart(iface, link);
      return;
    }
    link.transmit(iface.id, frame, packetId, frameId);
  }

  /** Puts the head of the radio's queue on the air (its first copy, or one more with the Retry bit) and waits for the Ack. */
  private wifiStart(iface: IfaceSpec, link: Link): void {
    const tx = this.wifiOut.get(iface.id)?.[0];
    if (!tx) return;
    let frame: Uint8Array;
    if (tx.attempt === 0) {
      frame = buildWifi(tx.header, tx.payload);
    } else {
      frame = buildWifi({ ...tx.header, retry: true }, tx.payload);
      tx.frameId = this.sim.pdu(tx.packetId, frame, 'wifi');
      this.sim.emit({ type: 'wifi:retry', deviceId: this.id, linkId: link.spec.id, packetId: tx.packetId, frameId: tx.frameId, attempt: tx.attempt, backoff: tx.backoff });
    }
    const txEnd = link.transmit(iface.id, frame, tx.packetId, tx.frameId, { attempt: tx.attempt }) ?? this.sim.now;
    // Nobody acknowledges a frame to everyone: it is sent once and the next one follows.
    if (tx.header.addr1 === BROADCAST_MAC) {
      this.sim.at(txEnd, () => this.wifiNext(iface, link));
      return;
    }
    tx.timer = this.sim.at(txEnd + WIFI_ACK_TIMEOUT, () => this.wifiTimeout(iface, link, tx));
  }

  /** No Ack came: try again after a backoff with a doubled contention window, or give up after dot11ShortRetryLimit tries. */
  private wifiTimeout(iface: IfaceSpec, link: Link, tx: WifiTx): void {
    if (tx.attempt >= WIFI_RETRY_LIMIT) {
      this.sim.emit({ type: 'drop', packetId: tx.packetId, reason: 'retry-limit', deviceId: this.id, linkId: link.spec.id, frameId: tx.frameId });
      this.wifiNext(iface, link);
      return;
    }
    tx.attempt++;
    tx.backoff = backoffSlots(this.world.seed, link.spec.id, tx.packetId, tx.attempt, tx.cw) * WIFI_SLOT;
    tx.cw = Math.min(2 * tx.cw + 1, WIFI_CW_MAX);
    this.sim.after(tx.backoff, () => this.wifiStart(iface, link));
  }

  private wifiNext(iface: IfaceSpec, link: Link): void {
    this.wifiOut.get(iface.id)?.shift();
    this.wifiStart(iface, link);
  }

  /** An Ack for the frame on the air: done with it, the next one may go. */
  private onWifiAck(iface: IfaceSpec, link: Link, frame: Uint8Array, packetId: string, frameId: string): void {
    const ack = parseWifiAck(frame);
    if (!ack.fcsValid) {
      this.sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id, frameId });
      return;
    }
    const tx = this.wifiOut.get(iface.id)?.[0];
    if (ack.ra !== iface.mac || !tx || tx.timer === undefined) {
      this.sim.emit({ type: 'drop', packetId, reason: 'not-for-me', deviceId: this.id, frameId });
      return;
    }
    this.sim.cancel(tx.timer);
    tx.timer = undefined;
    this.sim.emit({ type: 'wifi:ack', deviceId: this.id, linkId: link.spec.id, packetId: tx.packetId, frameId: tx.frameId });
    this.wifiNext(iface, link);
  }

  /** Answers a unicast frame with the 14-byte Ack control frame, SIFS after its last bit. */
  private sendWifiAck(iface: IfaceSpec, link: Link, ra: Mac): void {
    this.sim.after(WIFI_SIFS, () => {
      const pk = this.sim.newPacket(this.id, 'wifi-ack', 'Wi-Fi ACK');
      const frame = buildWifiAck(ra);
      const frameId = this.sim.pdu(pk.id, frame, 'wifi');
      this.sim.emit({ type: 'encapsulate', deviceId: this.id, packetId: pk.id, layer: 2, protocol: 'wifi', pduId: frameId });
      link.transmit(iface.id, frame, pk.id, frameId, { ack: true });
    });
  }
}
