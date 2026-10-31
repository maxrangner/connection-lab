import { bytesToIp, bytesToMac, ipToBytes, macToBytes, type Ip4, type Mac } from '../bytes/addr';
import { ByteWriter, hex, hexBytes, toAscii, u16, u32, u8 } from '../bytes/bytes';
import { bitField, FieldList, type Field, type LayerPdu } from './types';

/**
 * DHCP (RFC 2131) rides on BOOTP (RFC 951): a 236-byte fixed part, the magic cookie 63 82 53 63, then options in
 * code · length · value form (RFC 2132), ended by option 255. Servers listen on UDP 67, clients on 68.
 *
 * Layout: op (1) · htype (1) · hlen (1) · hops (1) · xid (4) · secs (2) · flags (2) · ciaddr (4) · yiaddr (4) ·
 * siaddr (4) · giaddr (4) · chaddr (16) · sname (64) · file (128) · cookie (4) · options.
 */
export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;
export const BOOTREQUEST = 1;
export const BOOTREPLY = 2;
export const DHCP_FIXED_LEN = 236;
export const DHCP_MAGIC_COOKIE = [0x63, 0x82, 0x53, 0x63];
/** BOOTP messages are at least 300 bytes; clients and servers pad short ones with option 0 to get there. */
export const DHCP_MIN_LEN = 300;
/** The broadcast bit in `flags`: "I cannot receive unicast yet, broadcast your reply". */
export const DHCP_FLAG_BROADCAST = 0x8000;

export const DHCP_DISCOVER = 1;
export const DHCP_OFFER = 2;
export const DHCP_REQUEST = 3;
export const DHCP_DECLINE = 4;
export const DHCP_ACK = 5;
export const DHCP_NAK = 6;
export const DHCP_RELEASE = 7;
export const DHCP_INFORM = 8;

const TYPE_NAMES: Record<number, string> = { 1: 'DISCOVER', 2: 'OFFER', 3: 'REQUEST', 4: 'DECLINE', 5: 'ACK', 6: 'NAK', 7: 'RELEASE', 8: 'INFORM' };

export function dhcpTypeName(t: number): string {
  return TYPE_NAMES[t] ?? `type ${t}`;
}

/** Option codes (RFC 2132). */
export const OPT_PAD = 0;
export const OPT_SUBNET_MASK = 1;
export const OPT_ROUTER = 3;
export const OPT_DNS = 6;
export const OPT_HOST_NAME = 12;
export const OPT_DOMAIN_NAME = 15;
export const OPT_BROADCAST = 28;
export const OPT_REQUESTED_IP = 50;
export const OPT_LEASE_TIME = 51;
export const OPT_MESSAGE_TYPE = 53;
export const OPT_SERVER_ID = 54;
export const OPT_PARAM_REQUEST = 55;
export const OPT_CLIENT_ID = 61;
export const OPT_END = 255;

const OPTION_NAMES: Record<number, string> = {
  [OPT_SUBNET_MASK]: 'Subnet mask',
  [OPT_ROUTER]: 'Router',
  [OPT_DNS]: 'DNS servers',
  [OPT_HOST_NAME]: 'Host name',
  [OPT_DOMAIN_NAME]: 'Domain name',
  [OPT_BROADCAST]: 'Broadcast address',
  [OPT_REQUESTED_IP]: 'Requested IP address',
  [OPT_LEASE_TIME]: 'IP address lease time',
  [OPT_MESSAGE_TYPE]: 'DHCP message type',
  [OPT_SERVER_ID]: 'DHCP server identifier',
  [OPT_PARAM_REQUEST]: 'Parameter request list',
  [OPT_CLIENT_ID]: 'Client identifier',
};

export function dhcpOptionName(code: number): string {
  return OPTION_NAMES[code] ?? `Option ${code}`;
}

/** The options this sim builds and reads; anything else is kept raw. */
export interface DhcpOptions {
  /** Option 53. */
  type: number;
  /** Option 50: the address the client asks for (in a REQUEST). */
  requestedIp?: Ip4;
  /** Option 54: which server is speaking, or which server's offer the client took. */
  serverId?: Ip4;
  /** Option 51, seconds. */
  leaseTime?: number;
  /** Option 1. */
  subnetMask?: Ip4;
  /** Option 3. */
  routers?: Ip4[];
  /** Option 6. */
  dns?: Ip4[];
  /** Option 12. */
  hostName?: string;
  /** Option 55: the option codes the client would like to be told. */
  paramRequest?: number[];
  /** Option 61: the client's MAC (sent as hardware type 1 + 6 bytes). */
  clientId?: Mac;
}

