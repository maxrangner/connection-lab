import { BROADCAST_IP, ipToBytes, type Ip4 } from '../bytes/addr';
import { setU16, u16 } from '../bytes/bytes';
import { internetChecksum, transportChecksum } from '../bytes/checksum';
import type { NatEntry } from '../events/SimEvent';
import type { DeviceSpec, IfaceSpec } from '../model';
import { DHCP_SERVER_PORT } from '../proto/dhcp';
import { IPPROTO_TCP, IPPROTO_UDP, parseIpv4, rewriteIpv4 } from '../proto/ipv4';
import { parseUdp } from '../proto/udp';
import { Device } from './Device';
import { DhcpServer } from './dhcp';
import type { World } from './World';

/**
 * Rewrites addresses/ports in an IPv4 packet carrying TCP or UDP and recomputes both checksums, exactly what a
 * NAT device must do (the transport checksum covers the IP addresses through the pseudo-header).
 */
export function natRewrite(
  ipBytes: Uint8Array,
  change: { src?: { ip: Ip4; port: number }; dst?: { ip: Ip4; port: number } },
): Uint8Array {
  const out = ipBytes.slice();
  const ip = parseIpv4(out, 0);
  const l4 = ip.headerLen;
  if (change.src) {
    out.set(ipToBytes(change.src.ip), 12);
    setU16(out, l4, change.src.port);
  }
  if (change.dst) {
    out.set(ipToBytes(change.dst.ip), 16);
    setU16(out, l4 + 2, change.dst.port);
  }
  const p = parseIpv4(out, 0);
  const csumOff = ip.protocol === IPPROTO_TCP ? l4 + 16 : l4 + 6;
  setU16(out, csumOff, 0);
  const seg = out.subarray(l4, ip.totalLength);
  let c = transportChecksum(p.src, p.dst, ip.protocol, seg);
  if (ip.protocol === IPPROTO_UDP && c === 0) c = 0xffff;
  setU16(out, csumOff, c);
  setU16(out, 10, 0);
  setU16(out, 10, internetChecksum(out, 0, ip.headerLen));
  return out;
}

/** An IPv4 router. With `spec.nat` set it is a home router doing source NAT (masquerading) on its WAN side. */
export class Router extends Device {
  private natTable: NatEntry[] = [];
  /** A home router hands out addresses too. */
  private readonly dhcp?: DhcpServer;

  constructor(world: World, spec: DeviceSpec) {
    super(world, spec);
    if (spec.dhcp) this.dhcp = new DhcpServer(this, spec.dhcp, this.rng);
  }

  /**
   * A packet for the router itself (or for everyone: a broadcast is never forwarded). Only the DHCP server listens,
   * on the home side; everything else is dropped.
   */
  private deliver(inIface: IfaceSpec, bytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(bytes, 0);
    const l4 = bytes.slice(ip.headerLen, ip.totalLength);
    const u = ip.protocol === IPPROTO_UDP ? parseUdp(l4, 0) : undefined;
    const served = this.dhcp && this.spec.dhcp!.ifaces.includes(inIface.id) && u?.dstPort === DHCP_SERVER_PORT;
    if (!served || !u) {
      sim.emit({ type: 'drop', packetId, reason: 'no-socket', deviceId: this.id });
      return;
    }
    sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 3, protocol: 'ipv4', pduId: sim.pdu(packetId, l4, 'udp', { srcIp: ip.src, dstIp: ip.dst, appHint: 'dhcp' }) });
    const data = l4.slice(u.payloadStart, u.payloadEnd);
    const pduId = sim.pdu(packetId, data, 'dhcp');
    sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 4, protocol: 'udp', pduId });
    this.dhcp!.input(inIface, data);
  }

  protected onIpv4(inIface: IfaceSpec, ipBytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    let bytes = ipBytes;
    let ip = parseIpv4(bytes, 0);
    const nat = this.spec.nat;
    const proto = ip.protocol === IPPROTO_TCP ? 'tcp' : ip.protocol === IPPROTO_UDP ? 'udp' : undefined;

    // Inbound NAT (before routing): a reply to our public address is mapped back to the private host.
    if (nat && inIface.id === nat.outside && proto && ip.dst === inIface.ip) {
      const dport = u16(bytes, ip.headerLen + 2);
      const sport = u16(bytes, ip.headerLen);
      const e = this.natTable.find(
        (n) => n.proto === proto && n.outside.port === dport && n.remote.ip === ip.src && n.remote.port === sport,
      );
      if (!e) {
        sim.emit({ type: 'drop', packetId, reason: 'no-nat-mapping', deviceId: this.id });
        return;
      }
      bytes = natRewrite(bytes, { dst: e.inside });
      sim.emit({
        type: 'nat:translate',
        deviceId: this.id,
        packetId,
        direction: 'in',
        before: { ip: ip.dst, port: dport },
        after: { ...e.inside },
        pduId: sim.pdu(packetId, bytes, 'ipv4'),
      });
      ip = parseIpv4(bytes, 0);
    } else if (ip.dst === BROADCAST_IP || this.ownsIp(ip.dst)) {
      this.deliver(inIface, bytes, packetId);
      return;
    }

    const route = this.lookupRoute(ip.dst);
    if (!route) {
      sim.emit({ type: 'drop', packetId, reason: 'no-route', deviceId: this.id });
      return;
    }
    this.emitRoute(ip.dst, route, packetId);
    if (ip.ttl <= 1) {
      sim.emit({ type: 'drop', packetId, reason: 'ttl-expired', deviceId: this.id });
      return;
    }
    bytes = rewriteIpv4(bytes, { ttl: ip.ttl - 1 });
    sim.emit({
      type: 'forward',
      deviceId: this.id,
      packetId,
      ttlBefore: ip.ttl,
      ttlAfter: ip.ttl - 1,
      pduId: sim.pdu(packetId, bytes, 'ipv4'),
    });

    // Outbound NAT (after routing): replace the private source with our public address and a port of our own.
    if (nat && route.iface === nat.outside && nat.inside.includes(inIface.id) && proto) {
      const sport = u16(bytes, ip.headerLen);
      const dport = u16(bytes, ip.headerLen + 2);
      const outside = this.iface(nat.outside);
      let e = this.natTable.find(
        (n) =>
          n.proto === proto &&
          n.inside.ip === ip.src &&
          n.inside.port === sport &&
          n.remote.ip === ip.dst &&
          n.remote.port === dport,
      );
      if (!e) {
        let port: number;
        do port = this.rng.int(1024, 65535);
        while (this.natTable.some((n) => n.outside.port === port && n.proto === proto));
        e = {
          proto,
          inside: { ip: ip.src, port: sport },
          outside: { ip: outside.ip, port },
          remote: { ip: ip.dst, port: dport },
        };
        this.natTable.push(e);
        sim.emit({ type: 'nat:add', deviceId: this.id, entry: e });
      }
      bytes = natRewrite(bytes, { src: e.outside });
      sim.emit({
        type: 'nat:translate',
        deviceId: this.id,
        packetId,
        direction: 'out',
        before: { ...e.inside },
        after: { ...e.outside },
        pduId: sim.pdu(packetId, bytes, 'ipv4'),
      });
    }
    this.sendIp(bytes, packetId, false);
  }
}
