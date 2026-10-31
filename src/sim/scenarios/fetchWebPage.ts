import { ascii, fromBase64 } from '../bytes/bytes';
import type { Scenario } from '../model';
import {
  CAPTURED_A_RECORDS,
  CAPTURED_DNS_TTL,
  CAPTURED_FROM_IP,
  HTTP_REQUEST,
  HTTP_RESPONSE_BASE64,
} from './exampleComCapture';
import * as tlsExample from './tlsCapture_example_com';
import * as tlsCern from './tlsCapture_info_cern_ch';
import * as tlsPhoto from './tlsCapture_httpbin_org';
import { CERN_A_RECORDS, CERN_DNS_TTL, CERN_HOST, CERN_HTTP_REQUEST, CERN_HTTP_RESPONSE_BASE64, CERN_IP, CERN_PATH } from './infoCernCapture';
import { PHOTO_A_RECORDS, PHOTO_DNS_TTL, PHOTO_HOST, PHOTO_HTTP_REQUEST, PHOTO_HTTP_RESPONSE_BASE64, PHOTO_IP, PHOTO_PATH } from './photoCapture';

/**
 * Addresses used by the "fetch a web page" scenario.
 * - The LAN uses the private range 192.168.1.0/24 (RFC 1918), as most home routers do.
 * - The home router's public address is from 203.0.113.0/24, a documentation range (RFC 5737) standing in for
 *   whatever address your ISP gives you. The ISP's backbone links use 198.51.100.0/24, also documentation.
 * - 1.1.1.1 (Cloudflare's public resolver) and example.com's addresses are real.
 * - MACs: the first three bytes (OUI) identify a vendor; these are plausible but made up.
 */
export const ADDR = {
  laptop: { ip: '192.168.1.23', mac: '3c:22:fb:5a:10:e4' },
  phone: { ip: '192.168.1.42', mac: 'f0:5c:77:3e:91:2a' },
  homeLan: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:01' },
  homeWlan: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:03' },
  homeWan: { ip: '203.0.113.7', mac: 'a4:91:b1:7d:02:02' },
  ispCustomer: { ip: '203.0.113.1', mac: '00:1b:21:3a:4c:01' },
  ispToResolver: { ip: '198.51.100.1', mac: '00:1b:21:3a:4c:02' },
  ispToServer: { ip: '198.51.100.5', mac: '00:1b:21:3a:4c:03' },
  ispToVpn: { ip: '198.51.100.9', mac: '00:1b:21:3a:4c:04' },
  vpn: { ip: '198.51.100.10', mac: '00:0c:29:5a:cc:03', tunnelIp: '10.8.0.2' },
  vpnToServer: { mac: '00:0c:29:5a:cc:04' },
  vpnToResolver: { mac: '00:0c:29:5a:cc:05' },
  resolver: { ip: '1.1.1.1', mac: '00:0c:29:1d:aa:01' },
  resolverFromVpn: { mac: '00:0c:29:1d:aa:02' },
  server: { ip: CAPTURED_FROM_IP, mac: '00:0c:29:7e:bb:02' },
  serverFromVpn: { mac: '00:0c:29:7e:bb:03' },
} as const;

export interface FetchWebPageOptions {
  /** MSS the laptop advertises in its SYN. */
  mss?: number;
  /**
   * Which real page to fetch: example.com (932 bytes, one packet) or the first website ever,
   * info.cern.ch/hypertext/WWW/TheProject.html (2450 bytes, so the reply needs more than one packet), or a real
   * JPEG from httpbin.org (35 588 bytes, so it needs about 25 packets and TCP's window really matters).
   */
  site?: 'example.com' | 'info.cern.ch' | 'httpbin.org';
  /**
   * A second visit soon after the first: the laptop still has the address in its DNS cache (within the record's
   * TTL), and the laptop and home router still know each other's MAC addresses, so neither looks anything up.
   */
  revisit?: boolean;
  /**
   * Satellite internet: the line from the home router to the ISP goes up to a geostationary satellite and back,
   * about 36 000 km each way, so it takes about 280 ms one way (and is slower, 25 Mbit/s).
   */
  slow?: boolean;
  /** HTTPS: the same page over a real captured TLS 1.3 session, so everything after the hellos is encrypted. */
  https?: boolean;
  /**
   * A WireGuard VPN: every packet of the device goes sealed to the VPN server, which sends it on from its own address.
   * Packets are smaller inside a tunnel: MSS 1380, as for WireGuard's usual MTU of 1420. A real VPN server sits in
   * another network, so what it sends on does not pass your ISP again: here it has its own cables to where it goes.
   */
  vpn?: boolean;
  /** The device and its home router already know each other's MAC addresses (ARP caches stay warm for a while). */
  warmArp?: boolean;
  /** Which device opens the page: the laptop on its Ethernet cable, or the phone over Wi-Fi. */
  from?: 'laptop' | 'phone';
  /**
   * The other device opens a page too, a few milliseconds later: plain http://example.com/, with no VPN and nothing
   * remembered, so the home router has two conversations to tell apart at once.
   */
  together?: boolean;
}

