import { BROADCAST_IP, ipToBytes, type Ip4 } from '../bytes/addr';
import { concat, setU16, u16 } from '../bytes/bytes';
import { adjustChecksum, internetChecksum, transportChecksum } from '../bytes/checksum';
import type { NatEntry } from '../events/SimEvent';
import type { DeviceSpec, IfaceSpec } from '../model';
import { DHCP_SERVER_PORT } from '../proto/dhcp';
import { ICMP_ECHO, ICMP_ECHO_REPLY, ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED, parseIcmp } from '../proto/icmp';
import { IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP, parseIpv4, rewriteIpv4, type ParsedIpv4 } from '../proto/ipv4';
import { parseUdp } from '../proto/udp';
import { Device } from './Device';
import { DhcpServer } from './dhcp';
import type { World } from './World';

type NatChange = { src?: { ip: Ip4; port: number }; dst?: { ip: Ip4; port: number } };

/** What a NAT device looks a packet up by: the port on its own side (an echo's identifier) and the remote end. */
export interface NatKey {
  proto: NatEntry['proto'];
  /** The address on our side the packet names: the inside source going out, the outside destination coming back. */
  local: Ip4;
  port: number;
  remote: { ip: Ip4; port: number };
}

const natProto = (p: number): NatEntry['proto'] | undefined => (p === IPPROTO_TCP ? 'tcp' : p === IPPROTO_UDP ? 'udp' : p === IPPROTO_ICMP ? 'icmp' : undefined);

/** How a packet going out is keyed: its source port, or an echo request's identifier. Other ICMP is not translated. */
export function natKeyOut(b: Uint8Array): NatKey | undefined {
  const ip = parseIpv4(b, 0);
  const proto = natProto(ip.protocol);
  const l4 = ip.headerLen;
  if (proto === 'icmp') {
    const m = parseIcmp(b, l4, ip.totalLength);
    return m.type === ICMP_ECHO ? { proto, local: ip.src, port: m.id ?? 0, remote: { ip: ip.dst, port: 0 } } : undefined;
  }
  return proto && { proto, local: ip.src, port: u16(b, l4), remote: { ip: ip.dst, port: u16(b, l4 + 2) } };
}

/**
 * How a packet coming back is keyed: its destination port, or an echo reply's identifier. An ICMP error is keyed by the
 * datagram it quotes, which went the other way: the quoted source port is ours, the quoted destination the remote end,
 * whoever sent the error (what netfilter does, so errors from routers along the way find their way in).
 */
export function natKeyIn(b: Uint8Array): NatKey | undefined {
  const ip = parseIpv4(b, 0);
  const proto = natProto(ip.protocol);
  const l4 = ip.headerLen;
  if (proto === 'icmp') {
    const m = parseIcmp(b, l4, ip.totalLength);
    if (m.type === ICMP_ECHO_REPLY) return { proto, local: ip.dst, port: m.id ?? 0, remote: { ip: ip.src, port: 0 } };
    const q = m.quoted;
    const quoted = q && natProto(q.ip.protocol);
    return q && quoted ? { proto: quoted, local: q.ip.src, port: q.srcPort, remote: { ip: q.ip.dst, port: q.dstPort } } : undefined;
  }
  return proto && { proto, local: ip.dst, port: u16(b, l4 + 2), remote: { ip: ip.src, port: u16(b, l4) } };
}

export const natMatch = (k: NatKey, side: 'inside' | 'outside') => (n: NatEntry): boolean =>
  n.proto === k.proto && n[side].ip === k.local && n[side].port === k.port && n.remote.ip === k.remote.ip && n.remote.port === k.remote.port;

/**
 * Rewrites addresses/ports in an IPv4 packet and recomputes every checksum that covers them, exactly what a NAT device
 * must do (the TCP and UDP checksums cover the IP addresses through the pseudo-header).
 */
export function natRewrite(ipBytes: Uint8Array, change: NatChange): Uint8Array {
  const out = ipBytes.slice();
  const ip = parseIpv4(out, 0);
  const l4 = ip.headerLen;
  if (change.src) out.set(ipToBytes(change.src.ip), 12);
  if (change.dst) out.set(ipToBytes(change.dst.ip), 16);
  if (ip.protocol === IPPROTO_ICMP) natRewriteIcmp(out, ip, change);
  else {
    if (change.src) setU16(out, l4, change.src.port);
    if (change.dst) setU16(out, l4 + 2, change.dst.port);
    const p = parseIpv4(out, 0);
    const csumOff = ip.protocol === IPPROTO_TCP ? l4 + 16 : l4 + 6;
    setU16(out, csumOff, 0);
    let c = transportChecksum(p.src, p.dst, ip.protocol, out.subarray(l4, ip.totalLength));
    if (ip.protocol === IPPROTO_UDP && c === 0) c = 0xffff;
    setU16(out, csumOff, c);
  }
  setU16(out, 10, 0);
  setU16(out, 10, internetChecksum(out, 0, ip.headerLen));
  return out;
}

