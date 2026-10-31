import type { Ip4 } from '../bytes/addr';
import { describeArp } from './arp';
import { describeDhcp, DHCP_CLIENT_PORT, DHCP_SERVER_PORT } from './dhcp';
import { describeDns } from './dns';
import { describeEthernet, ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEthernet } from './ethernet';
import { describeHttp } from './http';
import { describeIpv4, IPPROTO_TCP, IPPROTO_UDP, parseIpv4 } from './ipv4';
import { describeTcp, parseTcp } from './tcp';
import { describeTls } from './tls';
import { describeWifi, parseWifi } from './wifi';
import { describeWireguard, WG_PORT } from './wireguard';
import type { LayerPdu, Protocol } from './types';
import { describeUdp, parseUdp } from './udp';

export interface DecodeContext {
  srcIp?: Ip4;
  dstIp?: Ip4;
  /** For bare transport segments: which app protocol the payload is. */
  appHint?: Protocol;
}

/**
 * Decodes a PDU starting at `first` and walks inwards, returning one LayerPdu per protocol, outermost first.
 * Every view in the UI (strip colors, clean/full fields, hex highlights) derives from this.
 */
export function decodePdu(bytes: Uint8Array, first: Protocol, ctx: DecodeContext = {}): LayerPdu[] {
  const out: LayerPdu[] = [];
  walk(bytes, first, 0, bytes.length, ctx, out);
  return out;
}

function walk(b: Uint8Array, proto: Protocol, o: number, end: number, ctx: DecodeContext, out: LayerPdu[]): number {
  switch (proto) {
    case 'ethernet': {
      const eth = parseEthernet(b);
      const idx = out.length;
      out.push(describeEthernet(b));
      let innerEnd = eth.payloadEnd;
      if (eth.type === ETHERTYPE_ARP) innerEnd = walk(b, 'arp', eth.payloadStart, eth.payloadEnd, ctx, out);
      else if (eth.type === ETHERTYPE_IPV4) innerEnd = walk(b, 'ipv4', eth.payloadStart, eth.payloadEnd, ctx, out);
      out[idx] = describeEthernet(b, innerEnd);
      return b.length;
    }
    case 'wifi': {
      const w = parseWifi(b);
      const idx = out.length;
      out.push(describeWifi(b));
      let innerEnd = w.payloadEnd;
      if (w.type === ETHERTYPE_ARP) innerEnd = walk(b, 'arp', w.payloadStart, w.payloadEnd, ctx, out);
      else if (w.type === ETHERTYPE_IPV4) innerEnd = walk(b, 'ipv4', w.payloadStart, w.payloadEnd, ctx, out);
      out[idx] = describeWifi(b, innerEnd);
      return b.length;
    }
    case 'arp': {
      const pdu = describeArp(b, o);
      out.push(pdu);
      return pdu.end;
    }
    case 'ipv4': {
      const ip = parseIpv4(b, o);
      const pdu = describeIpv4(b, o);
      out.push(pdu);
      const inner = { ...ctx, srcIp: ip.src, dstIp: ip.dst };
      if (ip.protocol === IPPROTO_UDP) walk(b, 'udp', pdu.headerEnd, pdu.end, inner, out);
      else if (ip.protocol === IPPROTO_TCP) walk(b, 'tcp', pdu.headerEnd, pdu.end, inner, out);
      return pdu.end;
    }
    case 'udp': {
      const u = parseUdp(b, o);
      const pdu = describeUdp(b, o, ctx.srcIp, ctx.dstIp);
      out.push(pdu);
      if (u.payloadEnd > u.payloadStart && (u.srcPort === WG_PORT || u.dstPort === WG_PORT)) {
        walk(b, 'wireguard', u.payloadStart, u.payloadEnd, ctx, out);
      } else if (u.payloadEnd > u.payloadStart && (u.srcPort === 53 || u.dstPort === 53 || ctx.appHint === 'dns')) {
        walk(b, 'dns', u.payloadStart, u.payloadEnd, ctx, out);
      } else if (u.payloadEnd > u.payloadStart && ([DHCP_SERVER_PORT, DHCP_CLIENT_PORT].includes(u.dstPort) || ctx.appHint === 'dhcp')) {
        walk(b, 'dhcp', u.payloadStart, u.payloadEnd, ctx, out);
      }
      return pdu.end;
    }
    case 'tcp': {
      const t = parseTcp(b, o);
      const pdu = describeTcp(b, o, end, ctx.srcIp, ctx.dstIp);
      out.push(pdu);
      if (end > t.payloadStart && (t.srcPort === 443 || t.dstPort === 443 || ctx.appHint === 'tls')) {
        walk(b, 'tls', t.payloadStart, end, ctx, out);
      } else if (end > t.payloadStart && (t.srcPort === 80 || t.dstPort === 80 || ctx.appHint === 'http')) {
        walk(b, 'http', t.payloadStart, end, ctx, out);
      }
      return end;
    }
    case 'dns': {
      out.push(describeDns(b, o, end));
      return end;
    }
    case 'dhcp': {
      out.push(describeDhcp(b, o, end));
      return end;
    }
    case 'wireguard': {
      out.push(describeWireguard(b, o, end));
      return end;
    }
    case 'tls': {
      out.push(describeTls(b, o, end));
      return end;
    }
    case 'http': {
      out.push(describeHttp(b, o, end));
      return end;
    }
  }
}