/** How long after the first device the other one starts, in seconds: close enough that their packets interleave. */
export const COMPANION_DELAY = 0.004;

/** What the scenario needs to know about each real site. */
const SITES = {
  'example.com': { url: 'http://example.com/', ip: CAPTURED_FROM_IP, request: HTTP_REQUEST, response: HTTP_RESPONSE_BASE64, tls: tlsExample },
  'info.cern.ch': { url: `http://${CERN_HOST}${CERN_PATH}`, ip: CERN_IP, request: CERN_HTTP_REQUEST, response: CERN_HTTP_RESPONSE_BASE64, tls: tlsCern },
  'httpbin.org': { url: `http://${PHOTO_HOST}${PHOTO_PATH}`, ip: PHOTO_IP, request: PHOTO_HTTP_REQUEST, response: PHOTO_HTTP_RESPONSE_BASE64, tls: tlsPhoto },
} as const;

export function fetchWebPage(opts: FetchWebPageOptions = {}): Scenario {
  const mss = opts.mss ?? 1460;
  const site = SITES[opts.site ?? 'example.com'];
  const server = { ip: site.ip, mac: ADDR.server.mac };
  const revisit = !!opts.revisit;
  const tls = opts.https ? { host: site.tls.TLS_HOST, flights: site.tls.TLS_FLIGHTS, secrets: site.tls.TLS_SECRETS } : undefined;
  const url = opts.https ? site.url.replace(/^http:/, 'https:') : site.url;
  const warm = revisit || !!opts.warmArp;
  const from = opts.from ?? 'laptop';
  const browser = (gateway: { ip: string; mac: string }) => ({
    ...(opts.vpn ? { tunnel: { ip: ADDR.vpn.tunnelIp, server: ADDR.vpn.ip } } : {}),
    ...(warm ? { arp: { [gateway.ip]: gateway.mac } } : {}),
    apps: [
      {
        kind: 'browser' as const,
        url,
        resolver: ADDR.resolver.ip,
        request: ascii(opts.https ? site.tls.TLS_REQUEST : site.request),
        ...(revisit ? { knownAddress: site.ip } : {}),
        ...(tls ? { tls } : {}),
      },
    ],
  });
  // The other device, asking for the plain page on its own. When the server is another site's, it holds example.com's
  // address too and serves it by the Host header, as one server hosting several sites does.
  const other = from === 'phone' ? 'laptop' : 'phone';
  const alias = opts.together && site.ip !== CAPTURED_FROM_IP ? CAPTURED_FROM_IP : undefined;
  const companion = (gateway: { ip: string; mac: string }) => ({
    ...(warm ? { arp: { [gateway.ip]: gateway.mac } } : {}),
    apps: [{ kind: 'browser' as const, url: SITES['example.com'].url, resolver: ADDR.resolver.ip, request: ascii(HTTP_REQUEST) }],
  });
  const appsOf = (device: 'laptop' | 'phone', gateway: { ip: string; mac: string }) =>
    device === from ? browser(gateway) : opts.together ? companion(gateway) : { apps: [] };
  // On a revisit the router still remembers whichever device asked last time.
  const remembered = from === 'phone' ? ADDR.phone : ADDR.laptop;
  return {
    id: 'fetch-web-page',
    title: `Fetch ${url}`,
    startDevice: from,
    ...(opts.together ? { companion: { device: other, at: COMPANION_DELAY } } : {}),
    tcp: { clientMss: opts.vpn ? Math.min(mss, 1380) : mss, serverMss: 1460 },
    devices: [
      {
        id: 'laptop',
        label: 'Laptop',
        sublabel: ADDR.laptop.ip,
        kind: 'laptop',
        layout: { x: 160, y: 470 },
        ifaces: [{ id: 'laptop.eth0', name: 'eth0', mac: ADDR.laptop.mac, ip: ADDR.laptop.ip, prefixLen: 24 }],
        routes: [
          { network: '192.168.1.0', prefixLen: 24, iface: 'laptop.eth0' },
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.homeLan.ip, iface: 'laptop.eth0' },
        ],
        ...appsOf('laptop', ADDR.homeLan),
      },
      {
        id: 'phone',
        label: 'Phone',
        sublabel: ADDR.phone.ip,
        kind: 'phone',
        layout: { x: 600, y: 700 },
        ifaces: [{ id: 'phone.wlan0', name: 'wlan0', mac: ADDR.phone.mac, ip: ADDR.phone.ip, prefixLen: 24, wifi: 'station' }],
        routes: [
          { network: '192.168.1.0', prefixLen: 24, iface: 'phone.wlan0' },
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.homeWlan.ip, iface: 'phone.wlan0' },
        ],
        ...appsOf('phone', ADDR.homeWlan),
      },
      {
        id: 'home',
        label: 'Home router',
        sublabel: 'NAT',
        kind: 'home-router',
        layout: { x: 600, y: 470 },
        ifaces: [
          { id: 'home.lan', name: 'lan', mac: ADDR.homeLan.mac, ip: ADDR.homeLan.ip, prefixLen: 24 },
          { id: 'home.wan', name: 'wan', mac: ADDR.homeWan.mac, ip: ADDR.homeWan.ip, prefixLen: 24 },
          // The built-in Wi-Fi access point. Real home routers bridge Wi-Fi and the Ethernet ports into one network
          // with one address; here that bridge is two interfaces sharing 192.168.1.1, with a route to the phone.
          { id: 'home.wlan', name: 'wlan', mac: ADDR.homeWlan.mac, ip: ADDR.homeWlan.ip, prefixLen: 24, wifi: 'ap' },
        ],
        routes: [
          { network: '192.168.1.0', prefixLen: 24, iface: 'home.lan' },
          { network: ADDR.phone.ip, prefixLen: 32, iface: 'home.wlan' },
          { network: '203.0.113.0', prefixLen: 24, iface: 'home.wan' },
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispCustomer.ip, iface: 'home.wan' },
        ],
        arp: {
          [ADDR.ispCustomer.ip]: ADDR.ispCustomer.mac,
          ...(warm ? { [remembered.ip]: remembered.mac } : {}),
          ...(warm && opts.together ? { [ADDR[other].ip]: ADDR[other].mac } : {}),
        },
        nat: { inside: ['home.lan', 'home.wlan'], outside: 'home.wan' },
        apps: [],
      },
      {
        id: 'isp',
        label: 'ISP router',
        sublabel: 'internet',
        kind: 'router',
        layout: { x: 1040, y: 470 },
        ifaces: [
          { id: 'isp.cust', name: 'cust0', mac: ADDR.ispCustomer.mac, ip: ADDR.ispCustomer.ip, prefixLen: 24 },
          { id: 'isp.p1', name: 'peer1', mac: ADDR.ispToResolver.mac, ip: ADDR.ispToResolver.ip, prefixLen: 30 },
          { id: 'isp.p2', name: 'peer2', mac: ADDR.ispToServer.mac, ip: ADDR.ispToServer.ip, prefixLen: 30 },
          { id: 'isp.p3', name: 'peer3', mac: ADDR.ispToVpn.mac, ip: ADDR.ispToVpn.ip, prefixLen: 30 },
        ],
        routes: [
          { network: '203.0.113.0', prefixLen: 24, iface: 'isp.cust' },
          { network: '1.1.1.0', prefixLen: 24, iface: 'isp.p1' },
          { network: ADDR.vpn.ip, prefixLen: 32, iface: 'isp.p3' },
          // Real Cloudflare prefixes containing example.com's addresses.
          { network: '104.16.0.0', prefixLen: 13, iface: 'isp.p2' },
          { network: '172.64.0.0', prefixLen: 13, iface: 'isp.p2' },
          // CERN's own address block, where info.cern.ch lives.
          { network: '188.184.0.0', prefixLen: 15, iface: 'isp.p2' },
          // The cloud address httpbin.org answered from.
          { network: PHOTO_IP, prefixLen: 32, iface: 'isp.p2' },
        ],
        arp: {
          [ADDR.homeWan.ip]: ADDR.homeWan.mac,
          [ADDR.resolver.ip]: ADDR.resolver.mac,
          [ADDR.vpn.ip]: ADDR.vpn.mac,
          [server.ip]: server.mac,
          ...(alias ? { [alias]: server.mac } : {}),
        },
        apps: [],
      },
      {
        id: 'vpn',
        label: 'VPN server',
        sublabel: ADDR.vpn.ip,
        kind: 'vpn-server',
        layout: { x: 1040, y: 735 },
        ifaces: [
          { id: 'vpn.eth0', name: 'eth0', mac: ADDR.vpn.mac, ip: ADDR.vpn.ip, prefixLen: 32 },
          { id: 'vpn.eth1', name: 'eth1', mac: ADDR.vpnToServer.mac, ip: ADDR.vpn.ip, prefixLen: 32 },
          { id: 'vpn.eth2', name: 'eth2', mac: ADDR.vpnToResolver.mac, ip: ADDR.vpn.ip, prefixLen: 32 },
        ],
        routes: [
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToVpn.ip, iface: 'vpn.eth0' },
          { network: server.ip, prefixLen: 32, iface: 'vpn.eth1' },
          { network: ADDR.resolver.ip, prefixLen: 32, iface: 'vpn.eth2' },
        ],
        arp: { [ADDR.ispToVpn.ip]: ADDR.ispToVpn.mac, [server.ip]: ADDR.serverFromVpn.mac, [ADDR.resolver.ip]: ADDR.resolverFromVpn.mac },
        apps: [],
      },
      {
        id: 'resolver',
        label: 'DNS resolver',
        sublabel: ADDR.resolver.ip,
        kind: 'dns-resolver',
        layout: { x: 1480, y: 205 },
        ifaces: [
          { id: 'resolver.eth0', name: 'eth0', mac: ADDR.resolver.mac, ip: ADDR.resolver.ip, prefixLen: 32 },
          { id: 'resolver.eth1', name: 'eth1', mac: ADDR.resolverFromVpn.mac, ip: ADDR.resolver.ip, prefixLen: 32 },
        ],
        routes: [
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToResolver.ip, iface: 'resolver.eth0' },
          { network: ADDR.vpn.ip, prefixLen: 32, iface: 'resolver.eth1' },
        ],
        arp: { [ADDR.ispToResolver.ip]: ADDR.ispToResolver.mac, [ADDR.vpn.ip]: ADDR.vpnToResolver.mac },
        apps: [
          {
            kind: 'dns-server',
            processing: 0.0003,
            records: {
              'example.com': { ips: [...CAPTURED_A_RECORDS], ttl: CAPTURED_DNS_TTL },
              [CERN_HOST]: { ips: [...CERN_A_RECORDS], ttl: CERN_DNS_TTL },
              [PHOTO_HOST]: { ips: [...PHOTO_A_RECORDS], ttl: PHOTO_DNS_TTL },
            },
          },
        ],
      },
      {
        id: 'server',
        label: 'Web server',
        sublabel: `${new URL(site.url).hostname} · ${server.ip}`,
        kind: 'web-server',
        layout: { x: 1480, y: 735 },
        ifaces: [
          { id: 'server.eth0', name: 'eth0', mac: server.mac, ip: server.ip, prefixLen: 32, ...(alias ? { aliases: [alias] } : {}) },
          { id: 'server.eth1', name: 'eth1', mac: ADDR.serverFromVpn.mac, ip: server.ip, prefixLen: 32 },
        ],
        routes: [
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToServer.ip, iface: 'server.eth0' },
          { network: ADDR.vpn.ip, prefixLen: 32, iface: 'server.eth1' },
        ],
        arp: { [ADDR.ispToServer.ip]: ADDR.ispToServer.mac, [ADDR.vpn.ip]: ADDR.vpnToServer.mac },
        apps: [
          {
            kind: 'http-server',
            processing: 0.0005,
            response: fromBase64(site.response),
            ...(tls ? { tls } : {}),
            ...(alias ? { responses: { 'example.com': fromBase64(HTTP_RESPONSE_BASE64) } } : {}),
          },
        ],
      },
    ],
    links: [
      { id: 'lan', a: 'laptop.eth0', b: 'home.lan', bitsPerSecond: 1e9, delay: 5e-8, label: 'Ethernet cable · 1 Gbit/s', name: 'the Ethernet cable' },
      { id: 'wlan', a: 'phone.wlan0', b: 'home.wlan', bitsPerSecond: 300e6, delay: 3e-8, label: 'Wi-Fi · 300 Mbit/s', name: 'the Wi-Fi' },
      opts.slow
        ? { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 25e6, delay: 0.28, label: 'Satellite to ISP · 25 Mbit/s · 280 ms', name: 'the satellite link' }
        : { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 1e9, delay: 0.002, label: 'Fiber to ISP · 1 Gbit/s · 2 ms', name: 'the fiber line to the ISP' },
      { id: 'bb1', a: 'isp.p1', b: 'resolver.eth0', bitsPerSecond: 1e10, delay: 0.003, label: 'Backbone · 10 Gbit/s · 3 ms', name: 'a backbone link' },
      { id: 'bb3', a: 'isp.p3', b: 'vpn.eth0', bitsPerSecond: 1e10, delay: 0.005, label: 'Backbone · 10 Gbit/s · 5 ms', name: 'a backbone link' },
      { id: 'bb2', a: 'isp.p2', b: 'server.eth0', bitsPerSecond: 1e10, delay: 0.004, label: 'Backbone · 10 Gbit/s · 4 ms', name: 'a backbone link' },
      { id: 'bb4', a: 'vpn.eth1', b: 'server.eth1', bitsPerSecond: 1e10, delay: 0.004, label: 'Backbone · 10 Gbit/s · 4 ms', name: 'a backbone link' },
      { id: 'bb5', a: 'vpn.eth2', b: 'resolver.eth1', bitsPerSecond: 1e10, delay: 0.003, label: 'Backbone · 10 Gbit/s · 3 ms', name: 'a backbone link' },
    ],
  };
}