export interface DhcpMessage {
  op: number;
  hops?: number;
  xid: number;
  secs: number;
  broadcast: boolean;
  ciaddr: Ip4;
  yiaddr: Ip4;
  siaddr: Ip4;
  giaddr: Ip4;
  chaddr: Mac;
  options: DhcpOptions;
}

/** Builds a BOOTP/DHCP message. Options go out in the order clients and servers usually send them, type first. */
export function buildDhcp(m: DhcpMessage): Uint8Array {
  const w = new ByteWriter()
    .u8(m.op)
    .u8(1) // htype: Ethernet
    .u8(6) // hlen: a MAC is 6 bytes
    .u8(m.hops ?? 0)
    .u32(m.xid)
    .u16(m.secs)
    .u16(m.broadcast ? DHCP_FLAG_BROADCAST : 0)
    .bytes(ipToBytes(m.ciaddr))
    .bytes(ipToBytes(m.yiaddr))
    .bytes(ipToBytes(m.siaddr))
    .bytes(ipToBytes(m.giaddr))
    .bytes(macToBytes(m.chaddr))
    .zeros(10) // the rest of the 16-byte chaddr
    .zeros(64) // sname
    .zeros(128) // file
    .bytes(DHCP_MAGIC_COOKIE);
  const o = m.options;
  const opt = (code: number, data: ArrayLike<number>): void => {
    w.u8(code).u8(data.length).bytes(data);
  };
  opt(OPT_MESSAGE_TYPE, [o.type]);
  if (o.clientId) opt(OPT_CLIENT_ID, [1, ...macToBytes(o.clientId)]);
  if (o.requestedIp) opt(OPT_REQUESTED_IP, ipToBytes(o.requestedIp));
  if (o.serverId) opt(OPT_SERVER_ID, ipToBytes(o.serverId));
  if (o.leaseTime !== undefined) opt(OPT_LEASE_TIME, [(o.leaseTime >>> 24) & 0xff, (o.leaseTime >>> 16) & 0xff, (o.leaseTime >>> 8) & 0xff, o.leaseTime & 0xff]);
  if (o.subnetMask) opt(OPT_SUBNET_MASK, ipToBytes(o.subnetMask));
  if (o.routers?.length) opt(OPT_ROUTER, o.routers.flatMap(ipToBytes));
  if (o.dns?.length) opt(OPT_DNS, o.dns.flatMap(ipToBytes));
  if (o.hostName) opt(OPT_HOST_NAME, Array.from(o.hostName, (c) => c.charCodeAt(0)));
  if (o.paramRequest?.length) opt(OPT_PARAM_REQUEST, o.paramRequest);
  w.u8(OPT_END);
  if (w.length < DHCP_MIN_LEN) w.zeros(DHCP_MIN_LEN - w.length);
  return w.toBytes();
}

/** One option as it sits in the bytes. */
export interface RawOption {
  code: number;
  /** Offset of the code byte. */
  offset: number;
  /** Length of the value. */
  length: number;
}

export interface ParsedDhcp extends DhcpMessage {
  htype: number;
  hlen: number;
  flags: number;
  cookieValid: boolean;
  raw: RawOption[];
  /** Offset just past the end option (or the end of the buffer). */
  optionsEnd: number;
}

function ipList(b: Uint8Array, o: number, len: number): Ip4[] {
  const out: Ip4[] = [];
  for (let i = 0; i + 4 <= len; i += 4) out.push(bytesToIp(b, o + i));
  return out;
}

