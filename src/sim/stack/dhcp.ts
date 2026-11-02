import { BROADCAST_IP, BROADCAST_MAC, maskToPrefixLen, networkOf, UNSPECIFIED_IP, type Ip4, type Mac } from '../bytes/addr';
import { hex } from '../bytes/bytes';
import type { Rng } from '../core/Rng';
import type { AppSpec, DhcpServerSpec, IfaceSpec } from '../model';
import {
  BOOTREPLY,
  BOOTREQUEST,
  buildDhcp,
  DHCP_ACK,
  DHCP_CLIENT_PORT,
  DHCP_DISCOVER,
  DHCP_OFFER,
  DHCP_REQUEST,
  DHCP_SERVER_PORT,
  dhcpTypeName,
  parseDhcp,
  type DhcpMessage,
} from '../proto/dhcp';
import { buildIpv4, IPPROTO_UDP } from '../proto/ipv4';
import { buildUdp } from '../proto/udp';
import type { Device } from './Device';
import type { Host } from './Host';

/** RFC 2131 §4.1: first retry after about 4 s, doubling each time; dhcpcd gives up after a few tries. */
const DHCP_TIMEOUT = 4;
const DHCP_ATTEMPTS = 4;
/** What dhcpcd and dhclient ask for: subnet mask, router, DNS servers, domain name, broadcast address, lease time, server id. */
const PARAM_REQUEST = [1, 3, 6, 15, 28, 51, 54];

type DhcpClientSpec = Extract<AppSpec, { kind: 'dhcp-client' }>;

/** What a lease gives the client. */
export interface Lease {
  ip: Ip4;
  mask: Ip4;
  router?: Ip4;
  dns: Ip4[];
  leaseTime: number;
  server: Ip4;
}

/**
 * Wraps a DHCP message in UDP and IPv4 and sends it straight out of `iface` to `dstMac`: no route and no ARP. The
 * client has no address to route from yet, and the server's reply goes to an address nobody has claimed yet.
 */
function sendDhcp(dev: Device, iface: IfaceSpec, dstMac: Mac, src: Ip4, dst: Ip4, srcPort: number, dstPort: number, msg: Uint8Array, packetId: string, ipId: number): void {
  const sim = dev.sim;
  const seg = buildUdp(srcPort, dstPort, msg, src, dst);
  sim.emit({ type: 'encapsulate', deviceId: dev.id, packetId, layer: 4, protocol: 'udp', pduId: sim.pdu(packetId, seg, 'udp', { srcIp: src, dstIp: dst, appHint: 'dhcp' }) });
  // Sent through a raw socket, so no Don't Fragment: the kernel's path-MTU discovery is not involved.
  const ip = buildIpv4({ id: ipId, df: false, ttl: 64, protocol: IPPROTO_UDP, src, dst }, seg);
  sim.emit({ type: 'encapsulate', deviceId: dev.id, packetId, layer: 3, protocol: 'ipv4', pduId: sim.pdu(packetId, ip, 'ipv4', { appHint: 'dhcp' }) });
  dev.sendOnIface(iface, dstMac, ip, packetId);
}

/**
 * The DHCP server in a home router: fixed leases keyed by MAC. It answers an OFFER to a DISCOVER and an ACK to a
 * REQUEST for the right address, each unicast to the client's MAC with the offered address as IP destination (what
 * ISC dhcpd and dnsmasq do when the client did not set the broadcast flag, as no client here does).
 */
export class DhcpServer {
  private ipId?: number;

  constructor(
    private readonly router: Device,
    private readonly spec: DhcpServerSpec,
    private readonly rng: Rng,
  ) {}

  input(iface: IfaceSpec, data: Uint8Array): void {
    const m = parseDhcp(data, 0);
    if (m.op !== BOOTREQUEST) return;
    const lease = this.spec.leases[m.chaddr];
    // A stranger gets nothing: this server only knows its fixed leases.
    if (!lease) return;
    const type = m.options.type;
    if (type === DHCP_DISCOVER) this.reply(iface, m, DHCP_OFFER, lease);
    else if (type === DHCP_REQUEST) {
      // The client may have taken another server's offer; then this one has nothing to say.
      if (m.options.serverId && m.options.serverId !== iface.ip) return;
      if (m.options.requestedIp === lease) this.reply(iface, m, DHCP_ACK, lease);
    }
  }

  private reply(iface: IfaceSpec, req: ReturnType<typeof parseDhcp>, type: number, lease: Ip4): void {
    const sim = this.router.sim;
    sim.after(this.spec.processing, () => {
      const msg: DhcpMessage = {
        op: BOOTREPLY,
        xid: req.xid,
        secs: 0,
        broadcast: false,
        ciaddr: req.ciaddr,
        yiaddr: lease,
        siaddr: iface.ip,
        giaddr: req.giaddr,
        chaddr: req.chaddr,
        options: { type, serverId: iface.ip, leaseTime: this.spec.lease, subnetMask: this.spec.mask, routers: [this.spec.router], dns: this.spec.dns },
      };
      const bytes = buildDhcp(msg);
      const pk = sim.newPacket(this.router.id, 'dhcp', `DHCP ${dhcpTypeName(type)} ${lease}`);
      const pduId = sim.pdu(pk.id, bytes, 'dhcp');
      sim.emit({
        type: 'app',
        deviceId: this.router.id,
        app: 'dhcp-server',
        action: type === DHCP_OFFER ? 'dhcp-offer' : 'dhcp-ack',
        pduId,
        info: { type: dhcpTypeName(type), mac: req.chaddr, address: msg.yiaddr, mask: this.spec.mask, router: this.spec.router, dns: this.spec.dns, lease: this.spec.lease, xid: hex(req.xid, 8) },
      });
      sim.emit({ type: 'encapsulate', deviceId: this.router.id, packetId: pk.id, layer: 5, protocol: 'dhcp', pduId });
      this.ipId = ((this.ipId ?? this.rng.int(0, 0xffff)) + 1) & 0xffff;
      sendDhcp(this.router, iface, req.chaddr, iface.ip, lease, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, bytes, pk.id, this.ipId);
    });
  }
}

