import { BROADCAST_IP, type Ip4 } from '../bytes/addr';
import type { IfaceSpec } from '../model';
import { DHCP_CLIENT_PORT } from '../proto/dhcp';
import { ICMP_DEST_UNREACHABLE, ICMP_ECHO, ICMP_PORT_UNREACHABLE, parseIcmp, type ParsedIcmp } from '../proto/icmp';
import { buildIpv4, IPPROTO_ICMP, IPPROTO_TCP, IPPROTO_UDP, parseIpv4, type ParsedIpv4 } from '../proto/ipv4';
import { buildTcp, parseTcp, TCP_ACK, TCP_RST, TCP_SYN, type ParsedTcp } from '../proto/tcp';
import type { Protocol } from '../proto/types';
import { buildUdp, parseUdp } from '../proto/udp';
import { WG_PORT } from '../proto/wireguard';
import { Device } from './Device';
import { TcpConnection, tcpKey, type TcpConnOptions, type TcpHandlers } from './tcp';
import type { TunnelClient } from './vpn';

export type UdpHandler = (from: { ip: Ip4; port: number }, data: Uint8Array, packetId: string, pduId: string) => void;
/**
 * A program waiting for ICMP (ping for echo replies, traceroute for the errors about its probes): returns true when the
 * message was for it. The kernel does this matching by the identifier or the quoted header, as here.
 */
export type IcmpHandler = (ip: ParsedIpv4, msg: ParsedIcmp, bytes: Uint8Array, packetId: string, pduId: string) => boolean;

/** An end host: owns IP addresses, sockets and applications. Never forwards packets. */
export class Host extends Device {
  private udpSockets = new Map<number, { handler: UdpHandler; app?: Protocol }>();
  private icmpListeners: IcmpHandler[] = [];
  private tcpListeners = new Map<number, { opts: TcpConnOptions; onAccept: (c: TcpConnection) => void }>();
  private tcpConns = new Map<string, TcpConnection>();
  private ipId = this.rng.int(0, 0xffff);
  /** When each address last got an ICMP error, for a host that limits them. */
  private lastError = new Map<Ip4, number>();

  /** A scanner, which sees the answers to SYNs it made by hand. */
  tcpWatcher?: (from: Ip4, seg: ParsedTcp, pduId: string) => void;

  /** With a VPN, everything this host makes goes through this tunnel. */
  tunnel?: TunnelClient;

  /** The address applications use: inside the tunnel if there is one. */
  get ip(): Ip4 {
    return this.tunnel?.ip ?? this.realIp;
  }

  get realIp(): Ip4 {
    return this.ifaces[0]!.ip;
  }

  override ownsIp(ip: Ip4): boolean {
    return super.ownsIp(ip) || ip === this.tunnel?.ip;
  }

  sendOuter(ipBytes: Uint8Array, packetId: string): void {
    this.sendIp(ipBytes, packetId);
  }

  deliver(iface: IfaceSpec, ipBytes: Uint8Array, packetId: string): void {
    this.onIpv4(iface, ipBytes, packetId);
  }

  random32(): number {
    return this.rng.u32();
  }

  /** The next IPv4 identification value: this host counts up from a random start. */
  override nextIpId(): number {
    this.ipId = (this.ipId + 1) & 0xffff;
    return this.ipId;
  }

  /** Linux picks ephemeral ports from 32768–60999 (net.ipv4.ip_local_port_range). */
  ephemeralPort(): number {
    for (;;) {
      const p = this.rng.int(32768, 60999);
      if (!this.udpSockets.has(p) && ![...this.tcpConns.values()].some((c) => c.localPort === p)) return p;
    }
  }

  /** `app` says what the datagrams carry, for decoding; a socket that only reserves its port (traceroute's) has none. */
  udpBind(port: number, app: Protocol | undefined, handler: UdpHandler): void {
    this.udpSockets.set(port, { handler, app });
  }

  udpUnbind(port: number): void {
    this.udpSockets.delete(port);
  }

  icmpListen(handler: IcmpHandler): void {
    this.icmpListeners.push(handler);
  }

  icmpUnlisten(handler: IcmpHandler): void {
    this.icmpListeners = this.icmpListeners.filter((h) => h !== handler);
  }