/**
 * ICMP has no ports: an echo's identifier plays the part. An error about a translated datagram quotes that datagram's
 * header as it was on the outside, so the quote is translated back too (as netfilter does), or the inside host would
 * not know the packet as its own: the quoted IP header gets a fresh checksum, the quoted UDP checksum an incremental
 * update (its data is not here to sum), and the ICMP checksum, which covers it all, is redone.
 */
function natRewriteIcmp(out: Uint8Array, ip: ParsedIpv4, change: NatChange): void {
  const l4 = ip.headerLen;
  const m = parseIcmp(out, l4, ip.totalLength);
  const id = change.src?.port ?? change.dst?.port;
  if ((m.type === ICMP_ECHO || m.type === ICMP_ECHO_REPLY) && id !== undefined) setU16(out, l4 + 4, id);
  else if (m.quoted) {
    // The quoted datagram went the other way: our destination here was its source, and the other way round.
    const q = m.quoted.start;
    const ql4 = q + m.quoted.ip.headerLen;
    const echo = m.quoted.ip.protocol === IPPROTO_ICMP;
    const words = (): Uint8Array => (echo ? out.slice(ql4, ql4 + 8) : concat(out.subarray(q + 12, q + 20), out.subarray(ql4, ql4 + 8)));
    const before = words();
    if (change.dst) {
      out.set(ipToBytes(change.dst.ip), q + 12);
      setU16(out, echo ? ql4 + 4 : ql4, change.dst.port);
    }
    if (change.src) {
      out.set(ipToBytes(change.src.ip), q + 16);
      if (!echo) setU16(out, ql4 + 2, change.src.port);
    }
    const csum = echo ? ql4 + 2 : m.quoted.ip.protocol === IPPROTO_UDP ? ql4 + 6 : -1;
    if (csum >= 0 && u16(out, csum) !== 0) setU16(out, csum, adjustChecksum(u16(out, csum), before, words()));
    setU16(out, q + 10, 0);
    setU16(out, q + 10, internetChecksum(out, q, ql4));
  }
  setU16(out, l4 + 2, 0);
  setU16(out, l4 + 2, internetChecksum(out, l4, ip.totalLength));
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
   * A packet for the router itself (or for everyone: a broadcast is never forwarded). It answers pings to its own
   * addresses; otherwise only the DHCP server listens, on the home side, and everything else is dropped.
   */
  private deliver(inIface: IfaceSpec, bytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(bytes, 0);
    const l4 = bytes.slice(ip.headerLen, ip.totalLength);
    if (ip.protocol === IPPROTO_ICMP) {
      const m = parseIcmp(l4, 0, l4.length);
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 3, protocol: 'ipv4', pduId: sim.pdu(packetId, l4, 'icmp') });
      if (m.type === ICMP_ECHO && m.checksumValid && ip.dst !== BROADCAST_IP) this.echoReply(ip, l4, m);
      else sim.emit({ type: 'drop', packetId, reason: 'no-socket', deviceId: this.id });
      return;
    }
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

    // Inbound NAT (before routing): a reply to our public address is mapped back to the private host.
    const back = nat && inIface.id === nat.outside && ip.dst === inIface.ip ? natKeyIn(bytes) : undefined;
    if (back) {
      const e = this.natTable.find(natMatch(back, 'outside'));
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
        before: { ip: ip.dst, port: back.port },
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
      // ... and the sender hears about it, from the address its packet came in on: the answer traceroute listens for.
      this.icmpError(ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED, inIface.ip, bytes);
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
    const out = nat && route.iface === nat.outside && nat.inside.includes(inIface.id) ? natKeyOut(bytes) : undefined;
    if (out) {
      const outside = this.iface(nat!.outside);
      let e = this.natTable.find(natMatch(out, 'inside'));
      if (!e) {
        let port: number;
        do port = this.rng.int(1024, 65535);
        while (this.natTable.some((n) => n.outside.port === port && n.proto === out.proto));
        e = {
          proto: out.proto,
          inside: { ip: ip.src, port: out.port },
          outside: { ip: outside.ip, port },
          remote: out.remote,
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
