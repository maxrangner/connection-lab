import type { Ip4 } from '../bytes/addr';
import { rngFor } from '../core/Rng';
import type { NatEntry } from '../events/SimEvent';
import type { IfaceSpec } from '../model';
import { ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED } from '../proto/icmp';
import { buildIpv4, IPPROTO_UDP, parseIpv4, rewriteIpv4 } from '../proto/ipv4';
import { buildUdp, parseUdp, UDP_HEADER_LEN } from '../proto/udp';
import { buildWgData, openWgData, WG_PORT } from '../proto/wireguard';
import { u16 } from '../bytes/bytes';
import { Host } from './Host';
import { natKeyIn, natKeyOut, natMatch, natRewrite } from './Router';

/**
 * A WireGuard tunnel. The client hands over every IP packet it makes; they travel sealed in UDP to the VPN server, which
 * opens them, sends them on from its own address, and seals the replies the same way. The session keys stand in for the
 * ones the Noise handshake would produce: they come from the seeded Rng, and that handshake is not shown.
 */
export interface TunnelKeys {
  up: Uint8Array;
  down: Uint8Array;
  upIndex: number;
  downIndex: number;
}

export function tunnelKeys(seed: number): TunnelKeys {
  const rng = rngFor(seed, 'wireguard');
  const key = (): Uint8Array => Uint8Array.from({ length: 32 }, () => rng.u32() & 0xff);
  return { up: key(), down: key(), upIndex: rng.u32(), downIndex: rng.u32() };
}

function outerPacket(ipId: number, src: Ip4, sport: number, dst: Ip4, dport: number, msg: Uint8Array): Uint8Array {
  return buildIpv4({ id: ipId & 0xffff, df: true, ttl: 64, protocol: IPPROTO_UDP, src, dst }, buildUdp(sport, dport, msg, src, dst));
}

const innerOf = (opened: Uint8Array): Uint8Array => opened.subarray(0, u16(opened, 2));

export class TunnelClient {
  private readonly keys: TunnelKeys;
  private readonly port: number;
  private counter = 0;

  constructor(
    private readonly host: Host,
    readonly ip: Ip4,
    readonly server: Ip4,
  ) {
    this.keys = tunnelKeys(host.world.seed);
    this.port = host.ephemeralPort();
  }

  send(inner: Uint8Array, packetId: string): void {
    const sim = this.host.sim;
    const msg = buildWgData(this.keys.up, this.keys.upIndex, this.counter, inner);
    const outer = outerPacket(this.counter++, this.host.realIp, this.port, this.server, WG_PORT, msg);
    sim.emit({ type: 'tunnel:wrap', deviceId: this.host.id, packetId, pduId: sim.pdu(packetId, outer, 'ipv4'), addr: { src: this.host.realIp, dst: this.server } });
    this.host.sendOuter(outer, packetId);
  }

  receive(iface: IfaceSpec, msg: Uint8Array, packetId: string): void {
    const sim = this.host.sim;
    const opened = openWgData(this.keys.down, msg);
    if (!opened) {
      sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.host.id });
      return;
    }
    const inner = innerOf(opened);
    const ip = parseIpv4(inner, 0);
    sim.emit({ type: 'tunnel:unwrap', deviceId: this.host.id, packetId, pduId: sim.pdu(packetId, inner, 'ipv4'), addr: { src: ip.src, dst: ip.dst } });
    this.host.deliver(iface, inner, packetId);
  }
}

/** The far end of the tunnel: opens packets, sends them on from its own address, and seals what comes back. */
export class VpnServer extends Host {
  private readonly keys = tunnelKeys(this.world.seed);
  private counter = 0;
  private peer: { ip: Ip4; port: number } | null = null;
  /** The device's address inside the tunnel, learnt from what it sends (WireGuard's "allowed IPs" for the peer). */
  private allowed: Ip4 | null = null;
  private nat: NatEntry[] = [];

