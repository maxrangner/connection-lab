import type { Ip4, Mac } from './bytes/addr';

export type DeviceKind = 'laptop' | 'home-router' | 'router' | 'dns-resolver' | 'web-server';

export interface IfaceSpec {
  /** Globally unique, e.g. "laptop.eth0". */
  id: string;
  name: string;
  mac: Mac;
  ip: Ip4;
  prefixLen: number;
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
}

export type AppSpec =
  | { kind: 'browser'; url: string; resolver: Ip4; request: Uint8Array }
  | { kind: 'dns-server'; records: Record<string, { ips: Ip4[]; ttl: number }>; processing: number }
  | { kind: 'http-server'; response: Uint8Array; processing: number };

export interface DeviceSpec {
  id: string;
  label: string;
  sublabel?: string;
  kind: DeviceKind;
  ifaces: IfaceSpec[];
  routes: RouteSpec[];
  /** Pre-filled ARP cache entries (e.g. on point-to-point backbone links). */
  arp?: Record<Ip4, Mac>;
  nat?: { inside: string; outside: string };
  apps: AppSpec[];
  /** Map position for the UI, in scene units. */
  layout: { x: number; y: number };
  /** Linux defaults to 64. */
  initialTtl?: number;
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
}