/**
 * A DHCP client like dhcpcd: DISCOVER, take the OFFER, REQUEST it, and on the ACK set the interface's address, the
 * routes and the resolver. Each message is resent after 4 s, then 8, then 16, with the same transaction id; after
 * four tries it gives up. `onConfigured` runs once the lease is in place, so the browser can start.
 */
export function startDhcpClient(host: Host, spec: DhcpClientSpec, onConfigured: (lease: Lease) => void): void {
  const sim = host.sim;
  const iface = host.ifaces[0]!;
  const xid = host.random32();
  const startedAt = sim.now;
  let state: 'selecting' | 'requesting' = 'selecting';
  let offer: { ip: Ip4; server: Ip4 } | undefined;
  let attempt = 0;
  let timeout = DHCP_TIMEOUT;
  const timer = host.timer('dhcp', 'dhcp-retry');

  const send = (retry: boolean): void => {
    attempt++;
    const type = state === 'selecting' ? DHCP_DISCOVER : DHCP_REQUEST;
    const msg: DhcpMessage = {
      op: BOOTREQUEST,
      xid,
      // How long we have been at it, whole seconds: 0 at first, 4 on the first resend.
      secs: Math.floor(sim.now - startedAt),
      broadcast: false,
      ciaddr: UNSPECIFIED_IP,
      yiaddr: UNSPECIFIED_IP,
      siaddr: UNSPECIFIED_IP,
      giaddr: UNSPECIFIED_IP,
      chaddr: iface.mac,
      options: {
        type,
        clientId: iface.mac,
        ...(offer ? { requestedIp: offer.ip, serverId: offer.server } : {}),
        hostName: spec.hostName,
        paramRequest: PARAM_REQUEST,
      },
    };
    const bytes = buildDhcp(msg);
    const pk = sim.newPacket(host.id, 'dhcp', `DHCP ${dhcpTypeName(type)}${offer ? ` ${offer.ip}` : ''}${retry ? ' (retry)' : ''}`);
    const pduId = sim.pdu(pk.id, bytes, 'dhcp');
    sim.emit({
      type: 'app',
      deviceId: host.id,
      app: 'dhcp-client',
      action: type === DHCP_DISCOVER ? 'dhcp-discover' : 'dhcp-request',
      pduId,
      info: { xid: hex(xid, 8), attempt, secs: msg.secs, ...(offer ? { address: offer.ip, server: offer.server } : {}) },
    });
    sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'dhcp', pduId });
    sendDhcp(host, iface, BROADCAST_MAC, UNSPECIFIED_IP, BROADCAST_IP, DHCP_CLIENT_PORT, DHCP_SERVER_PORT, bytes, pk.id, host.nextIpId());
    timer.set(timeout, () => {
      if (attempt < DHCP_ATTEMPTS) {
        timeout *= 2;
        send(true);
      } else {
        host.udpUnbind(DHCP_CLIENT_PORT);
        sim.emit({ type: 'app', deviceId: host.id, app: 'dhcp-client', action: 'error', info: { reason: 'no DHCP server answered' } });
      }
    });
  };

  host.udpBind(DHCP_CLIENT_PORT, 'dhcp', (from, data) => {
    const m = parseDhcp(data, 0);
    if (m.op !== BOOTREPLY || m.xid !== xid) return;
    const type = m.options.type;
    if (state === 'selecting' && type === DHCP_OFFER) {
      timer.cancel();
      offer = { ip: m.yiaddr, server: m.options.serverId ?? from.ip };
      state = 'requesting';
      attempt = 0;
      timeout = DHCP_TIMEOUT;
      send(false);
    } else if (state === 'requesting' && type === DHCP_ACK && offer && m.yiaddr === offer.ip) {
      timer.cancel();
      host.udpUnbind(DHCP_CLIENT_PORT);
      const lease: Lease = { ip: m.yiaddr, mask: m.options.subnetMask ?? '255.255.255.0', router: m.options.routers?.[0], dns: m.options.dns ?? [], leaseTime: m.options.leaseTime ?? 0, server: offer.server };
      configure(lease);
    }
  });

  // The lease becomes the interface's address, a route to the neighbours and a default route via the router.
  const configure = (lease: Lease): void => {
    const prefixLen = maskToPrefixLen(lease.mask);
    iface.ip = lease.ip;
    host.routes.push({ network: networkOf(lease.ip, prefixLen), prefixLen, iface: iface.id });
    if (lease.router) host.routes.push({ network: '0.0.0.0', prefixLen: 0, via: lease.router, iface: iface.id });
    sim.emit({
      type: 'app',
      deviceId: host.id,
      app: 'dhcp-client',
      action: 'dhcp-configured',
      info: { address: lease.ip, prefixLen, mask: lease.mask, router: lease.router ?? '', dns: lease.dns, lease: lease.leaseTime, server: lease.server },
    });
    onConfigured(lease);
  };

  send(false);
}
