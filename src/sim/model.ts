import type { Ip4, Mac } from './bytes/addr';
import type { TlsSession } from './proto/tls';

/** What a card asks a device to do. */
export type Job = 'page' | 'photo' | 'call' | 'ping' | 'trace';
/** What can be started on a device: a job, or a sensor taking a reading. */
export type Action = Job | 'reading';

export type DeviceKind = 'laptop' | 'phone' | 'home-router' | 'router' | 'dns-resolver' | 'web-server' | 'vpn-server' | 'root-server' | 'tld-server' | 'auth-server' | 'peer' | 'stranger' | 'bot' | 'scanner' | 'sensor' | 'mqtt-broker';

export interface IfaceSpec {
  /** Globally unique, e.g. "laptop.eth0". */
  id: string;
  name: string;
  mac: Mac;
  ip: Ip4;
  prefixLen: number;
  /** A Wi-Fi radio instead of an Ethernet port: the access point side or a station (phone) side. */
  wifi?: 'ap' | 'station';
  /** More addresses this interface answers to (`ip addr add`): one server, several sites. */
  aliases?: Ip4[];
}

export interface RouteSpec {
  network: Ip4;
  prefixLen: number;
  /** Gateway; omitted for directly connected networks. */
  via?: Ip4;
  iface: string;
}

export interface LinkSpec {
  id: string;
  a: string;
  b: string;
  bitsPerSecond: number;
  /** One-way propagation delay in seconds. */
  delay: number;
  /** Map label, e.g. "Ethernet cable · 1 Gbit/s". */
  label: string;
  /** How narration refers to the link, e.g. "the Ethernet cable". */
  name: string;
  /**
   * The transmit buffer of each of the link's two ports, in frames: a frame that finds the port busy waits here, and one
   * that finds the buffer full is dropped at once (tail drop). Omitted, the buffer is unbounded and nothing is ever queued
   * visibly or dropped for want of room.
   */
  queue?: number;
  /**
   * Interference on a Wi-Fi link: the chance (0..1) that any one frame on the air, data or Ack, is lost, decided per frame
   * and per attempt by hash. With it set the link is a real 802.11 radio: half duplex, every unicast data frame answered by
   * an Ack after SIFS, and a frame with no Ack sent again with the Retry bit, up to 7 times. Omitted or 0, the link behaves
   * as a perfect cable through the air and no Acks are sent (today's simplification). Only meaningful on a Wi-Fi link.
   */
  noise?: number;
  /** A device with a radio in earshot of this Wi-Fi: on an open network it picks up every frame on the air, and nobody can tell. */
  overheardBy?: string;
}

export type AppSpec =
  | {
      kind: 'browser';
      url: string;
      /** The DNS resolver to ask. Left out when the device gets one from DHCP. */
      resolver?: Ip4;
      request: Uint8Array;
      /** The address is still in the browser's DNS cache (a second visit within the record's TTL): skip the lookup. */
      knownAddress?: Ip4;
      /** HTTPS: replay this captured TLS 1.3 session on port 443. */
      tls?: TlsSession;
    }
  /** The device starts with no address and gets one from the router by DHCP before the browser runs. */
  | { kind: 'dhcp-client'; /** What it calls itself (option 12), e.g. "laptop". */ hostName: string }
  /**
   * A voice call: look the friend's name up, then stream the clip to them as RTP over UDP, a 20 ms packet at a time,
   * and play what comes back. Nothing lost is ever sent again.
   */
  | {
      kind: 'voice-call';
      /** The name to call, e.g. "sam.example". */
      to: string;
      /** The DNS resolver to ask. Left out when the device gets one from DHCP. */
      resolver?: Ip4;
      /** What to say: one second of G.711 µ-law, 8000 bytes. */
      clip: Uint8Array;
      /** The address is still cached from an earlier call: skip the lookup. */
      knownAddress?: Ip4;
    }
  /** The friend's phone: waits for voice on `port` and answers with its own clip to whoever calls. */
  | { kind: 'voice-peer'; clip: Uint8Array; port: number }
  /** `ping -c count to`: echo requests one second apart, like Linux ping. `to` is a name or an address. */
  | { kind: 'ping'; to: string; /** The DNS resolver to ask for a name. Left out when DHCP hands one out. */ resolver?: Ip4; count: number }
  /** `traceroute -m maxHops to`: UDP probes with TTL 1, 2, 3 …, three per hop, like Linux traceroute. */
  | { kind: 'traceroute'; to: string; resolver?: Ip4; maxHops: number }
  /** A bot: junk UDP datagrams at a server, at a set pace, answered or not. */
  | { kind: 'flood'; to: Ip4; port: number; packets: number; burst: number; gap: number; bytes: number }
  /** A port scan: a SYN to each port in turn. A SYN-ACK says open, a reset says closed; it never finishes the hello. */
  | { kind: 'port-scan'; to: Ip4; ports: number[]; gap: number }
  /** Something else the server runs, which accepts a connection on this port. */
  | { kind: 'tcp-service'; port: number }
  /**
   * An MQTT client: it looks the broker up, connects and stays connected. An app subscribes to a topic; a sensor publishes
   * one reading to its topic at the time given.
   */
  | { kind: 'mqtt-client'; clientId: string; broker: string; resolver: Ip4; subscribe?: string; publish?: { topic: string; at: number } }
  /** An MQTT broker: it hands a copy of what is published to each client subscribed to that topic. */
  | { kind: 'mqtt-broker'; processing: number }
  | {
      kind: 'dns-server';
      /** What the resolver already has in its cache. */
      records: Record<string, { ips: Ip4[]; ttl: number }>;
      processing: number;
      /**
       * How to find out what is not cached: the servers of a real walk through the hierarchy, root first. The resolver
       * asks the first, follows each referral to the server it names (the one with glue), and caches the final answer.
       */
      upstream?: { hops: { server: { name: string; ip: Ip4 } }[] };
    }
  /** A root, TLD or authoritative server: it answers a question for `name` with these captured bytes (only the id changes). */
  | { kind: 'dns-authority'; answers: { name: string; response: Uint8Array }[]; processing: number }
  | {
      kind: 'http-server';
      response: Uint8Array;
      processing: number;
      /** Also serve HTTPS on 443 with this session. */
      tls?: TlsSession;
      /** Other sites on the same server, by the name in the request's Host header (virtual hosting). */
      responses?: Record<string, Uint8Array>;
    };