  /** `ttl` is for traceroute's probes, which set their own; everything else goes out with the host's default. */
  udpSend(srcPort: number, dst: Ip4, dstPort: number, data: Uint8Array, packetId: string, ttl?: number): void {
    const sim = this.sim;
    const app = this.udpSockets.get(srcPort)?.app;
    const seg = buildUdp(srcPort, dstPort, data, this.ip, dst);
    sim.emit({
      type: 'encapsulate',
      deviceId: this.id,
      packetId,
      layer: 4,
      protocol: 'udp',
      pduId: sim.pdu(packetId, seg, 'udp', { srcIp: this.ip, dstIp: dst, appHint: app }),
    });
    this.ipOutput(IPPROTO_UDP, dst, seg, packetId, app, this.ip, ttl);
  }

  /** An ICMP message of a program's own (ping's echo request), sent like any packet of the host's. */
  icmpSend(dst: Ip4, msg: Uint8Array, packetId: string): void {
    const sim = this.sim;
    sim.emit({ type: 'encapsulate', deviceId: this.id, packetId, layer: 3, protocol: 'icmp', pduId: sim.pdu(packetId, msg, 'icmp') });
    this.ipOutput(IPPROTO_ICMP, dst, msg, packetId);
  }

  tcpListen(port: number, opts: TcpConnOptions, onAccept: (c: TcpConnection) => void): void {
    this.tcpListeners.set(port, { opts, onAccept });
  }

  tcpConnect(dst: Ip4, dstPort: number, opts: TcpConnOptions, handlers: TcpHandlers): TcpConnection {
    const c = new TcpConnection(this, this.ip, this.ephemeralPort(), dst, dstPort, opts);
    c.handlers = handlers;
    this.tcpConns.set(c.key, c);
    c.connect();
    return c;
  }

  /** RFC 9293: a segment for no connection gets a reset, unless it is one. This is how a closed port says no. */
  private refuse(ip: ParsedIpv4, t: ParsedTcp, length: number): void {
    if (t.flags & TCP_RST) return;
    const acked = (t.flags & TCP_ACK) !== 0;
    const flags = acked ? TCP_RST : TCP_RST | TCP_ACK;
    const seq = acked ? t.ack : 0;
    const ack = acked ? 0 : (t.seq + length + (t.flags & TCP_SYN ? 1 : 0)) >>> 0;
    const seg = buildTcp({ srcPort: t.dstPort, dstPort: t.srcPort, seq, ack, flags, window: 0, options: [] }, new Uint8Array(0), ip.dst, ip.src);
    const pk = this.sim.newPacket(this.id, 'tcp', 'TCP RST', { tcp: { connId: `${this.id}:${t.dstPort}-${ip.src}:${t.srcPort}`, relSeq: 0, relAck: 0, len: 0, flags } });
    this.ipOutput(IPPROTO_TCP, ip.src, seg, pk.id, undefined, ip.dst);
  }

  tcpRemove(c: TcpConnection): void {
    this.tcpConns.delete(c.key);
  }

  /** Wraps a transport segment in an IPv4 header and routes it. A socket bound to one of several addresses sends from that one. */
  ipOutput(protocol: number, dst: Ip4, l4: Uint8Array, packetId: string, app?: Protocol, src: Ip4 = this.ip, ttl = 64): void {
    const sim = this.sim;
    if (protocol === IPPROTO_TCP) {
      sim.emit({
        type: 'encapsulate',
        deviceId: this.id,
        packetId,
        layer: 4,
        protocol: 'tcp',
        pduId: sim.pdu(packetId, l4, 'tcp', { srcIp: src, dstIp: dst, appHint: app }),
      });
    }
    // Linux sets Don't Fragment on all of it when path-MTU discovery is on (the default), UDP and ping's requests too.
    const ip = buildIpv4({ id: this.nextIpId(), df: true, ttl, protocol, src, dst }, l4);
    sim.emit({
      type: 'encapsulate',
      deviceId: this.id,
      packetId,
      layer: 3,
      protocol: 'ipv4',
      pduId: sim.pdu(packetId, ip, 'ipv4', { appHint: app }),
    });
    this.transmitIp(ip, packetId);
  }

  protected override transmitIp(ipBytes: Uint8Array, packetId: string): void {
    if (this.tunnel) this.tunnel.send(ipBytes, packetId);
    else this.sendIp(ipBytes, packetId);
  }

