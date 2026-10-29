import type { DeviceKind, LayerNum, SimEvent } from '../../../sim';

/**
 * One workstation per floor (plus the NAT desk on a home router's network floor, and one port per interface
 * on the physical floor). Speech bubbles, gates and the scene all address machines by these kinds.
 */
export type MachineKind =
  | 'browser' // laptop app floor: the browser window + stub resolver
  | 'dnsDesk' // resolver app floor: card index
  | 'httpShelf' // web server app floor: the page on a shelf
  | 'tcpClerk' // transport floor: clerk desk (stamp, copy shelf, hourglass) with a UDP chute beside it
  | 'netStation' // network floor: signpost, TTL punch, checksum scale
  | 'natDesk' // home router network floor: address label swapper + ledger
  | 'linkStation' // link floor: ARP megaphone + address book, hull bolter, CRC seal stamp
  | 'port'; // physical floor: one transceiver per interface, with a lever

export const MACHINE_FLOOR: Record<MachineKind, LayerNum> = {
  browser: 5,
  dnsDesk: 5,
  httpShelf: 5,
  tcpClerk: 4,
  netStation: 3,
  natDesk: 3,
  linkStation: 2,
  port: 1,
};

export const MACHINE_NAME: Record<MachineKind, string> = {
  browser: 'Browser',
  dnsDesk: 'Resolver desk',
  httpShelf: 'Web server',
  tcpClerk: 'TCP clerk',
  netStation: 'IP station',
  natDesk: 'NAT desk',
  linkStation: 'Ethernet station',
  port: 'Port',
};

export function machinesFor(kind: DeviceKind): MachineKind[] {
  switch (kind) {
    case 'laptop':
      return ['browser', 'tcpClerk', 'netStation', 'linkStation', 'port'];
    case 'dns-resolver':
      return ['dnsDesk', 'tcpClerk', 'netStation', 'linkStation', 'port'];
    case 'web-server':
      return ['httpShelf', 'tcpClerk', 'netStation', 'linkStation', 'port'];
    case 'home-router':
      return ['netStation', 'natDesk', 'linkStation', 'port'];
    case 'router':
      return ['netStation', 'linkStation', 'port'];
  }
}

function appMachine(kind: DeviceKind): MachineKind {
  return kind === 'dns-resolver' ? 'dnsDesk' : kind === 'web-server' ? 'httpShelf' : 'browser';
}

/** Which machine performs an event on a device of the given kind. Undefined = not tied to a machine (e.g. a drop on a cable). */
export function machineFor(e: SimEvent, kind: DeviceKind): MachineKind | undefined {
  switch (e.type) {
    case 'app':
      return appMachine(kind);
    case 'encapsulate':
    case 'decapsulate':
      switch (e.protocol) {
        case 'dns':
        case 'http':
          return appMachine(kind);
        case 'tcp':
        case 'udp':
          return 'tcpClerk';
        case 'ipv4':
          return 'netStation';
        case 'arp':
        case 'ethernet':
          return 'linkStation';
      }
      break;
    case 'arp:miss':
    case 'arp:hit':
    case 'arp:learn':
      return 'linkStation';
    case 'route':
    case 'forward':
      return 'netStation';
    case 'nat:add':
    case 'nat:translate':
      return 'natDesk';
    case 'tx':
    case 'rx':
      return 'port';
    case 'drop':
      if (!e.deviceId) return undefined;
      return e.reason === 'no-socket' ? 'tcpClerk' : e.reason === 'no-nat-mapping' ? 'natDesk' : e.reason === 'bad-checksum' || e.reason === 'not-for-me' ? 'linkStation' : 'netStation';
    case 'timer:set':
    case 'timer:cancel':
    case 'timer:fire':
      return e.kind === 'tcp-rto' || e.kind === 'tcp-timewait' ? 'tcpClerk' : e.kind === 'dns-retry' ? appMachine(kind) : 'linkStation';
    case 'tcp:state':
    case 'tcp:retransmit':
    case 'tcp:dup-ack':
    case 'tcp:ooo':
    case 'tcp:duplicate':
    case 'tcp:deliver':
    case 'tcp:rtt':
      return 'tcpClerk';
  }
  return undefined;
}
