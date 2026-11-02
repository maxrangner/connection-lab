import { inSubnet } from '../bytes/addr';
import { ascii, fromBase64 } from '../bytes/bytes';
import type { Action, AppSpec, DeviceKind, DeviceSpec, IfaceSpec, Job, LinkSpec, RouteSpec, Scenario } from '../model';
import { dnsAddresses, parseDns } from '../proto/dns';
import { DNS_TRACES } from './dnsTraceCapture';
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
import type { MqttQos } from '../proto/mqtt';
import { RTP_PORT } from '../proto/rtp';
import { VOICE_CLIP_CALLER_BASE64, VOICE_CLIP_FRIEND_BASE64 } from './voiceClip';

/**
 * Addresses used by the "fetch a web page" scenario.
 * - The LAN uses the private range 192.168.1.0/24 (RFC 1918), as most home routers do.
 * - The home router's public address is from 203.0.113.0/24, a documentation range (RFC 5737) standing in for
 *   whatever address your ISP gives you. The ISP's backbone links use 198.51.100.0/24, also documentation.
 * - 1.1.1.1 (Cloudflare's public resolver) and example.com's addresses are real.
 * - The root, TLD and authoritative name servers have the real addresses the captured walk used (dnsTraceCapture.ts).
 *   The resolver's own ends of the cables to them are from 198.51.100.0/24 (documentation range), like the ISP's.
 * - The friend's phone, on the far side of the internet, has 198.51.100.42: a public address from the same RFC 5737
 *   documentation block (TEST-NET-2), standing in for whatever its own provider gave it. Its name, sam.example, is in
 *   .example, the top-level domain RFC 2606 reserves for exactly this kind of use; the A record is invented.
 * - MACs: the first three bytes (OUI) identify a vendor; these are plausible but made up.
 */