export function parseDhcp(b: Uint8Array, o: number): ParsedDhcp {
  const raw: RawOption[] = [];
  const options: DhcpOptions = { type: 0 };
  let i = o + DHCP_FIXED_LEN + 4;
  let optionsEnd = b.length;
  while (i < b.length) {
    const code = u8(b, i);
    if (code === OPT_PAD) {
      i++;
      continue;
    }
    if (code === OPT_END) {
      raw.push({ code, offset: i, length: 0 });
      optionsEnd = i + 1;
      break;
    }
    const len = u8(b, i + 1);
    const v = i + 2;
    raw.push({ code, offset: i, length: len });
    switch (code) {
      case OPT_MESSAGE_TYPE:
        options.type = u8(b, v);
        break;
      case OPT_REQUESTED_IP:
        options.requestedIp = bytesToIp(b, v);
        break;
      case OPT_SERVER_ID:
        options.serverId = bytesToIp(b, v);
        break;
      case OPT_LEASE_TIME:
        options.leaseTime = u32(b, v);
        break;
      case OPT_SUBNET_MASK:
        options.subnetMask = bytesToIp(b, v);
        break;
      case OPT_ROUTER:
        options.routers = ipList(b, v, len);
        break;
      case OPT_DNS:
        options.dns = ipList(b, v, len);
        break;
      case OPT_HOST_NAME:
        options.hostName = toAscii(b, v, v + len);
        break;
      case OPT_PARAM_REQUEST:
        options.paramRequest = Array.from(b.subarray(v, v + len));
        break;
      case OPT_CLIENT_ID:
        if (len === 7 && u8(b, v) === 1) options.clientId = bytesToMac(b, v + 1);
        break;
    }
    i = v + len;
  }
  const flags = u16(b, o + 10);
  return {
    op: u8(b, o),
    htype: u8(b, o + 1),
    hlen: u8(b, o + 2),
    hops: u8(b, o + 3),
    xid: u32(b, o + 4),
    secs: u16(b, o + 8),
    flags,
    broadcast: (flags & DHCP_FLAG_BROADCAST) !== 0,
    ciaddr: bytesToIp(b, o + 12),
    yiaddr: bytesToIp(b, o + 16),
    siaddr: bytesToIp(b, o + 20),
    giaddr: bytesToIp(b, o + 24),
    chaddr: bytesToMac(b, o + 28),
    cookieValid: DHCP_MAGIC_COOKIE.every((x, k) => u8(b, o + DHCP_FIXED_LEN + k) === x),
    raw,
    optionsEnd,
    options,
  };
}

/** "86400 s (1 day)". */
function seconds(n: number): string {
  if (n % 86400 === 0) return `${n} s (${n / 86400} day${n === 86400 ? '' : 's'})`;
  if (n % 3600 === 0) return `${n} s (${n / 3600} h)`;
  return `${n} s`;
}

const PARAM_NAMES: Record<number, string> = { 1: 'subnet mask', 3: 'router', 6: 'DNS servers', 15: 'domain name', 28: 'broadcast address', 51: 'lease time', 54: 'server identifier' };

const isReply = (m: ParsedDhcp): boolean => m.op === BOOTREPLY;

