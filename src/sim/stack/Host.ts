import type { Ip4 } from '../bytes/addr';
import type { IfaceSpec } from '../model';
import { buildIpv4, IPPROTO_TCP, IPPROTO_UDP, parseIpv4 } from '../proto/ipv4';
import { parseTcp, TCP_ACK, TCP_SYN } from '../proto/tcp';
import type { Protocol } from '../proto/types';
import { buildUdp, parseUdp, UDP_HEADER_LEN } from '../proto/udp';
import { WG_PORT } from '../proto/wireguard';
import { Device } from './Device';
import { TcpConnection, type TcpConnOptions, type TcpHandlers } from './tcp';
import type { TunnelClient } from './vpn';

export type UdpHandler = (from: { ip: Ip4; port: number }, data: Uint8Array, packetId: string, pduId: string) => void;

/** An end host: owns IP addresses, sockets and applications. Never forwards packets. */
export class Host extends Device {
  private udpSockets = new Map<number, { handler: UdpHandler; app: Protocol }>();
  private tcpListeners = new Map<number, { opts: TcpConnOptions; onAccept: (c: TcpConnection) => void }>();
  private tcpConns = new Map<string, TcpConnection>();
  private ipId = this.rng.int(0, 0xffff);

  /** With a VPN, everything this host makes goes through this tunnel. */
  tunnel?: TunnelClient;

  /** The address applications use: inside the tunnel if there is one. */
  get ip(): Ip4 {
    return this.tunnel?.ip ?? this.realIp;
  }

  get realIp(): Ip4 {
    return this.spec.ifaces[0]!.ip;
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

  /** Linux picks ephemeral ports from 32768–60999 (net.ipv4.ip_local_port_range). */
  ephemeralPort(): number {
    for (;;) {
      const p = this.rng.int(32768, 60999);
      if (!this.udpSockets.has(p) && ![...this.tcpConns.values()].some((c) => c.localPort === p)) return p;
    }
  }

  udpBind(port: number, app: Protocol, handler: UdpHandler): void {
    this.udpSockets.set(port, { handler, app });
  }

  udpUnbind(port: number): void {
    this.udpSockets.delete(port);
  }

  udpSend(srcPort: number, dst: Ip4, dstPort: number, data: Uint8Array, packetId: string): void {
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
    // Linux sets Don't Fragment on UDP too when path-MTU discovery is on (the default).
    this.ipOutput(IPPROTO_UDP, dst, seg, packetId, true, app);
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

  tcpRemove(c: TcpConnection): void {
    this.tcpConns.delete(c.key);
  }

  /** Wraps a transport segment in an IPv4 header and routes it. */
  ipOutput(protocol: number, dst: Ip4, l4: Uint8Array, packetId: string, df: boolean, app?: Protocol): void {
    const sim = this.sim;
    if (protocol === IPPROTO_TCP) {
      sim.emit({
        type: 'encapsulate',
        deviceId: this.id,
        packetId,
        layer: 4,
        protocol: 'tcp',
        pduId: sim.pdu(packetId, l4, 'tcp', { srcIp: this.ip, dstIp: dst, appHint: app }),
      });
    }
    this.ipId = (this.ipId + 1) & 0xffff;
    const ip = buildIpv4({ id: this.ipId, df, ttl: this.spec.initialTtl ?? 64, protocol, src: this.ip, dst }, l4);
    sim.emit({
      type: 'encapsulate',
      deviceId: this.id,
      packetId,
      layer: 3,
      protocol: 'ipv4',
      pduId: sim.pdu(packetId, ip, 'ipv4', { appHint: app }),
    });
    if (this.tunnel) this.tunnel.send(ip, packetId);
    else this.sendIp(ip, packetId);
  }

  protected onIpv4(iface: IfaceSpec, ipBytes: Uint8Array, packetId: string): void {
    const sim = this.sim;
    const ip = parseIpv4(ipBytes, 0);
    if (this.tunnel && ip.protocol === IPPROTO_UDP && ip.src === this.tunnel.server) {
      const u = parseUdp(ipBytes, ip.headerLen);
      if (u.srcPort === WG_PORT) {
        this.tunnel.receive(iface, ipBytes.slice(ip.headerLen + UDP_HEADER_LEN, ip.headerLen + u.length), packetId);
        return;
      }
    }
    if (!this.ownsIp(ip.dst)) {
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
        return;
      }
      const data = l4.slice(u.payloadStart, u.payloadEnd);
      const pduId = sim.pdu(packetId, data, sock.app);
      sim.emit({ type: 'decapsulate', deviceId: this.id, packetId, layer: 4, protocol: 'udp', pduId });
      sock.handler({ ip: ip.src, port: u.srcPort }, data, packetId, pduId);
    } else if (ip.protocol === IPPROTO_TCP) {
      const t = parseTcp(l4, 0);
      let conn = this.tcpConns.get(`${t.dstPort}|${ip.src}|${t.srcPort}`);
      const app = conn?.opts.app ?? this.tcpListeners.get(t.dstPort)?.opts.app;
      sim.emit({
        type: 'decapsulate',
        deviceId: this.id,
        packetId,
        layer: 3,
        protocol: 'ipv4',
        pduId: sim.pdu(packetId, l4, 'tcp', { ...ctx, appHint: app }),
      });
      const payload = l4.slice(t.payloadStart);
      if (payload.length && app) {
        sim.emit({
          type: 'decapsulate',
          deviceId: this.id,
          packetId,
          layer: 4,
          protocol: 'tcp',
          pduId: sim.pdu(packetId, payload, app),
        });
      }
      if (!conn) {
        const listener = this.tcpListeners.get(t.dstPort);
        if (listener && t.flags & TCP_SYN && !(t.flags & TCP_ACK)) {
          conn = new TcpConnection(this, ip.dst, t.dstPort, ip.src, t.srcPort, listener.opts);
          this.tcpConns.set(conn.key, conn);
          listener.onAccept(conn);
          conn.acceptSyn(t);
          return;
        }
        sim.emit({ type: 'drop', packetId, reason: 'no-socket', deviceId: this.id });
        return;
      }
      conn.input(t, payload, packetId);
    }
  }
}
