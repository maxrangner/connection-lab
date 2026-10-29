import { bytesToIp, bytesToMac, ipToBytes, macToBytes, type Ip4, type Mac } from '../bytes/addr';
import { ByteWriter, hex, u16, u8 } from '../bytes/bytes';
import { FieldList, type LayerPdu } from './types';

export const ARP_REQUEST = 1;
export const ARP_REPLY = 2;
export const ARP_LEN = 28;

export interface ArpPacket {
  oper: 1 | 2;
  sha: Mac;
  spa: Ip4;
  tha: Mac;
  tpa: Ip4;
}

export function buildArp(p: ArpPacket): Uint8Array {
  return new ByteWriter()
    .u16(1) // HTYPE Ethernet
    .u16(0x0800) // PTYPE IPv4
    .u8(6)
    .u8(4)
    .u16(p.oper)
    .bytes(macToBytes(p.sha))
    .bytes(ipToBytes(p.spa))
    .bytes(macToBytes(p.tha))
    .bytes(ipToBytes(p.tpa))
    .toBytes();
}

export function parseArp(b: Uint8Array, o: number): ArpPacket {
  return {
    oper: u16(b, o + 6) as 1 | 2,
    sha: bytesToMac(b, o + 8),
    spa: bytesToIp(b, o + 14),
    tha: bytesToMac(b, o + 18),
    tpa: bytesToIp(b, o + 24),
  };
}

export function describeArp(b: Uint8Array, o: number): LayerPdu {
  const p = parseArp(b, o);
  const f = new FieldList();
  f.add('arp.htype', 'Hardware type', o, 2, `${u16(b, o)} (Ethernet)`, 'detail', 'The kind of link-layer address being resolved. 1 means 48-bit Ethernet MAC addresses.');
  f.add('arp.ptype', 'Protocol type', o + 2, 2, `${hex(u16(b, o + 2), 4)} (IPv4)`, 'detail', 'The kind of network-layer address being resolved, using the same codes as EtherType.');
  f.add('arp.hlen', 'Hardware size', o + 4, 1, u8(b, o + 4), 'detail', 'Length of a MAC address in bytes.');
  f.add('arp.plen', 'Protocol size', o + 5, 1, u8(b, o + 5), 'detail', 'Length of an IPv4 address in bytes.');
  f.add(
    'arp.oper',
    'Opcode',
    o + 6,
    2,
    p.oper === ARP_REQUEST ? '1 (request)' : '2 (reply)',
    'key',
    p.oper === ARP_REQUEST
      ? 'A request asks the whole LAN: "who has this IP address? Tell me your MAC."'
      : 'A reply is sent straight back to the asker with the answer.',
  );
  f.add('arp.sha', 'Sender MAC', o + 8, 6, p.sha, 'key', 'MAC address of the device sending this ARP message. Receivers may cache it.');
  f.add('arp.spa', 'Sender IP', o + 14, 4, p.spa, 'key', 'IP address of the device sending this ARP message.');
  f.add(
    'arp.tha',
    'Target MAC',
    o + 18,
    6,
    p.tha,
    'key',
    p.oper === ARP_REQUEST
      ? 'Unknown yet, so it is all zeros. Filling this in is the whole point of the exchange.'
      : 'MAC address of the device that asked.',
  );
  f.add('arp.tpa', 'Target IP', o + 24, 4, p.tpa, 'key', p.oper === ARP_REQUEST ? 'The IP address whose MAC we want. Only the device that owns it answers.' : 'IP address of the device that asked.');
  return {
    protocol: 'arp',
    layer: 2,
    start: o,
    headerEnd: o + ARP_LEN,
    payloadEnd: o + ARP_LEN,
    end: o + ARP_LEN,
    summary: p.oper === ARP_REQUEST ? `ARP who has ${p.tpa}? tell ${p.spa}` : `ARP ${p.spa} is at ${p.sha}`,
    fields: f.list,
  };
}