  protected override onIpv4(iface: IfaceSpec, bytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(bytes, 0);
    if (ip.dst === this.ip && ip.protocol === IPPROTO_UDP && parseUdp(bytes, ip.headerLen).dstPort === WG_PORT) {
      const udp = parseUdp(bytes, ip.headerLen);
      const opened = openWgData(this.keys.up, bytes.slice(ip.headerLen + UDP_HEADER_LEN, ip.headerLen + udp.length));
      if (!opened) {
        sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id });
        return;
      }
      // The peer may be behind NAT: the address and port its messages arrive from are where replies go.
      this.peer = { ip: ip.src, port: udp.srcPort };
      const inner = innerOf(opened);
      const p = parseIpv4(inner, 0);
      this.allowed = p.src;
      sim.emit({ type: 'tunnel:unwrap', deviceId: this.id, packetId, pduId: sim.pdu(packetId, inner, 'ipv4'), addr: { src: p.src, dst: p.dst } });
      this.sendOn(inner, packetId);
      return;
    }
    const back = ip.dst === this.ip ? natKeyIn(bytes) : undefined;
    const e = back && this.nat.find(natMatch(back, 'outside'));
    if (e && this.peer) {
      if (ip.ttl <= 1) {
        sim.emit({ type: 'drop', packetId, reason: 'ttl-expired', deviceId: this.id });
        return;
      }
      const aged = rewriteIpv4(bytes, { ttl: ip.ttl - 1 });
      sim.emit({ type: 'forward', deviceId: this.id, packetId, ttlBefore: ip.ttl, ttlAfter: ip.ttl - 1, pduId: sim.pdu(packetId, aged, 'ipv4') });
      const inner = natRewrite(aged, { dst: e.inside });
      sim.emit({ type: 'nat:translate', deviceId: this.id, packetId, direction: 'in', before: { ip: ip.dst, port: back.port }, after: { ...e.inside }, pduId: sim.pdu(packetId, inner, 'ipv4') });
      this.sealToPeer(inner, packetId);
      return;
    }
    super.onIpv4(iface, bytes, packetId);
  }

  /** What is for the device inside the tunnel goes sealed through it; the tunnel is the route to that address. */
  protected override transmitIp(ipBytes: Uint8Array, packetId: string): void {
    if (this.peer && parseIpv4(ipBytes, 0).dst === this.allowed) this.sealToPeer(ipBytes, packetId);
    else this.sendIp(ipBytes, packetId);
  }

  private sealToPeer(inner: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const peer = this.peer!;
    const msg = buildWgData(this.keys.down, this.keys.downIndex, this.counter, inner);
    const outer = outerPacket(this.counter++, this.ip, WG_PORT, peer.ip, peer.port, msg);
    sim.emit({ type: 'tunnel:wrap', deviceId: this.id, packetId, pduId: sim.pdu(packetId, outer, 'ipv4'), addr: { src: this.ip, dst: peer.ip } });
    this.sendIp(outer, packetId);
  }

  /** Like a NAT router: the world sees the VPN server's address, not the tunnel's. */
  private sendOn(inner: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(inner, 0);
    // The tunnel's far end is a hop: a probe whose TTL ends here is answered by the VPN server, from its own address.
    if (ip.ttl <= 1) {
      sim.emit({ type: 'drop', packetId, reason: 'ttl-expired', deviceId: this.id });
      this.icmpError(ICMP_TIME_EXCEEDED, ICMP_TTL_EXCEEDED, this.ip, inner);
      return;
    }
    const aged = rewriteIpv4(inner, { ttl: ip.ttl - 1 });
    sim.emit({ type: 'forward', deviceId: this.id, packetId, ttlBefore: ip.ttl, ttlAfter: ip.ttl - 1, pduId: sim.pdu(packetId, aged, 'ipv4') });
    const key = natKeyOut(aged);
    if (!key) {
      this.sendIp(aged, packetId, false);
      return;
    }
    let e = this.nat.find(natMatch(key, 'inside'));
    if (!e) {
      let port: number;
      do port = this.random32() % 28000 + 32768;
      while (port === WG_PORT || this.nat.some((n) => n.outside.port === port));
      e = { proto: key.proto, inside: { ip: ip.src, port: key.port }, outside: { ip: this.ip, port }, remote: key.remote };
      this.nat.push(e);
      sim.emit({ type: 'nat:add', deviceId: this.id, entry: e });
    }
    const out = natRewrite(aged, { src: e.outside });
    sim.emit({ type: 'nat:translate', deviceId: this.id, packetId, direction: 'out', before: { ...e.inside }, after: { ...e.outside }, pduId: sim.pdu(packetId, out, 'ipv4') });
    this.sendIp(out, packetId, false);
  }
}
