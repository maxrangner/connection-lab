import { BROADCAST_MAC, inSubnet, ZERO_MAC, type Ip4, type Mac } from '../bytes/addr';
import type { Rng } from '../core/Rng';
import type { Simulator } from '../core/Simulator';
import type { DeviceSpec, IfaceSpec, RouteSpec } from '../model';
import { ARP_REPLY, ARP_REQUEST, buildArp, parseArp } from '../proto/arp';
import { buildEthernet, ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEthernet } from '../proto/ethernet';
import { parseIpv4 } from '../proto/ipv4';
import { buildWifi, parseWifi } from '../proto/wifi';
import type { World } from './World';

const ARP_TIMEOUT = 1; // seconds between ARP retries
const ARP_ATTEMPTS = 3;

interface PendingArp {
  iface: IfaceSpec;
  queue: { payload: Uint8Array; packetId: string }[];
  attempts: number;
  timer?: number;
  timerId?: string;
}

/** Common IPv4 + ARP + Ethernet behaviour shared by hosts and routers. */
export abstract class Device {
  readonly id: string;
  readonly sim: Simulator;
  readonly arp = new Map<Ip4, Mac>();
  protected readonly rng: Rng;
  private pendingArp = new Map<Ip4, PendingArp>();
  private timerCounter = 0;
  /** 802.11 sequence numbers, one counter per Wi-Fi interface. */
  private wifiSeq = new Map<string, number>();

  constructor(
    readonly world: World,
    readonly spec: DeviceSpec,
  ) {
    this.id = spec.id;
    this.sim = world.sim;
    this.rng = world.rng(`device:${spec.id}`);
    for (const [ip, mac] of Object.entries(spec.arp ?? {})) this.arp.set(ip, mac);
  }

  iface(id: string): IfaceSpec {
    const f = this.spec.ifaces.find((i) => i.id === id);
    if (!f) throw new Error(`${this.id}: no iface ${id}`);
    return f;
  }

  ownsIp(ip: Ip4): boolean {
    return this.spec.ifaces.some((i) => i.ip === ip);
  }

  newTimerId(kind: string): string {
    return `${this.id}:${kind}:${this.timerCounter++}`;
  }

  /** Longest-prefix match over the routing table. */
  lookupRoute(dst: Ip4): RouteSpec | undefined {
    let best: RouteSpec | undefined;
    for (const r of this.spec.routes) {
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
    const eth = iface.wifi ? parseWifi(frame) : parseEthernet(frame);
    if (!eth.fcsValid) {
      sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id, frameId });
      return;
    }
    // Over Wi-Fi the radio receiver (address 1) must be us too.
    const heard = !('addr1' in eth) || eth.addr1 === iface.mac || eth.addr1 === BROADCAST_MAC;
    if (!heard || (eth.dst !== iface.mac && eth.dst !== BROADCAST_MAC)) {
      sim.emit({ type: 'drop', packetId, reason: 'not-for-me', deviceId: this.id, frameId });
      return;
    }
    if (eth.type === ETHERTYPE_ARP) {
      const arpBytes = frame.slice(eth.payloadStart, eth.payloadStart + 28);
      const pduId = sim.pdu(packetId, arpBytes, 'arp');
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 2, protocol: l2, pduId });
      this.onArp(iface, arpBytes, packetId);
    } else if (eth.type === ETHERTYPE_IPV4) {
      const ip = parseIpv4(frame, eth.payloadStart);
      const ipBytes = frame.slice(eth.payloadStart, eth.payloadStart + ip.totalLength);
      const pduId = sim.pdu(packetId, ipBytes, 'ipv4');
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 2, protocol: l2, pduId });
      if (!ip.checksumValid) {
        sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id });
        return;
      }
      this.onIpv4(iface, ipBytes, packetId);
    }
  }

  protected abstract onIpv4(iface: IfaceSpec, ipBytes: Uint8Array, packetId: string): void;

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
  protected sendIp(ipBytes: Uint8Array, packetId: string, emitRoute = true): boolean {
    const ip = parseIpv4(ipBytes, 0);
    const route = this.lookupRoute(ip.dst);
    if (!route) {
      this.sim.emit({ type: 'drop', packetId, reason: 'no-route', deviceId: this.id });
      return false;
    }
    if (emitRoute) this.emitRoute(ip.dst, route, packetId);
    this.resolveAndSend(this.iface(route.iface), route.via ?? ip.dst, ipBytes, packetId);
    return true;
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
    const other = link && (link.spec.a === iface.id ? link.spec.b : link.spec.a);
    const owner = other ? this.world.ifaceOwner.get(other) : undefined;
    return owner && other ? owner.iface(other).mac : BROADCAST_MAC;
  }

  protected sendFrame(iface: IfaceSpec, dstMac: Mac, type: number, payload: Uint8Array, packetId: string): void {
    let frame: Uint8Array;
    if (iface.wifi) {
      const seq = this.wifiSeq.get(iface.id) ?? 0;
      this.wifiSeq.set(iface.id, (seq + 1) & 0xfff);
      // Going up, address 1 is the access point and 3 the real destination; coming down, 1 is the phone and 3 the sender.
      // Here the access point is built into the router, so the access point's MAC is the router's own (its BSSID).
      const up = iface.wifi === 'station';
      frame = buildWifi({ toAp: up, addr1: up ? this.bssid(iface) : dstMac, addr2: iface.mac, addr3: up ? dstMac : iface.mac, seq, type }, payload);
    } else {
      frame = buildEthernet({ dst: dstMac, src: iface.mac, type }, payload);
    }
    const protocol = iface.wifi ? 'wifi' : 'ethernet';
    const frameId = this.sim.pdu(packetId, frame, protocol);
    this.sim.emit({ type: 'encapsulate', deviceId: this.id, packetId, layer: 2, protocol, pduId: frameId });
    const link = this.world.ifaceLink.get(iface.id);
    if (!link) throw new Error(`${iface.id} has no link`);
    link.transmit(iface.id, frame, packetId, frameId);
  }
}
