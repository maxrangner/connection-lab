import { ascii, fromBase64 } from '../bytes/bytes';
import type { Scenario } from '../model';
import {
  CAPTURED_A_RECORDS,
  CAPTURED_DNS_TTL,
  CAPTURED_FROM_IP,
  HTTP_REQUEST,
  HTTP_RESPONSE_BASE64,
} from './exampleComCapture';

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
  homeLan: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:01' },
  homeWan: { ip: '203.0.113.7', mac: 'a4:91:b1:7d:02:02' },
  ispCustomer: { ip: '203.0.113.1', mac: '00:1b:21:3a:4c:01' },
  ispToResolver: { ip: '198.51.100.1', mac: '00:1b:21:3a:4c:02' },
  ispToServer: { ip: '198.51.100.5', mac: '00:1b:21:3a:4c:03' },
  resolver: { ip: '1.1.1.1', mac: '00:0c:29:1d:aa:01' },
  server: { ip: CAPTURED_FROM_IP, mac: '00:0c:29:7e:bb:02' },
} as const;

export interface FetchWebPageOptions {
  /** MSS the laptop advertises in its SYN. */
  mss?: number;
}

export function fetchWebPage(opts: FetchWebPageOptions = {}): Scenario {
  const mss = opts.mss ?? 1460;
  return {
    id: 'fetch-web-page',
    title: 'Fetch http://example.com/',
    startDevice: 'laptop',
    tcp: { clientMss: mss, serverMss: 1460 },
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
        apps: [
          { kind: 'browser', url: 'http://example.com/', resolver: ADDR.resolver.ip, request: ascii(HTTP_REQUEST) },
        ],
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
        ],
        routes: [
          { network: '192.168.1.0', prefixLen: 24, iface: 'home.lan' },
          { network: '203.0.113.0', prefixLen: 24, iface: 'home.wan' },
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispCustomer.ip, iface: 'home.wan' },
        ],
        arp: { [ADDR.ispCustomer.ip]: ADDR.ispCustomer.mac },
        nat: { inside: 'home.lan', outside: 'home.wan' },
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
        ],
        routes: [
          { network: '203.0.113.0', prefixLen: 24, iface: 'isp.cust' },
          { network: '1.1.1.0', prefixLen: 24, iface: 'isp.p1' },
          // Real Cloudflare prefixes containing example.com's addresses.
          { network: '104.16.0.0', prefixLen: 13, iface: 'isp.p2' },
          { network: '172.64.0.0', prefixLen: 13, iface: 'isp.p2' },
        ],
        arp: {
          [ADDR.homeWan.ip]: ADDR.homeWan.mac,
          [ADDR.resolver.ip]: ADDR.resolver.mac,
          [ADDR.server.ip]: ADDR.server.mac,
        },
        apps: [],
      },
      {
        id: 'resolver',
        label: 'DNS resolver',
        sublabel: ADDR.resolver.ip,
        kind: 'dns-resolver',
        layout: { x: 1480, y: 205 },
        ifaces: [{ id: 'resolver.eth0', name: 'eth0', mac: ADDR.resolver.mac, ip: ADDR.resolver.ip, prefixLen: 32 }],
        routes: [{ network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToResolver.ip, iface: 'resolver.eth0' }],
        arp: { [ADDR.ispToResolver.ip]: ADDR.ispToResolver.mac },
        apps: [
          {
            kind: 'dns-server',
            processing: 0.0003,
            records: { 'example.com': { ips: [...CAPTURED_A_RECORDS], ttl: CAPTURED_DNS_TTL } },
          },
        ],
      },
      {
        id: 'server',
        label: 'Web server',
        sublabel: `example.com · ${ADDR.server.ip}`,
        kind: 'web-server',
        layout: { x: 1480, y: 735 },
        ifaces: [{ id: 'server.eth0', name: 'eth0', mac: ADDR.server.mac, ip: ADDR.server.ip, prefixLen: 32 }],
        routes: [{ network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToServer.ip, iface: 'server.eth0' }],
        arp: { [ADDR.ispToServer.ip]: ADDR.ispToServer.mac },
        apps: [{ kind: 'http-server', processing: 0.0005, response: fromBase64(HTTP_RESPONSE_BASE64) }],
      },
    ],
    links: [
      { id: 'lan', a: 'laptop.eth0', b: 'home.lan', bitsPerSecond: 1e9, delay: 5e-8, label: 'Ethernet cable · 1 Gbit/s', name: 'the Ethernet cable' },
      { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 1e9, delay: 0.002, label: 'Fiber to ISP · 1 Gbit/s · 2 ms', name: 'the fiber line to the ISP' },
      { id: 'bb1', a: 'isp.p1', b: 'resolver.eth0', bitsPerSecond: 1e10, delay: 0.003, label: 'Backbone · 10 Gbit/s · 3 ms', name: 'a backbone link' },
      { id: 'bb2', a: 'isp.p2', b: 'server.eth0', bitsPerSecond: 1e10, delay: 0.004, label: 'Backbone · 10 Gbit/s · 4 ms', name: 'a backbone link' },
    ],
  };
}