/** What one option says, and why it is here, by code. */
function optionField(b: Uint8Array, m: ParsedDhcp, r: RawOption): Field {
  const v = r.offset + 2;
  const key = `dhcp.opt.${r.code}`;
  const name = `Option ${r.code}: ${dhcpOptionName(r.code)}`;
  let display = hexBytes(b, v, v + r.length);
  let importance: Field['importance'] = 'detail';
  let explain = 'An option this simulation does not read: code, length and value as sent.';
  switch (r.code) {
    case OPT_MESSAGE_TYPE: {
      const t = u8(b, v);
      display = `${t} (${dhcpTypeName(t)})`;
      importance = 'key';
      explain = {
        [DHCP_DISCOVER]: 'DISCOVER: "is there a DHCP server here? I need an address." Broadcast, because the client knows nobody yet.',
        [DHCP_OFFER]: 'OFFER: a server proposes an address and a lease. Several servers may offer; the client picks one.',
        [DHCP_REQUEST]: 'REQUEST: the client asks for the offered address, naming the server it chose, so other servers can forget their offers.',
        [DHCP_DECLINE]: 'DECLINE: the client found the offered address already in use (by ARP) and refuses it.',
        [DHCP_ACK]: 'ACK: the lease is granted. From this moment the client may use the address, the router and the DNS servers given here.',
        [DHCP_NAK]: 'NAK: the server refuses the request; the client must start over with a new DISCOVER.',
        [DHCP_RELEASE]: 'RELEASE: the client gives the address back before the lease runs out.',
        [DHCP_INFORM]: 'INFORM: a client that already has an address asks only for the other settings.',
      }[t] ?? `An unknown message type.`;
      break;
    }
    case OPT_REQUESTED_IP:
      display = bytesToIp(b, v);
      importance = 'key';
      explain = 'The address the client would like: the one it was just offered. It cannot go in ciaddr, which is only for an address the client already has.';
      break;
    case OPT_SERVER_ID:
      display = bytesToIp(b, v);
      importance = 'key';
      explain = isReply(m) ? 'The address of the server speaking, so the client can tell offers apart and address this server later.' : "The server whose offer the client accepted. Other servers that offered an address see it is not them and free the address again.";
      break;
    case OPT_LEASE_TIME:
      display = seconds(u32(b, v));
      importance = 'key';
      explain = 'How long the client may keep the address. A client that stays on the network renews halfway through, so the address is not given away.';
      break;
    case OPT_SUBNET_MASK:
      display = bytesToIp(b, v);
      importance = 'key';
      explain = 'Which part of an address names this network: 255.255.255.0 means the first three numbers. Addresses matching those are neighbours, reached directly; anything else goes via the router.';
      break;
    case OPT_ROUTER:
      display = ipList(b, v, r.length).join(', ');
      importance = 'key';
      explain = 'The default gateway: where to send everything that is not on this network. This becomes the default route.';
      break;
    case OPT_DNS:
      display = ipList(b, v, r.length).join(', ');
      importance = 'key';
      explain = 'Which DNS resolver to ask names. This is where the resolver address the browser uses comes from.';
      break;
    case OPT_HOST_NAME:
      display = `"${toAscii(b, v, v + r.length)}"`;
      explain = 'The name the client calls itself, so the router can list it and may register it in local DNS.';
      break;
    case OPT_PARAM_REQUEST:
      display = Array.from(b.subarray(v, v + r.length), (c) => `${c}${PARAM_NAMES[c] ? ` (${PARAM_NAMES[c]})` : ''}`).join(', ');
      explain = 'The option codes the client wants to be told, as a list of codes: here subnet mask, router, DNS servers, domain name, broadcast address, lease time and server identifier.';
      break;
    case OPT_CLIENT_ID:
      display = u8(b, v) === 1 && r.length === 7 ? `01 + ${bytesToMac(b, v + 1)}` : hexBytes(b, v, v + r.length);
      explain = 'How the server tells clients apart: hardware type 1 (Ethernet) followed by the MAC address. The server keys its lease table on this.';
      break;
    case OPT_END:
      return { key: 'dhcp.end', name: 'End', offset: r.offset, length: 1, display: '255', importance: 'detail', explain: 'Option 255 ends the option list. Anything after it is padding.' };
  }
  return {
    key,
    name,
    offset: r.offset,
    length: 2 + r.length,
    display,
    importance,
    explain,
    children: [
      { key: `${key}.code`, name: 'Code', offset: r.offset, length: 1, display: String(r.code), importance: 'detail', explain: 'Which option this is (RFC 2132 numbers them).' },
      { key: `${key}.len`, name: 'Length', offset: r.offset + 1, length: 1, display: String(r.length), importance: 'detail', explain: 'How many bytes of value follow.' },
      { key: `${key}.value`, name: 'Value', offset: v, length: r.length, display: hexBytes(b, v, v + r.length), importance: 'detail', explain: 'The bytes of the value.' },
    ],
  };
}

/** The address a message is about: the one offered or granted, or the one asked for. */
export function dhcpAddress(m: ParsedDhcp): Ip4 | undefined {
  if (m.yiaddr !== '0.0.0.0') return m.yiaddr;
  return m.options.requestedIp;
}

export function dhcpSummary(m: ParsedDhcp): string {
  const addr = dhcpAddress(m);
  return `DHCP ${dhcpTypeName(m.options.type)}${addr ? ` ${addr}` : ''} · xid ${hex(m.xid, 8)}`;
}