export interface DhcpServerSpec {
  /** Interfaces it answers on (the home side, not the ISP side). */
  ifaces: string[];
  /** Fixed leases: which address each MAC gets. */
  leases: Record<Mac, Ip4>;
  mask: Ip4;
  /** The default gateway to hand out (option 3). */
  router: Ip4;
  /** DNS servers to hand out (option 6). */
  dns: Ip4[];
  /** Lease time in seconds (option 51). */
  lease: number;
  /** Seconds the server takes to answer. */
  processing: number;
}

export interface DeviceSpec {
  id: string;
  label: string;
  sublabel?: string;
  kind: DeviceKind;
  ifaces: IfaceSpec[];
  routes: RouteSpec[];
  /** Pre-filled ARP cache entries (e.g. on point-to-point backbone links). */
  arp?: Record<Ip4, Mac>;
  /** Interfaces on the home side (Ethernet and Wi-Fi) and the one facing the ISP. */
  nat?: { inside: string[]; outside: string };
  /** A DHCP server on a router: which interfaces it serves and what it hands out. */
  dhcp?: DhcpServerSpec;
  apps: AppSpec[];
  /** What the viewer can start on this device. Only the viewer's own devices have any. */
  actions?: Action[];
  /** Its colour, once several devices' packets are on the table at once. */
  color?: string;
  /** Map position for the UI, in scene units. */
  layout: { x: number; y: number };
  /** Send everything through a WireGuard tunnel to this server, using this inner address. */
  tunnel?: { ip: Ip4; server: Ip4 };
  /** Linux defaults to 64. */
  initialTtl?: number;
  /** Sends one ICMP error a second to any one address, as Linux does (`icmp_ratelimit`), so a flood gets almost no answers. */
  icmpLimit?: boolean;
}

export interface TcpSettings {
  /** MSS the laptop advertises. 1460 for Ethernet; 536 is the IPv4 default when nothing better is known. */
  clientMss: number;
  serverMss: number;
}

export interface Scenario {
  id: string;
  title: string;
  devices: DeviceSpec[];
  links: LinkSpec[];
  tcp: TcpSettings;
  /** Device whose browser app starts at t = 0. */
  startDevice: string;
  /** Other devices whose jobs start during the run, each at its own time, so they all share the home router at once. */
  companions?: { device: string; at: number }[];
  /**
   * What happens before this time is how things stand when the run starts: it really happens, but it is not told. A smart
   * home's apps connected long ago.
   */
  quietUntil?: number;
  /** Attackers and when each starts. Each is a job of its own, numbered after the first and before the companions. */
  attackers?: { device: string; at: number }[];
}
