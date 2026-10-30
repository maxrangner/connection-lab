import { ascii, fromBase64 } from '../bytes/bytes';
import type { Scenario } from '../model';
import {
  CAPTURED_A_RECORDS,
  CAPTURED_DNS_TTL,
  CAPTURED_FROM_IP,
  HTTP_REQUEST,
  HTTP_RESPONSE_BASE64,
} from './exampleComCapture';
import { CERN_A_RECORDS, CERN_DNS_TTL, CERN_HOST, CERN_HTTP_REQUEST, CERN_HTTP_RESPONSE_BASE64, CERN_IP, CERN_PATH } from './infoCernCapture';

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
  resolver: { ip: '1.1.1.1', mac: '00:0c:29:1d:aa:01' },
  server: { ip: CAPTURED_FROM_IP, mac: '00:0c:29:7e:bb:02' },
} as const;

export interface FetchWebPageOptions {
  /** MSS the laptop advertises in its SYN. */
  mss?: number;
  /**
   * Which real page to fetch: example.com (932 bytes, one packet) or the first website ever,
   * info.cern.ch/hypertext/WWW/TheProject.html (2450 bytes, so the reply needs more than one packet).
   */
  site?: 'example.com' | 'info.cern.ch';
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
  /** Which device opens the page: the laptop on its Ethernet cable, or the phone over Wi-Fi. */
  from?: 'laptop' | 'phone';
}

/** What the scenario needs to know about each real site. */
const SITES = {
  'example.com': { url: 'http://example.com/', ip: CAPTURED_FROM_IP, request: HTTP_REQUEST, response: HTTP_RESPONSE_BASE64 },
  'info.cern.ch': { url: `http://${CERN_HOST}${CERN_PATH}`, ip: CERN_IP, request: CERN_HTTP_REQUEST, response: CERN_HTTP_RESPONSE_BASE64 },
} as const;

export function fetchWebPage(opts: FetchWebPageOptions = {}): Scenario {
  const mss = opts.mss ?? 1460;
  const site = SITES[opts.site ?? 'example.com'];
  const server = { ip: site.ip, mac: ADDR.server.mac };
  const revisit = !!opts.revisit;
  const from = opts.from ?? 'laptop';
  const browser = (gateway: { ip: string; mac: string }) => ({
    ...(revisit ? { arp: { [gateway.ip]: gateway.mac } } : {}),
    apps: [
      {
        kind: 'browser' as const,
        url: site.url,
        resolver: ADDR.resolver.ip,
        request: ascii(site.request),
        ...(revisit ? { knownAddress: site.ip } : {}),
      },
    ],
  });
  // On a revisit the router still remembers whichever device asked last time.
  const remembered = from === 'phone' ? ADDR.phone : ADDR.laptop;
  return {
    id: 'fetch-web-page',
    title: `Fetch ${site.url}`,
    startDevice: from,
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
        ...(from === 'laptop' ? browser(ADDR.homeLan) : { apps: [] }),
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
        ...(from === 'phone' ? browser(ADDR.homeWlan) : { apps: [] }),
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
        arp: { [ADDR.ispCustomer.ip]: ADDR.ispCustomer.mac, ...(revisit ? { [remembered.ip]: remembered.mac } : {}) },
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
        ],
        routes: [
          { network: '203.0.113.0', prefixLen: 24, iface: 'isp.cust' },
          { network: '1.1.1.0', prefixLen: 24, iface: 'isp.p1' },
          // Real Cloudflare prefixes containing example.com's addresses.
          { network: '104.16.0.0', prefixLen: 13, iface: 'isp.p2' },
          { network: '172.64.0.0', prefixLen: 13, iface: 'isp.p2' },
          // CERN's own address block, where info.cern.ch lives.
          { network: '188.184.0.0', prefixLen: 15, iface: 'isp.p2' },
        ],
        arp: {
          [ADDR.homeWan.ip]: ADDR.homeWan.mac,
          [ADDR.resolver.ip]: ADDR.resolver.mac,
          [server.ip]: server.mac,
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
            records: {
              'example.com': { ips: [...CAPTURED_A_RECORDS], ttl: CAPTURED_DNS_TTL },
              [CERN_HOST]: { ips: [...CERN_A_RECORDS], ttl: CERN_DNS_TTL },
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
        ifaces: [{ id: 'server.eth0', name: 'eth0', mac: server.mac, ip: server.ip, prefixLen: 32 }],
        routes: [{ network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToServer.ip, iface: 'server.eth0' }],
        arp: { [ADDR.ispToServer.ip]: ADDR.ispToServer.mac },
        apps: [{ kind: 'http-server', processing: 0.0005, response: fromBase64(site.response) }],
      },
    ],
    links: [
      { id: 'lan', a: 'laptop.eth0', b: 'home.lan', bitsPerSecond: 1e9, delay: 5e-8, label: 'Ethernet cable · 1 Gbit/s', name: 'the Ethernet cable' },
      { id: 'wlan', a: 'phone.wlan0', b: 'home.wlan', bitsPerSecond: 300e6, delay: 3e-8, label: 'Wi-Fi · 300 Mbit/s', name: 'the Wi-Fi' },
      opts.slow
        ? { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 25e6, delay: 0.28, label: 'Satellite to ISP · 25 Mbit/s · 280 ms', name: 'the satellite link' }
        : { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 1e9, delay: 0.002, label: 'Fiber to ISP · 1 Gbit/s · 2 ms', name: 'the fiber line to the ISP' },
      { id: 'bb1', a: 'isp.p1', b: 'resolver.eth0', bitsPerSecond: 1e10, delay: 0.003, label: 'Backbone · 10 Gbit/s · 3 ms', name: 'a backbone link' },
      { id: 'bb2', a: 'isp.p2', b: 'server.eth0', bitsPerSecond: 1e10, delay: 0.004, label: 'Backbone · 10 Gbit/s · 4 ms', name: 'a backbone link' },
    ],
  };
}