export const ADDR = {
  laptop: { ip: '192.168.1.23', mac: '3c:22:fb:5a:10:e4' },
  phone: { ip: '192.168.1.42', mac: 'f0:5c:77:3e:91:2a' },
  sensor: { ip: '192.168.1.60', mac: '84:f3:eb:2c:41:9e' },
  localBroker: { ip: '192.168.1.2', mac: 'dc:a6:32:5e:7b:10' },
  homeLan: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:01' },
  homeWlan: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:03' },
  homeSensor: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:04' },
  homeBroker: { ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:05' },
  homeWan: { ip: '203.0.113.7', mac: 'a4:91:b1:7d:02:02' },
  ispCustomer: { ip: '203.0.113.1', mac: '00:1b:21:3a:4c:01' },
  ispToResolver: { ip: '198.51.100.1', mac: '00:1b:21:3a:4c:02' },
  ispToServer: { ip: '198.51.100.5', mac: '00:1b:21:3a:4c:03' },
  ispToVpn: { ip: '198.51.100.9', mac: '00:1b:21:3a:4c:04' },
  ispToFriend: { ip: '198.51.100.13', mac: '00:1b:21:3a:4c:05' },
  friend: { ip: '198.51.100.42', mac: '8c:f5:a3:1e:77:0b', name: 'sam.example', ttl: 300 },
  vpn: { ip: '198.51.100.10', mac: '00:0c:29:5a:cc:03', tunnelIp: '10.8.0.2' },
  vpnToServer: { mac: '00:0c:29:5a:cc:04' },
  vpnToResolver: { mac: '00:0c:29:5a:cc:05' },
  resolver: { ip: '1.1.1.1', mac: '00:0c:29:1d:aa:01' },
  resolverFromVpn: { mac: '00:0c:29:1d:aa:02' },
  resolverUp: [
    { ip: '198.51.100.17', mac: '00:0c:29:1d:aa:03' },
    { ip: '198.51.100.21', mac: '00:0c:29:1d:aa:04' },
    { ip: '198.51.100.25', mac: '00:0c:29:1d:aa:05' },
  ],
  nameServers: [{ mac: '00:50:56:9a:00:01' }, { mac: '00:50:56:9a:00:02' }, { mac: '00:50:56:9a:00:03' }],
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
   * On a revisit, the address the first visit found. It can be another of the site's addresses than the one this run's
   * lookup would give (a cold walk ends where it ends), and a device goes back to what it remembers. This run's if left out.
   */
  knownIp?: string;
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
  /** Your own devices on the table: `HOME_DEVICES` unless told. */
  home?: HomeDevice[];
  /** Which of them opens the page: by default the first, the laptop on its Ethernet cable. The phone goes over Wi-Fi. */
  from?: string;
  /**
   * Jobs on other devices as well, each from its `at` seconds on (added during the run): with no VPN and nothing
   * remembered, so the home router has several conversations to tell apart at once.
   */
  joins?: Join[];
  /**
   * The device starts with no address at all (0.0.0.0, no routes, no resolver) and gets everything from the home
   * router by DHCP first: DISCOVER, OFFER, REQUEST, ACK. The lease hands out the same addresses the scenario uses.
   */
  dhcp?: boolean;
  /**
   * A cold resolver: it has nothing cached for the site, so it really walks the hierarchy with the captured bytes of a real
   * walk: it asks a root server, is referred to the TLD's servers, asks one, is referred to the site's own, asks one, caches
   * the answer and only then answers the device. Off, the three servers stand idle and nothing changes.
   */
  cold?: boolean;
  /** One-way delay of the fibre to the ISP in seconds, when the viewer has stretched it; 2 ms (about 400 km) by default. */
  wanDelay?: number;
  /**
   * A voice call instead of a page: the device looks up the friend's name (sam.example) and streams one second of
   * voice to the friend's phone as RTP over UDP, a 20 ms packet at a time; the friend talks back the same way. Nothing
   * lost is ever sent again. No page is fetched; `joins` still run on the other devices.
   */
  call?: boolean;
  /**
   * A thin pipe: the line to the ISP is a typical DSL line, 20 Mbit/s, instead of the 1 Gbit/s fibre, and the ISP's port
   * onto it has a small transmit buffer (`THIN_QUEUE` frames). The server's burst arrives over the 10 Gbit/s backbone far
   * faster than the line drains it, so frames queue at the port, and when the buffer is full the tail is dropped: the
   * first natural packet loss, with no cable cut. With `slow` the satellite line stays as it is: `slow` wins.
   */
  thin?: boolean;
  /**
   * Instead of fetching the page, the device pings the site (`ping -c 4`: four echo requests a second apart, each
   * answered by the web server) or traces the path to it (`traceroute -m 8`: UDP probes with TTL 1, 2, 3 …, three per
   * hop; the home router, the ISP router and finally the server itself answer). The name is looked up first, as always.
   */
  probe?: 'ping' | 'traceroute';
  /**
   * Noisy Wi-Fi: the chance (0..1) that any one frame on the air between the phone and the home router is lost to
   * interference, data frames and Acks alike. With it the Wi-Fi is a real 802.11 radio: every unicast frame is answered by
   * a 14-byte Ack after SIFS, and a frame with no Ack within the Ack timeout goes again with the Retry bit, up to 7 times,
   * without TCP or DNS ever knowing. Only the phone is on Wi-Fi, so it only shows with `from: 'phone'` (or a job added on it).
   * Off (0, the default) the Wi-Fi is a perfect cable through the air and no Acks are sent.
   */
  noise?: number;
  /** Attackers on the table. See `Attack`. */
  attacks?: Attack[];
  /** A smart home: a sensor on the Wi-Fi, and an MQTT broker on your home network that it and your apps connect to. */
  smart?: boolean;
  /** The broker is out on the internet instead: reachable from anywhere, and everything goes out through the NAT and back. */
  cloud?: boolean;
  /**
   * Instead of a job on the laptop or phone, the sensor takes a reading (with `smart`, which this turns on). Everyone has
   * been connected for a while by then, as in any home: that part really runs, before `READING_AT`, and is not told.
   */
  reading?: boolean;
  /** How sure a reading is of arriving. See `MqttQos`. */
  qos?: MqttQos;
}

/**
 * Frames the ISP's port onto the DSL line can hold while one is on the wire. Deliberately small so the lesson shows within
 * one photo: real home routers and DSLAMs often buffer hundreds of frames, which hides the loss but lets the queueing delay
 * grow to hundreds of milliseconds (bufferbloat). An honest knob, not a typical value. Why 8 and not more: TCP's first burst
 * is Linux's initial window of 10 packets, so 9 wait behind the first and the tenth finds 8 ahead of it; after that the ACK
 * clock lets packets in two at a time while the line drains one, so the buffer never holds more than 8 again. A buffer of 9
 * or more never overflows for a 25-packet photo, and the lesson would not show.
 */
export const THIN_QUEUE = 8;
/** The DSL line's rate in bits per second. */
export const THIN_BPS = 20e6;

/**
 * What a red card puts on the table.
 * - `listen`: a stranger with a radio by the open Wi-Fi. It only hears; nothing it does can be noticed.
 * - `flood`: a botnet sending junk at the web server until the port onto the server's line is full.
 * - `scan`: a scanner trying the server's ports one after another.
 */
export type Attack = 'listen' | 'flood' | 'scan';

/**
 * The bots, and the junk each one sends: 36 packets of 1400 bytes, 60 ms apart, one bot just after the other. A flood is
 * in full swing by the time anyone notices, so each opens with a burst that fills the port before the page gets there.
 */
const BOTS = 3;
const FLOOD = { packets: 36, burst: 4, gap: 0.06, bytes: 1400, stagger: 0.02 };
/**
 * The server's line while it is under attack. An honest knob, like `THIN_QUEUE`: a real server's line is far faster and a
 * real flood far bigger, by thousands of times in both, and only the ratio matters: the bots send twice what the line
 * can carry. At this scale every packet is one that can be drawn.
 */
const FLOODED_LINE_BPS = 280e3;
/** Ports a scan tries, and those the server has open besides its web server: the usual doors anyone knocks on. */
const SCAN = { ports: [21, 22, 23, 25, 80, 443, 3306, 8080], open: [22, 443], gap: 0.01 };

export type { Action, Job };

/** When a reading is taken, in seconds: long after the sensor and the apps are connected, even over a satellite. */
export const READING_AT = 20;
/** One-way seconds on the line out of the house, as long as nobody has stretched it. */
export const WAN_DELAY = 0.002;
/**
 * A line that is cut as a reading is taken has been out for a while: from here. Long enough before it for keep-alive to find
 * out on both sides, so a device on that line is properly gone by then, and not just late.
 */
export const OFFLINE_AT = 10;
const BROKER_NAME = 'broker.example';
const TEMPERATURE_TOPIC = 'home/livingroom/temperature';

/** The real address blocks the web server's addresses are part of: Cloudflare's, with example.com, and CERN's own. */
const SERVER_BLOCKS = [
  { network: '104.16.0.0', prefixLen: 13 },
  { network: '172.64.0.0', prefixLen: 13 },
  { network: '188.184.0.0', prefixLen: 15 },
];

/** How long after the first device another one starts unless told, in seconds: close enough that their packets interleave. */
export const COMPANION_DELAY = 0.004;

/** A job added on another device: on the first one with nothing to do and a plain page a moment later, unless told. */
export interface Join {
  device?: string;
  job?: Job;
  at?: number;
}

/**
 * A device of your own on the home network: how it connects and what it can do. An entry here, a place in `timeline.ts#POS`
 * and a shape in `NetworkScene#buildDevice` put another one on the table.
 */
export interface HomeDevice {
  id: string;
  label: string;
  kind: DeviceKind;
  ip: string;
  mac: string;
  iface: Pick<IfaceSpec, 'name' | 'wifi'>;
  /** The home router's end of its link. The first device's port holds the home network's route. */
  port: Pick<IfaceSpec, 'id' | 'name' | 'ip' | 'mac' | 'wifi'>;
  link: Pick<LinkSpec, 'id' | 'bitsPerSecond' | 'delay'>;
  actions: Action[];
  /** Its colour, once several devices' packets are on the table at once. */
  color: string;
}

export const EVERY_JOB: Job[] = ['page', 'photo', 'call', 'ping', 'trace'];

export const HOME_DEVICES: HomeDevice[] = [
  {
    id: 'laptop',
    label: 'Laptop',
    kind: 'laptop',
    ...ADDR.laptop,
    iface: { name: 'eth0' },
    port: { id: 'home.lan', name: 'lan', ...ADDR.homeLan },
    link: { id: 'lan', bitsPerSecond: 1e9, delay: 5e-8 },
    actions: EVERY_JOB,
    color: '#4f9d69',
  },
  {
    id: 'phone',
    label: 'Phone',
    kind: 'phone',
    ...ADDR.phone,
    iface: { name: 'wlan0', wifi: 'station' },
    // The built-in Wi-Fi access point. Real home routers bridge Wi-Fi and the Ethernet ports into one network
    // with one address; here that bridge is two interfaces sharing 192.168.1.1, with a route to the phone.
    port: { id: 'home.wlan', name: 'wlan', ...ADDR.homeWlan, wifi: 'ap' },
    link: { id: 'wlan', bitsPerSecond: 300e6, delay: 3e-8 },
    actions: EVERY_JOB,
    color: '#d6488f',
  },
];

/** In a smart home, the sensor. A real one speaks to the router on its own at 2.4 GHz, at a far lower rate than the phone. */
const SENSOR: HomeDevice = {
  id: 'sensor',
  label: 'Sensor',
  kind: 'sensor',
  ...ADDR.sensor,
  iface: { name: 'wlan0', wifi: 'station' },
  port: { id: 'home.wlan2', name: 'wlan2', ...ADDR.homeSensor, wifi: 'ap' },
  link: { id: 'wlan2', bitsPerSecond: 72e6, delay: 3e-8 },
  actions: ['reading'],
  color: '#c98a1b',
};

/** A broker at home, as on a small computer in a cupboard, on a cable of its own into the router. */
const LOCAL_BROKER: HomeDevice = {
  id: 'local-broker',
  label: 'MQTT broker',
  kind: 'mqtt-broker',
  ...ADDR.localBroker,
  iface: { name: 'eth0' },
  port: { id: 'home.lan2', name: 'lan2', ...ADDR.homeBroker },
  link: { id: 'lan2', bitsPerSecond: 1e9, delay: 5e-8 },
  actions: [],
  color: '#7a8a99',
};

/** What the scenario needs to know about each real site. */
const SITES = {
  'example.com': { url: 'http://example.com/', ip: CAPTURED_FROM_IP, request: HTTP_REQUEST, response: HTTP_RESPONSE_BASE64, tls: tlsExample },
  'info.cern.ch': { url: `http://${CERN_HOST}${CERN_PATH}`, ip: CERN_IP, request: CERN_HTTP_REQUEST, response: CERN_HTTP_RESPONSE_BASE64, tls: tlsCern },
  'httpbin.org': { url: `http://${PHOTO_HOST}${PHOTO_PATH}`, ip: PHOTO_IP, request: PHOTO_HTTP_REQUEST, response: PHOTO_HTTP_RESPONSE_BASE64, tls: tlsPhoto },
} as const;

/**
 * The real walk root → TLD → authoritative for a site, as three devices behind the resolver, each with its real address and
 * its captured reply, on a cable whose delay is half the round-trip time measured to it. They stand there in every run.
 */
function nameServers(host: string): { devices: DeviceSpec[]; links: LinkSpec[]; routes: RouteSpec[]; arp: Record<string, string>; answer: string | undefined } {
  const hops = DNS_TRACES[host]?.hops ?? [];
  // The classic three hops; a longer walk would still end at its last server.
  const picked = [hops[0], hops[1], hops[hops.length - 1]];
  const kinds = ['root-server', 'tld-server', 'auth-server'] as const;
  const ids = ['root', 'tld', 'auth'];
  const labels = ['Root server', `.${host.split('.').pop()} server`, 'Name server'];
  const devices: DeviceSpec[] = [];
  const links: LinkSpec[] = [];
  const routes: RouteSpec[] = [];
  const arp: Record<string, string> = {};
  picked.forEach((hop, i) => {
    if (!hop) return;
    const up = ADDR.resolverUp[i]!;
    const mac = ADDR.nameServers[i]!.mac;
    const delay = hop.rttMs / 2000;
    devices.push({
      id: ids[i]!,
      label: labels[i]!,
      kind: kinds[i]!,
      ifaces: [{ id: `${ids[i]}.eth0`, name: 'eth0', mac, ip: hop.server.ip }],
      routes: [{ network: '0.0.0.0', prefixLen: 0, via: up.ip, iface: `${ids[i]}.eth0` }],
      arp: { [up.ip]: up.mac },
      apps: [{ kind: 'dns-authority', processing: 0.0002, answers: [{ name: host, response: fromBase64(hop.response) }] }],
    });
    links.push({ id: `up${i + 1}`, a: `resolver.up${i + 1}`, b: `${ids[i]}.eth0`, bitsPerSecond: 1e10, delay });
    routes.push({ network: hop.server.ip, prefixLen: 32, iface: `resolver.up${i + 1}` });
    arp[hop.server.ip] = mac;
  });
  const last = hops[hops.length - 1];
  return { devices, links, routes, arp, answer: last && dnsAddresses(parseDns(fromBase64(last.response), 0))[0] };
}

/** A device on the far side of the internet, on its own cable into the ISP router, and what the ISP needs to reach it. */
function outsider(n: number, id: string, label: string, kind: 'bot' | 'scanner' | 'mqtt-broker', apps: AppSpec[]): { device: DeviceSpec; link: LinkSpec; port: IfaceSpec; route: RouteSpec; arp: [string, string] } {
  // Public addresses from the documentation block the ISP's own links use.
  const ip = `198.51.100.${100 + n}`;
  const mac = `02:66:00:00:00:${n.toString(16).padStart(2, '0')}`;
  const gateway = { ip: `198.51.100.${200 + n}`, mac: `00:1b:21:3a:4d:${n.toString(16).padStart(2, '0')}` };
  return {
    device: {
      id,
      label,
      kind,
      ifaces: [{ id: `${id}.eth0`, name: 'eth0', mac, ip }],
      routes: [{ network: '0.0.0.0', prefixLen: 0, via: gateway.ip, iface: `${id}.eth0` }],
      arp: { [gateway.ip]: gateway.mac },
      apps,
    },
    link: { id: `${id}-link`, a: `isp.${id}`, b: `${id}.eth0`, bitsPerSecond: 1e9, delay: 0.005 },
    port: { id: `isp.${id}`, name: id, mac: gateway.mac, ip: gateway.ip },
    route: { network: ip, prefixLen: 32, iface: `isp.${id}` },
    arp: [ip, mac],
  };
}

export function fetchWebPage(opts: FetchWebPageOptions = {}): Scenario {
  const mss = opts.mss ?? 1460;
  const site = SITES[opts.site ?? 'example.com'];
  const host = new URL(site.url).hostname;
  const upstream = nameServers(host);
  const cold = !!opts.cold && !!upstream.answer;
  // Cold, the site's address is whatever its own name server answered on the day of the walk.
  const server = { ip: cold ? upstream.answer! : site.ip, mac: ADDR.server.mac };
  // The one server holds every address its sites can resolve to, so whichever one a device has, it gets there.
  const aliases = [...new Set(Object.values(SITES).flatMap((s) => [s.ip, nameServers(new URL(s.url).hostname).answer ?? s.ip]))].filter((ip) => ip !== server.ip);
  const revisit = !!opts.revisit;
  const knownIp = revisit && !opts.call ? opts.knownIp : undefined;
  const tls = opts.https ? { host: site.tls.TLS_HOST, flights: site.tls.TLS_FLIGHTS, secrets: site.tls.TLS_SECRETS } : undefined;
  const url = opts.https ? site.url.replace(/^http:/, 'https:') : site.url;
  const warm = revisit || !!opts.warmArp;
  const reading = !!opts.reading;
  const smart = reading || !!opts.smart;
  const cloud = smart && !!opts.cloud;
  const homes = opts.home ?? (smart ? [...HOME_DEVICES, SENSOR, ...(cloud ? [] : [LOCAL_BROKER])] : HOME_DEVICES);
  const from = opts.from ?? (reading ? SENSOR.id : homes[0]!.id);
  const idle = homes.filter((d) => EVERY_JOB.some((j) => d.actions.includes(j))).map((d) => d.id).filter((id) => id !== from && !opts.joins?.some((j) => j.device === id));
  const joins = (opts.joins ?? []).map((j) => {
    const device = j.device ?? idle.shift();
    if (!homes.some((d) => d.id === device) || device === from) throw new Error(`No free device for this job: ${device}`);
    return { device: device!, job: j.job ?? 'page', at: j.at ?? COMPANION_DELAY };
  });
  if (new Set(joins.map((j) => j.device)).size < joins.length) throw new Error('A device runs one added job at a time');
  const dhcp = !!opts.dhcp;
  const browser = (gateway: { ip: string; mac: string }) => ({
    ...(opts.vpn ? { tunnel: { ip: ADDR.vpn.tunnelIp, server: ADDR.vpn.ip } } : {}),
    ...(warm ? { arp: { [gateway.ip]: gateway.mac } } : {}),
    apps: [
      // With DHCP the device asks for an address first, and the browser's (or the call's) resolver comes from the lease.
      ...(dhcp ? [{ kind: 'dhcp-client' as const, hostName: from }] : []),
      opts.call
        ? {
            kind: 'voice-call' as const,
            to: ADDR.friend.name,
            ...(dhcp ? {} : { resolver: ADDR.resolver.ip }),
            clip: fromBase64(VOICE_CLIP_CALLER_BASE64),
            ...(revisit ? { knownAddress: ADDR.friend.ip } : {}),
          }
        : opts.probe === 'ping'
          ? { kind: 'ping' as const, to: host, ...(dhcp ? {} : { resolver: ADDR.resolver.ip }), count: 4 }
          : opts.probe === 'traceroute'
            ? { kind: 'traceroute' as const, to: host, ...(dhcp ? {} : { resolver: ADDR.resolver.ip }), maxHops: 8 }
            : {
            kind: 'browser' as const,
            url,
            ...(dhcp ? {} : { resolver: ADDR.resolver.ip }),
            request: ascii(opts.https ? site.tls.TLS_REQUEST : site.request),
            ...(revisit ? { knownAddress: knownIp ?? server.ip } : {}),
            ...(tls ? { tls } : {}),
          },
    ],
  });
  // The jobs on other devices, each on its own. The one server holds the addresses of the sites a card can ask for and
  // serves each by the Host header, as one server hosting several sites does.
  const attacks = new Set(opts.attacks);
  const bots = attacks.has('flood')
    ? Array.from({ length: BOTS }, (_, i) => outsider(i + 1, `bot${i + 1}`, `Bot ${i + 1}`, 'bot', [{ kind: 'flood', to: server.ip, port: 80, packets: FLOOD.packets, burst: FLOOD.burst, gap: FLOOD.gap, bytes: FLOOD.bytes }]))
    : [];
  const scanner = attacks.has('scan') ? [outsider(BOTS + 1, 'scanner', 'Scanner', 'scanner', [{ kind: 'port-scan', to: server.ip, ports: SCAN.ports, gap: SCAN.gap }])] : [];
  const brokerApp = { kind: 'mqtt-broker' as const, processing: 0.0003, watchUntil: READING_AT };
  const broker = cloud ? [outsider(BOTS + 2, 'broker', 'MQTT broker', 'mqtt-broker', [brokerApp])] : [];
  const outsiders = [...bots, ...scanner, ...broker];
  const resolver = ADDR.resolver.ip;
  const jobs: Record<Job, () => AppSpec> = {
    page: () => ({ kind: 'browser', url: SITES['example.com'].url, resolver, request: ascii(HTTP_REQUEST) }),
    photo: () => ({ kind: 'browser', url: SITES['httpbin.org'].url, resolver, request: ascii(PHOTO_HTTP_REQUEST) }),
    call: () => ({ kind: 'voice-call', to: ADDR.friend.name, resolver, clip: fromBase64(VOICE_CLIP_CALLER_BASE64) }),
    ping: () => ({ kind: 'ping', to: 'example.com', resolver, count: 4 }),
    trace: () => ({ kind: 'traceroute', to: 'example.com', resolver, maxHops: 8 }),
  };
  const joined = (job: Job, gateway: { ip: string; mac: string }) => ({
    ...(warm ? { arp: { [gateway.ip]: gateway.mac } } : {}),
    apps: [jobs[job]()],
  });
  const appsOf = (d: HomeDevice) => {
    if (d.kind === 'mqtt-broker') return { apps: [brokerApp] };
    const client = { kind: 'mqtt-client' as const, clientId: d.id, broker: cloud ? BROKER_NAME : LOCAL_BROKER.ip, resolver, qos: opts.qos ?? 0, watchUntil: READING_AT };
    if (reading) return { apps: [d.id === from ? { ...client, publish: { topic: TEMPERATURE_TOPIC, at: READING_AT } } : { ...client, subscribe: TEMPERATURE_TOPIC }] };
    const join = joins.find((j) => j.device === d.id);
    return d.id === from ? browser(d.port) : join ? joined(join.job, d.port) : { apps: [] };
  };
  const ifaceOf = (d: HomeDevice): string => `${d.id}.${d.iface.name}`;
  // The device that gets its address by DHCP starts with none: no address, no routes.
  const addressed = (d: HomeDevice) =>
    dhcp && from === d.id
      ? { ip: '0.0.0.0', routes: [] }
      : {
          ip: d.ip,
          routes: [
            { network: '192.168.1.0', prefixLen: 24, iface: ifaceOf(d) },
            { network: '0.0.0.0', prefixLen: 0, via: d.port.ip, iface: ifaceOf(d) },
          ],
        };
  const homeDevice = (d: HomeDevice): DeviceSpec => {
    const { ip, routes } = addressed(d);
    return {
      id: d.id,
      label: d.label,
      kind: d.kind,
      actions: d.actions,
      color: d.color,
      ifaces: [{ id: ifaceOf(d), name: d.iface.name, mac: d.mac, ip, ...(d.iface.wifi ? { wifi: d.iface.wifi } : {}) }],
      routes,
      ...appsOf(d),
    };
  };
  const macsOf = (ids: string[]) => Object.fromEntries(homes.filter((d) => ids.includes(d.id)).map((d) => [d.ip, d.mac]));
  return {
    startDevice: from,
    ...(joins.length ? { companions: joins.map(({ device, at }) => ({ device, at })) } : {}),
    // Your apps are jobs of their own, already connected by the time anything is told.
    ...(reading ? { quietUntil: READING_AT, companions: homes.filter((d) => d.id !== from && d.actions.length).map((d) => ({ device: d.id, at: 0 })) } : {}),
    ...(bots.length || scanner.length ? { attackers: [...bots.map((b, i) => ({ device: b.device.id, at: (reading ? READING_AT : 0) + i * FLOOD.stagger })), ...scanner.map((s) => ({ device: s.device.id, at: reading ? READING_AT : 0 }))] } : {}),
    tcp: { clientMss: mss, ...(opts.vpn ? { tunnelMss: Math.min(mss, 1380) } : {}), serverMss: 1460 },
    devices: [
      ...homes.map(homeDevice),
      {
        id: 'home',
        label: 'Home router',
        kind: 'home-router',
        ifaces: [
          ...homes.map((d) => d.port),
          { id: 'home.wan', name: 'wan', mac: ADDR.homeWan.mac, ip: ADDR.homeWan.ip },
        ],
        routes: [
          { network: '192.168.1.0', prefixLen: 24, iface: homes[0]!.port.id },
          ...homes.slice(1).map((d) => ({ network: d.ip, prefixLen: 32, iface: d.port.id })),
          { network: '203.0.113.0', prefixLen: 24, iface: 'home.wan' },
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispCustomer.ip, iface: 'home.wan' },
        ],
        arp: {
          [ADDR.ispCustomer.ip]: ADDR.ispCustomer.mac,
          // On a revisit the router still remembers whichever device asked last time.
          ...(warm ? macsOf([from, ...joins.map((j) => j.device)]) : {}),
        },
        nat: { inside: homes.map((d) => d.port.id), outside: 'home.wan' },
        // With a broker at home, traffic stays inside: the router is simply the switch between its ports.
        ...(smart && !cloud ? { bridge: Object.fromEntries(homes.map((d) => [d.mac, d.port.id])) } : {}),
        // The router's DHCP server is always there; a device only asks it when it starts without an address. Each
        // device gets the address the scenario knows it by, so "where does 192.168.1.23 come from?" has one answer.
        dhcp: {
          ifaces: homes.map((d) => d.port.id),
          leases: Object.fromEntries(homes.map((d) => [d.mac, d.ip])),
          mask: '255.255.255.0',
          router: ADDR.homeLan.ip,
          dns: [ADDR.resolver.ip],
          lease: 86400,
          processing: 0.001,
        },
        apps: [],
      },
      {
        id: 'isp',
        label: "Internet provider's router",
        kind: 'router',
        ifaces: [
          { id: 'isp.cust', name: 'cust0', mac: ADDR.ispCustomer.mac, ip: ADDR.ispCustomer.ip },
          { id: 'isp.p1', name: 'peer1', mac: ADDR.ispToResolver.mac, ip: ADDR.ispToResolver.ip },
          { id: 'isp.p2', name: 'peer2', mac: ADDR.ispToServer.mac, ip: ADDR.ispToServer.ip },
          { id: 'isp.p3', name: 'peer3', mac: ADDR.ispToVpn.mac, ip: ADDR.ispToVpn.ip },
          { id: 'isp.p4', name: 'peer4', mac: ADDR.ispToFriend.mac, ip: ADDR.ispToFriend.ip },
          ...outsiders.map((o) => o.port),
        ],
        routes: [
          { network: '203.0.113.0', prefixLen: 24, iface: 'isp.cust' },
          { network: '1.1.1.0', prefixLen: 24, iface: 'isp.p1' },
          { network: ADDR.vpn.ip, prefixLen: 32, iface: 'isp.p3' },
          { network: ADDR.friend.ip, prefixLen: 32, iface: 'isp.p4' },
          ...outsiders.map((o) => o.route),
          ...SERVER_BLOCKS.map((b) => ({ ...b, iface: 'isp.p2' })),
          // Whatever else the server answers to: the cloud addresses httpbin.org answered from, the address a walk ended at.
          ...[server.ip, ...aliases].filter((ip) => !SERVER_BLOCKS.some((b) => inSubnet(ip, b.network, b.prefixLen))).map((ip) => ({ network: ip, prefixLen: 32, iface: 'isp.p2' })),
        ],
        arp: {
          [ADDR.homeWan.ip]: ADDR.homeWan.mac,
          [ADDR.resolver.ip]: ADDR.resolver.mac,
          [ADDR.vpn.ip]: ADDR.vpn.mac,
          [ADDR.friend.ip]: ADDR.friend.mac,
          [server.ip]: server.mac,
          ...Object.fromEntries(aliases.map((ip) => [ip, server.mac])),
          ...Object.fromEntries(outsiders.map((o) => o.arp)),
        },
        apps: [],
      },
      {
        id: 'vpn',
        label: 'VPN server',
        kind: 'vpn-server',
        ifaces: [
          { id: 'vpn.eth0', name: 'eth0', mac: ADDR.vpn.mac, ip: ADDR.vpn.ip },
          { id: 'vpn.eth1', name: 'eth1', mac: ADDR.vpnToServer.mac, ip: ADDR.vpn.ip },
          { id: 'vpn.eth2', name: 'eth2', mac: ADDR.vpnToResolver.mac, ip: ADDR.vpn.ip },
        ],
        routes: [
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToVpn.ip, iface: 'vpn.eth0' },
          ...[server.ip, ...aliases].map((ip) => ({ network: ip, prefixLen: 32, iface: 'vpn.eth1' })),
          { network: ADDR.resolver.ip, prefixLen: 32, iface: 'vpn.eth2' },
        ],
        arp: { [ADDR.ispToVpn.ip]: ADDR.ispToVpn.mac, ...Object.fromEntries([server.ip, ...aliases].map((ip) => [ip, ADDR.serverFromVpn.mac])), [ADDR.resolver.ip]: ADDR.resolverFromVpn.mac },
        apps: [],
      },
      {
        id: 'resolver',
        label: 'DNS resolver',
        kind: 'dns-resolver',
        ifaces: [
          { id: 'resolver.eth0', name: 'eth0', mac: ADDR.resolver.mac, ip: ADDR.resolver.ip },
          { id: 'resolver.eth1', name: 'eth1', mac: ADDR.resolverFromVpn.mac, ip: ADDR.resolver.ip },
          // Its own cables up to the root, TLD and authoritative servers.
          ...ADDR.resolverUp.map((up, i) => ({ id: `resolver.up${i + 1}`, name: `up${i + 1}`, mac: up.mac, ip: up.ip })),
        ],
        routes: [
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToResolver.ip, iface: 'resolver.eth0' },
          { network: ADDR.vpn.ip, prefixLen: 32, iface: 'resolver.eth1' },
          ...upstream.routes,
        ],
        arp: { [ADDR.ispToResolver.ip]: ADDR.ispToResolver.mac, [ADDR.vpn.ip]: ADDR.vpnToResolver.mac, ...upstream.arp },
        apps: [
          {
            kind: 'dns-server',
            processing: 0.0003,
            // Cold, the site is missing from the cache and the resolver knows the walk to make for it.
            records: Object.fromEntries(
              Object.entries({
                'example.com': { ips: [...CAPTURED_A_RECORDS], ttl: CAPTURED_DNS_TTL },
                [CERN_HOST]: { ips: [...CERN_A_RECORDS], ttl: CERN_DNS_TTL },
                [PHOTO_HOST]: { ips: [...PHOTO_A_RECORDS], ttl: PHOTO_DNS_TTL },
                // The friend's name is invented (no real walk was captured for it), so the resolver always has it cached.
                [ADDR.friend.name]: { ips: [ADDR.friend.ip], ttl: ADDR.friend.ttl },
                // The broker's name is invented like the friend's, so it is always cached too.
                ...(broker[0] ? { [BROKER_NAME]: { ips: [broker[0].device.ifaces[0]!.ip], ttl: ADDR.friend.ttl } } : {}),
              }).filter(([name]) => !(cold && name === host)),
            ),
            ...(cold ? { upstream: { hops: DNS_TRACES[host]!.hops.map((h) => ({ server: h.server })) } } : {}),
          },
        ],
      },
      ...upstream.devices,
      {
        id: 'server',
        label: 'Web server',
        kind: 'web-server',
        ifaces: [
          { id: 'server.eth0', name: 'eth0', mac: server.mac, ip: server.ip, aliases },
          { id: 'server.eth1', name: 'eth1', mac: ADDR.serverFromVpn.mac, ip: server.ip, aliases },
        ],
        routes: [
          { network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToServer.ip, iface: 'server.eth0' },
          { network: ADDR.vpn.ip, prefixLen: 32, iface: 'server.eth1' },
        ],
        arp: { [ADDR.ispToServer.ip]: ADDR.ispToServer.mac, [ADDR.vpn.ip]: ADDR.vpnToServer.mac },
        ...(bots.length ? { icmpLimit: true } : {}),
        apps: [
          ...(scanner.length ? SCAN.open.filter((port) => !(tls && port === 443)).map((port) => ({ kind: 'tcp-service' as const, port })) : []),
          {
            kind: 'http-server',
            processing: 0.0005,
            response: fromBase64(site.response),
            ...(tls ? { tls } : {}),
            ...(joins.length ? { responses: { 'example.com': fromBase64(HTTP_RESPONSE_BASE64), [PHOTO_HOST]: fromBase64(PHOTO_HTTP_RESPONSE_BASE64) } } : {}),
          },
        ],
      },
      {
        // The friend's phone, beyond the web server, on another provider's network. It is there in every run and only
        // speaks when called.
        id: 'friend',
        label: "Sam's phone",
        kind: 'peer',
        ifaces: [{ id: 'friend.eth0', name: 'eth0', mac: ADDR.friend.mac, ip: ADDR.friend.ip }],
        routes: [{ network: '0.0.0.0', prefixLen: 0, via: ADDR.ispToFriend.ip, iface: 'friend.eth0' }],
        arp: { [ADDR.ispToFriend.ip]: ADDR.ispToFriend.mac },
        apps: [{ kind: 'voice-peer', clip: fromBase64(VOICE_CLIP_FRIEND_BASE64), port: RTP_PORT }],
      },
      ...outsiders.map((o) => o.device),
      ...(attacks.has('listen')
        ? [
            {
              // A radio with no connection to anything: it joins no network and sends nothing, it only hears.
              id: 'stranger',
              label: 'Stranger',
              kind: 'stranger' as const,
              ifaces: [{ id: 'stranger.wlan0', name: 'wlan0', mac: '02:66:00:00:01:00', ip: '192.168.1.66' }],
              routes: [],
              apps: [],
            },
          ]
        : []),
    ],
    links: [
      ...homes.map((d) => ({ ...d.link, a: ifaceOf(d), b: d.port.id, ...(d.iface.wifi && opts.noise ? { noise: opts.noise } : {}), ...(d.iface.wifi && attacks.has('listen') ? { overheardBy: 'stranger' } : {}) })),
      opts.slow
        ? { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 25e6, delay: 0.28 }
        : opts.thin
          ? { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: THIN_BPS, delay: opts.wanDelay ?? WAN_DELAY, queue: THIN_QUEUE }
          : { id: 'wan', a: 'home.wan', b: 'isp.cust', bitsPerSecond: 1e9, delay: opts.wanDelay ?? WAN_DELAY },
      { id: 'bb1', a: 'isp.p1', b: 'resolver.eth0', bitsPerSecond: 1e10, delay: 0.003 },
      { id: 'bb3', a: 'isp.p3', b: 'vpn.eth0', bitsPerSecond: 1e10, delay: 0.005 },
      bots.length
        ? { id: 'bb2', a: 'isp.p2', b: 'server.eth0', bitsPerSecond: FLOODED_LINE_BPS, delay: 0.004, queue: THIN_QUEUE }
        : { id: 'bb2', a: 'isp.p2', b: 'server.eth0', bitsPerSecond: 1e10, delay: 0.004 },
      { id: 'bb4', a: 'vpn.eth1', b: 'server.eth1', bitsPerSecond: 1e10, delay: 0.004 },
      { id: 'bb5', a: 'vpn.eth2', b: 'resolver.eth1', bitsPerSecond: 1e10, delay: 0.003 },
      { id: 'bb6', a: 'isp.p4', b: 'friend.eth0', bitsPerSecond: 1e10, delay: 0.006 },
      ...upstream.links,
      ...outsiders.map((o) => o.link),
    ],
  };
}
