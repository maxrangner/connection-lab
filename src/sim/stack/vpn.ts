import type { Ip4 } from '../bytes/addr';
import { rngFor } from '../core/Rng';
import type { IfaceSpec } from '../model';
import { buildIpv4, IPPROTO_TCP, IPPROTO_UDP, parseIpv4, rewriteIpv4 } from '../proto/ipv4';
import { buildUdp, parseUdp, UDP_HEADER_LEN } from '../proto/udp';
import { buildWgData, openWgData, WG_PORT } from '../proto/wireguard';
import { u16 } from '../bytes/bytes';
import { Host } from './Host';
import { natRewrite } from './Router';

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

interface Mapping {
  proto: 'udp' | 'tcp';
  inside: { ip: Ip4; port: number };
  outside: { ip: Ip4; port: number };
  remote: { ip: Ip4; port: number };
}

/** The far end of the tunnel: opens packets, sends them on from its own address, and seals what comes back. */
export class VpnServer extends Host {
  private readonly keys = tunnelKeys(this.world.seed);
  private counter = 0;
  private peer: { ip: Ip4; port: number } | null = null;
  private nat: Mapping[] = [];

  protected override onIpv4(iface: IfaceSpec, bytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(bytes, 0);
    const proto = ip.protocol === IPPROTO_TCP ? 'tcp' : ip.protocol === IPPROTO_UDP ? 'udp' : null;
    if (ip.dst === this.ip && proto === 'udp' && parseUdp(bytes, ip.headerLen).dstPort === WG_PORT) {
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
      sim.emit({ type: 'tunnel:unwrap', deviceId: this.id, packetId, pduId: sim.pdu(packetId, inner, 'ipv4'), addr: { src: p.src, dst: p.dst } });
      this.sendOn(inner, packetId);
      return;
    }
    const dport = proto ? u16(bytes, ip.headerLen + 2) : 0;
    const e = this.nat.find((n) => n.proto === proto && n.outside.port === dport && n.remote.ip === ip.src);
    if (ip.dst === this.ip && e && this.peer) {
      const back = natRewrite(bytes, { dst: e.inside });
      sim.emit({ type: 'nat:translate', deviceId: this.id, packetId, direction: 'in', before: { ip: ip.dst, port: dport }, after: { ...e.inside }, pduId: sim.pdu(packetId, back, 'ipv4') });
      const msg = buildWgData(this.keys.down, this.keys.downIndex, this.counter, back);
      const outer = buildIpv4({ id: this.counter++ & 0xffff, df: true, ttl: 64, protocol: IPPROTO_UDP, src: this.ip, dst: this.peer.ip }, buildUdp(WG_PORT, this.peer.port, msg, this.ip, this.peer.ip));
      sim.emit({ type: 'tunnel:wrap', deviceId: this.id, packetId, pduId: sim.pdu(packetId, outer, 'ipv4'), addr: { src: this.ip, dst: this.peer.ip } });
      this.sendIp(outer, packetId);
      return;
    }
    super.onIpv4(iface, bytes, packetId);
  }

  /** Like a NAT router: the world sees the VPN server's address, not the tunnel's. */
  private sendOn(inner: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(inner, 0);
    const proto = ip.protocol === IPPROTO_TCP ? 'tcp' : 'udp';
    const sport = u16(inner, ip.headerLen);
    const dport = u16(inner, ip.headerLen + 2);
    let e = this.nat.find((n) => n.proto === proto && n.inside.port === sport && n.remote.ip === ip.dst && n.remote.port === dport);
    if (!e) {
      let port: number;
      do port = this.random32() % 28000 + 32768;
      while (this.nat.some((n) => n.outside.port === port));
      e = { proto, inside: { ip: ip.src, port: sport }, outside: { ip: this.ip, port }, remote: { ip: ip.dst, port: dport } };
      this.nat.push(e);
    }
    const aged = rewriteIpv4(inner, { ttl: ip.ttl - 1 });
    sim.emit({ type: 'forward', deviceId: this.id, packetId, ttlBefore: ip.ttl, ttlAfter: ip.ttl - 1, pduId: sim.pdu(packetId, aged, 'ipv4') });
    const out = natRewrite(aged, { src: e.outside });
    sim.emit({ type: 'nat:translate', deviceId: this.id, packetId, direction: 'out', before: { ...e.inside }, after: { ...e.outside }, pduId: sim.pdu(packetId, out, 'ipv4') });
    this.sendIp(out, packetId, false);
  }
}