export function describeDhcp(b: Uint8Array, o: number, end: number): LayerPdu {
  const m = parseDhcp(b, o);
  const reply = isReply(m);
  const f = new FieldList();
  f.add('dhcp.op', 'Message op code', o, 1, `${m.op} (${m.op === BOOTREQUEST ? 'BOOTREQUEST, from a client' : m.op === BOOTREPLY ? 'BOOTREPLY, from a server' : '?'})`, 'key', 'BOOTP only knows two directions: 1 is anything a client sends, 2 anything a server sends. The DHCP message type (option 53) says more.');
  f.add('dhcp.htype', 'Hardware type', o + 1, 1, `${m.htype} (Ethernet)`, 'detail', 'The kind of hardware address in chaddr: 1 means a 48-bit Ethernet MAC, also for Wi-Fi.');
  f.add('dhcp.hlen', 'Hardware address length', o + 2, 1, m.hlen, 'detail', 'How many bytes of chaddr are the address: 6 for a MAC.');
  f.add('dhcp.hops', 'Hops', o + 3, 1, m.hops ?? 0, 'detail', 'Counted up by relay agents that pass DHCP between networks. 0: client and server share this link.');
  f.add('dhcp.xid', 'Transaction ID', o + 4, 4, hex(m.xid, 8), 'key', 'A random number the client picks for one whole exchange. The server copies it into every reply, so the client can match offers and acknowledgements to its own request.');
  f.add('dhcp.secs', 'Seconds elapsed', o + 8, 2, `${m.secs} s`, m.secs > 0 ? 'key' : 'detail', reply ? 'Servers leave this 0.' : 'How long the client has been trying, since its first DISCOVER. A server may answer a client that has waited a long time first.');
  f.add('dhcp.flags', 'Flags', o + 10, 2, `${hex(m.flags, 4)}${m.broadcast ? ' (broadcast)' : ''}`, 'detail', m.broadcast ? 'The broadcast bit is set: the client cannot receive a reply sent to its new address yet, so the server broadcasts its reply.' : 'The broadcast bit is clear: the client can take a reply sent straight to its MAC, so the server does that, with the offered address as IP destination.', {
    children: [
      bitField('dhcp.flags.b', 'Broadcast', o + 10, 2, 0, 1, m.broadcast ? 1 : 0, 'detail', '1 asks the server to broadcast its replies instead of sending them to the offered address.'),
      bitField('dhcp.flags.mbz', 'Reserved', o + 10, 2, 1, 15, m.flags & 0x7fff, 'detail', 'Must be zero.'),
    ],
  });
  f.add('dhcp.ciaddr', 'Client IP address', o + 12, 4, m.ciaddr, 'key', m.ciaddr === '0.0.0.0' ? 'Filled in only by a client that already has an address (when renewing). This client has none yet: 0.0.0.0.' : 'The address the client already has and is renewing.');
  f.add('dhcp.yiaddr', '"Your" IP address', o + 16, 4, m.yiaddr, 'key', reply ? 'The address the server is offering or granting to the client: the answer to "what is my address?".' : 'Only servers fill this in. A client leaves it 0.0.0.0.');
  f.add('dhcp.siaddr', 'Server IP address', o + 20, 4, m.siaddr, 'detail', reply ? 'The server to use for the next step of booting over the network (loading a boot file). Here simply the DHCP server itself.' : 'Only servers fill this in.');
  f.add('dhcp.giaddr', 'Relay agent IP address', o + 24, 4, m.giaddr, 'detail', '0.0.0.0: no relay agent passed this message on; client and server are on the same link.');
  f.add('dhcp.chaddr', 'Client hardware address', o + 28, 16, m.chaddr, 'key', reply ? 'The MAC address of the client this reply is for. The server also puts it in the Ethernet header, so the client receives the frame although it has no IP address yet.' : "The client's MAC address: the one thing it has from the start. The server keys its answer on it, and sends the reply to it.", {
    children: [
      { key: 'dhcp.chaddr.mac', name: 'MAC address', offset: o + 28, length: 6, display: m.chaddr, importance: 'detail', explain: 'The 6 bytes of the MAC address.' },
      { key: 'dhcp.chaddr.pad', name: 'Padding', offset: o + 34, length: 10, display: '10 zero bytes', importance: 'detail', explain: 'The field holds 16 bytes for longer hardware addresses; a MAC uses 6 and the rest is zero.' },
    ],
  });
  f.add('dhcp.sname', 'Server host name', o + 44, 64, 'empty', 'detail', 'Room for a server name, 64 bytes. Unused by DHCP in practice, so all zeros.');
  f.add('dhcp.file', 'Boot file name', o + 108, 128, 'empty', 'detail', 'Room for the name of a boot file, 128 bytes, from the days when BOOTP loaded a workstation over the network. All zeros here.');
  f.add('dhcp.cookie', 'Magic cookie', o + DHCP_FIXED_LEN, 4, `${hexBytes(b, o + DHCP_FIXED_LEN, o + DHCP_FIXED_LEN + 4)}${m.cookieValid ? ' ✓' : ' ✗'}`, 'detail', 'The bytes 63 82 53 63 (99.130.83.99 as an address) mark what follows as DHCP options rather than plain BOOTP vendor data.');
  for (const r of m.raw) f.list.push(optionField(b, m, r));
  if (m.optionsEnd < end) {
    f.add('dhcp.pad', 'Padding', m.optionsEnd, end - m.optionsEnd, `${end - m.optionsEnd} zero bytes`, 'detail', 'BOOTP messages are at least 300 bytes long, so a short message is padded out with zeros (option 0).');
  }
  return {
    protocol: 'dhcp',
    layer: 5,
    start: o,
    headerEnd: end,
    payloadEnd: end,
    end,
    summary: dhcpSummary(m),
    fields: f.list,
  };
}