  protected onIpv4(iface: IfaceSpec, ipBytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(ipBytes, 0);
    if (this.tunnel && ip.protocol === IPPROTO_UDP && ip.src === this.tunnel.server) {
      const u = parseUdp(ipBytes, ip.headerLen);
      if (u.srcPort === WG_PORT) {
        this.tunnel.receive(iface, ipBytes.slice(u.payloadStart, u.payloadEnd), packetId);
        return;
      }
    }
    // A DHCP client has no address yet, so it listens on a raw socket: anything to port 68 is for it, whatever the IP
    // destination says. A broadcast is for everyone on the link.
    const forDhcp = ip.protocol === IPPROTO_UDP && this.udpSockets.has(DHCP_CLIENT_PORT) && parseUdp(ipBytes, ip.headerLen).dstPort === DHCP_CLIENT_PORT;
    if (!this.ownsIp(ip.dst) && ip.dst !== BROADCAST_IP && !forDhcp) {
      sim.emit({ type: 'drop', packetId, reason: 'not-for-me', deviceId: this.id });
      return;
    }
    const l4 = ipBytes.slice(ip.headerLen, ip.totalLength);
    const ctx = { srcIp: ip.src, dstIp: ip.dst };
    if (ip.protocol === IPPROTO_UDP) {
      const u = parseUdp(l4, 0);
      const sock = this.udpSockets.get(u.dstPort);
      sim.emit({
        type: 'decapsulate',
        deviceId: this.id,
        packetId,
        layer: 3,
        protocol: 'ipv4',
        pduId: sim.pdu(packetId, l4, 'udp', { ...ctx, appHint: sock?.app }),
      });
      if (!sock) {
        sim.emit({ type: 'drop', packetId, reason: 'no-socket', deviceId: this.id });
        // Nobody on that port: the sender is told, from the address it wrote to. This is the answer traceroute waits for.
        if (this.spec.icmpLimit && sim.now - (this.lastError.get(ip.src) ?? -Infinity) < 1) return;
        this.lastError.set(ip.src, sim.now);
        this.icmpError(ICMP_DEST_UNREACHABLE, ICMP_PORT_UNREACHABLE, ip.dst, ipBytes);
        return;
      }
      const data = l4.slice(u.payloadStart, u.payloadEnd);
      const pduId = sim.pdu(packetId, data, sock.app ?? 'udp');
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 4, protocol: 'udp', pduId });
      sock.handler({ ip: ip.src, port: u.srcPort }, data, packetId, pduId);
    } else if (ip.protocol === IPPROTO_TCP) {
      const t = parseTcp(l4, 0);
      let conn = this.tcpConns.get(tcpKey(t.dstPort, ip.src, t.srcPort));
      const app = conn?.opts.app ?? this.tcpListeners.get(t.dstPort)?.opts.app;
      const pduId = sim.pdu(packetId, l4, 'tcp', { ...ctx, appHint: app });
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 3, protocol: 'ipv4', pduId });
      // The connection unwraps the payload for the application only when it really hands the bytes over.
      const payload = l4.slice(t.payloadStart);
      if (!conn) {
        const listener = this.tcpListeners.get(t.dstPort);
        if (listener && t.flags & TCP_SYN && !(t.flags & TCP_ACK)) {
          conn = new TcpConnection(this, ip.dst, t.dstPort, ip.src, t.srcPort, listener.opts);
          this.tcpConns.set(conn.key, conn);
          listener.onAccept(conn);
          conn.acceptSyn(t);
          return;
        }
        this.tcpWatcher?.(ip.src, t, pduId);
        sim.emit({ type: 'drop', packetId, reason: 'no-socket', deviceId: this.id });
        this.refuse(ip, t, payload.length);
        return;
      }
      conn.input(t, payload, packetId);
    } else if (ip.protocol === IPPROTO_ICMP) {
      const m = parseIcmp(l4, 0, l4.length);
      const pduId = sim.pdu(packetId, l4, 'icmp');
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 3, protocol: 'ipv4', pduId });
      if (!m.checksumValid) sim.emit({ type: 'drop', packetId, reason: 'bad-checksum', deviceId: this.id });
      // The kernel answers echo requests itself; replies and errors go to the program they concern, if one is waiting.
      else if (m.type === ICMP_ECHO && ip.dst !== BROADCAST_IP) this.echoReply(ip, l4, m);
      else if (!this.icmpListeners.some((h) => h(ip, m, l4, packetId, pduId))) sim.emit({ type: 'drop', packetId, reason: 'no-socket', deviceId: this.id });
    }
  }
}
