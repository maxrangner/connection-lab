import { bytesToIp, bytesToIp6, ipToBytes, type Ip4 } from '../bytes/addr';
import { ByteWriter, hex, hexBytes, toAscii, u16, u32, u8 } from '../bytes/bytes';
import { bitField, FieldList, type Field, type LayerPdu } from './types';

export const DNS_TYPE_A = 1;
export const DNS_TYPE_NS = 2;
export const DNS_TYPE_CNAME = 5;
export const DNS_TYPE_AAAA = 28;
export const DNS_TYPE_OPT = 41; // EDNS pseudo-record, only ever in the additional section
export const DNS_CLASS_IN = 1;
export const DNS_FLAGS_QUERY = 0x0100; // standard query, recursion desired
export const DNS_FLAGS_RESPONSE = 0x8180; // response, recursion desired + available; the low 4 bits carry the rcode
export const DNS_RCODE_OK = 0;
export const DNS_RCODE_SERVFAIL = 2; // the server could not find out
export const DNS_RCODE_NXDOMAIN = 3; // no such name

export interface DnsAnswerA {
  ttl: number;
  ip: Ip4;
}

function encodeName(w: ByteWriter, name: string): void {
  for (const label of name.split('.')) {
    if (!label) continue;
    w.u8(label.length).ascii(label);
  }
  w.u8(0);
}

/** A question for the A records of `name`. A stub asks with RD set; a resolver walking the hierarchy itself asks with RD=0. */
export function buildDnsQuery(id: number, name: string, rd = true): Uint8Array {
  const w = new ByteWriter().u16(id).u16(rd ? DNS_FLAGS_QUERY : 0).u16(1).u16(0).u16(0).u16(0);
  encodeName(w, name);
  return w.u16(DNS_TYPE_A).u16(DNS_CLASS_IN).toBytes();
}

/**
 * Response repeating the question, with answers that point back at the question name (0xc00c).
 * A name the server does not know gets no answers and rcode 3 (NXDOMAIN).
 */
export function buildDnsResponse(id: number, name: string, answers: DnsAnswerA[], rcode = DNS_RCODE_OK): Uint8Array {
  const w = new ByteWriter().u16(id).u16(DNS_FLAGS_RESPONSE | (rcode & 0xf)).u16(1).u16(answers.length).u16(0).u16(0);
  encodeName(w, name);
  w.u16(DNS_TYPE_A).u16(DNS_CLASS_IN);
  for (const a of answers) {
    w.u16(0xc00c).u16(DNS_TYPE_A).u16(DNS_CLASS_IN).u32(a.ttl).u16(4).bytes(ipToBytes(a.ip));
  }
  return w.toBytes();
}

interface NameRead {
  name: string;
  /** Bytes the name occupies at its position (pointer counts as 2). */
  length: number;
  pointer?: number;
}

function readName(b: Uint8Array, msgStart: number, off: number): NameRead {
  const labels: string[] = [];
  let i = off;
  let length = -1;
  let pointer: number | undefined;
  for (let guard = 0; guard < 64; guard++) {
    const len = u8(b, i);
    if (len === 0) {
      if (length < 0) length = i + 1 - off;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | u8(b, i + 1);
      if (length < 0) {
        length = i + 2 - off;
        pointer = ptr;
      }
      i = msgStart + ptr;
      continue;
    }
    labels.push(toAscii(b, i + 1, i + 1 + len));
    i += len + 1;
  }
  return { name: labels.join('.'), length, pointer };
}

/** One resource record, from any of the three record sections. */
export interface DnsRecord {
  name: string;
  type: number;
  cls: number;
  ttl: number;
  /** A record: the IPv4 address. */
  ip?: Ip4;
  /** NS or CNAME record: the name in the record data (a server name, or the name this one is an alias for). */
  target?: string;
}

/** A record as it sits in the bytes: the record plus where its parts are. */
interface RecordRead {
  rr: DnsRecord;
  name: NameRead;
  rdlen: number;
  /** Bytes from the record's name to the end of its data. */
  length: number;
}

function readRecord(b: Uint8Array, msgStart: number, off: number): RecordRead {
  const name = readName(b, msgStart, off);
  const i = off + name.length;
  const type = u16(b, i);
  const rdlen = u16(b, i + 8);
  const rr: DnsRecord = { name: name.name, type, cls: u16(b, i + 2), ttl: u32(b, i + 4) };
  if (type === DNS_TYPE_A && rdlen === 4) rr.ip = bytesToIp(b, i + 10);
  if (type === DNS_TYPE_NS || type === DNS_TYPE_CNAME) rr.target = readName(b, msgStart, i + 10).name;
  return { rr, name, rdlen, length: name.length + 10 + rdlen };
}

export interface ParsedDns {
  id: number;
  flags: number;
  isResponse: boolean;
  /** TC: the reply did not fit in the UDP packet, so records were left out. */
  truncated: boolean;
  rcode: number;
  questions: { name: string; type: number; cls: number }[];
  answers: DnsRecord[];
  /** Who is responsible for the name: in a referral, the NS records of the zone to ask next. */
  authority: DnsRecord[];
  /** Records that help with the others, mostly the addresses (glue) of the servers named in the authority section. */
  additional: DnsRecord[];
}

export function parseDns(b: Uint8Array, o: number): ParsedDns {
  const qd = u16(b, o + 4);
  let i = o + 12;
  const questions: ParsedDns['questions'] = [];
  for (let q = 0; q < qd; q++) {
    const n = readName(b, o, i);
    i += n.length;
    questions.push({ name: n.name, type: u16(b, i), cls: u16(b, i + 2) });
    i += 4;
  }
  const sections: DnsRecord[][] = [];
  for (const countOff of [6, 8, 10]) {
    const rrs: DnsRecord[] = [];
    for (let k = 0; k < u16(b, o + countOff); k++) {
      const r = readRecord(b, o, i);
      rrs.push(r.rr);
      i += r.length;
    }
    sections.push(rrs);
  }
  const flags = u16(b, o + 2);
  return {
    id: u16(b, o),
    flags,
    isResponse: (flags & 0x8000) !== 0,
    truncated: (flags & 0x0200) !== 0,
    rcode: flags & 0xf,
    questions,
    answers: sections[0]!,
    authority: sections[1]!,
    additional: sections[2]!,
  };
}

/** The IPv4 addresses a response gives for the name asked (ignoring any CNAME on the way). */
export const dnsAddresses = (p: ParsedDns): Ip4[] => p.answers.map((a) => a.ip).filter((x): x is Ip4 => !!x);

export interface DnsReferral {
  /** The zone the authority records belong to: "com" when the root says who runs .com. */
  zone: string;
  /** Its name servers in the order given, each with its IPv4 glue if the reply included one. */
  servers: { name: string; ip?: Ip4 }[];
}

/**
 * A referral is a response with no answer but NS records in the authority section: "not me, ask these servers".
 * The glue addresses in the additional section say where they are, so the resolver need not look those up too.
 */
export function dnsReferral(p: ParsedDns): DnsReferral | undefined {
  const ns = p.authority.filter((r) => r.type === DNS_TYPE_NS && r.target);
  if (!p.isResponse || p.rcode !== DNS_RCODE_OK || p.answers.length || !ns.length) return undefined;
  return {
    zone: ns[0]!.name,
    servers: ns.map((r) => ({ name: r.target!, ip: p.additional.find((a) => a.type === DNS_TYPE_A && a.name.toLowerCase() === r.target!.toLowerCase())?.ip })),
  };
}

function typeName(t: number): string {
  return t === DNS_TYPE_A ? 'A' : t === DNS_TYPE_NS ? 'NS' : t === DNS_TYPE_CNAME ? 'CNAME' : t === DNS_TYPE_AAAA ? 'AAAA' : t === DNS_TYPE_OPT ? 'OPT' : String(t);
}

function rcodeName(c: number): string {
  return c === 0 ? 'no error' : c === 3 ? 'no such name (NXDOMAIN)' : c === 2 ? 'server failure' : `error ${c}`;
}

/** The name as it sits in the bytes: each label behind its length, then a zero: 7 "example" 3 "com" 0. */
function labelsOf(name: string): string {
  return name.split('.').filter(Boolean).map((l) => `${l.length} "${l}"`).join(' ') + ' 0';
}

/** A few names from a list: "a.gtld-servers.net, b.gtld-servers.net, …". */
const someNames = (names: string[], n = 2): string => names.slice(0, n).join(', ') + (names.length > n ? ', …' : '');

/** A referral's summary and the next step it means: who to ask about the zone. */
export function dnsSummary(p: ParsedDns): string {
  const q = p.questions[0]?.name ?? '';
  if (!p.isResponse) return `DNS query ${hex(p.id, 4)}: ${q} A?`;
  const ref = dnsReferral(p);
  if (ref) return `DNS referral ${hex(p.id, 4)}: ${q} → ${ref.zone} NS ${someNames(ref.servers.map((s) => s.name))}`;
  const ips = dnsAddresses(p);
  return `DNS response ${hex(p.id, 4)}: ${q} A ${p.rcode ? rcodeName(p.rcode) : ips.length ? ips.join(', ') : '(no address)'}`;
}

export function describeDns(b: Uint8Array, o: number, end: number): LayerPdu {
  const p = parseDns(b, o);
  const referral = dnsReferral(p);
  const f = new FieldList();
  f.add('dns.id', 'Transaction ID', o, 2, hex(p.id, 4), 'key', 'Random number picked by the client. The reply must carry the same value, which is how the client matches answers to questions and rejects spoofed ones.');
  const fl = p.flags;
  const rd = (fl >>> 8) & 1;
  const ra = (fl >>> 7) & 1;
  const aa = (fl >>> 10) & 1;
  f.add('dns.flags', 'Flags', o + 2, 2, `${hex(fl, 4)} (${p.isResponse ? `${referral ? 'referral' : aa ? 'authoritative response' : 'standard response'}, ${rcodeName(p.rcode)}${p.truncated ? ', truncated' : ''}` : 'standard query'})`, 'key', p.isResponse
    ? `${hex(fl, 4)}: this is a response (QR=1)${aa ? ' from a server responsible for the name (AA=1)' : ''}, recursion was ${rd ? '' : 'not '}desired and is ${ra ? '' : 'not '}available, and the result code is ${p.rcode} (${rcodeName(p.rcode)}).${p.truncated ? ' TC=1: not everything fit in this UDP packet; some records were left out.' : ''}${referral ? ' No answer: the authority section names the servers to ask next.' : ''}`
    : `${hex(fl, 4)}: a standard query (QR=0) ${rd ? 'with' : 'without'} Recursion Desired${rd ? ', asking the resolver to do the full lookup on our behalf' : ': the asker will follow referrals itself, as a resolver does'}.`, {
    children: [
      bitField('dns.flags.qr', 'QR', o + 2, 2, 0, 1, (fl >>> 15) & 1, 'detail', '0 = query, 1 = response.'),
      bitField('dns.flags.opcode', 'Opcode', o + 2, 2, 1, 4, (fl >>> 11) & 0xf, 'detail', '0 = standard query.'),
      bitField('dns.flags.aa', 'Authoritative', o + 2, 2, 5, 1, aa, 'detail', '1 if the answer comes from the server responsible for the domain. A caching resolver, or a server referring you elsewhere, answers with 0.'),
      bitField('dns.flags.tc', 'Truncated', o + 2, 2, 6, 1, (fl >>> 9) & 1, 'detail', '1 if the answer did not fit in this UDP packet; the client would then retry over TCP.'),
      bitField('dns.flags.rd', 'Recursion desired', o + 2, 2, 7, 1, rd, 'detail', 'Client asks the resolver to chase the answer through the DNS hierarchy for it. A resolver doing the chasing itself leaves it 0.'),
      bitField('dns.flags.ra', 'Recursion available', o + 2, 2, 8, 1, ra, 'detail', 'The server offers recursive lookups. Root, TLD and authoritative servers do not.'),
      bitField('dns.flags.z', 'Reserved / AD / CD', o + 2, 2, 9, 3, (fl >>> 4) & 7, 'detail', 'Reserved bit plus DNSSEC flags (authentic data, checking disabled).'),
      bitField('dns.flags.rcode', 'Response code', o + 2, 2, 12, 4, fl & 0xf, 'detail', '0 = no error, 2 = server failure, 3 = name does not exist.'),
    ],
  });
  f.add('dns.qdcount', 'Questions', o + 4, 2, u16(b, o + 4), 'detail', 'Number of entries in the question section.');
  f.add('dns.ancount', 'Answer RRs', o + 6, 2, u16(b, o + 6), p.isResponse && !referral ? 'key' : 'detail', 'Number of resource records in the answer section. A referral has none.');
  f.add('dns.nscount', 'Authority RRs', o + 8, 2, u16(b, o + 8), referral ? 'key' : 'detail', 'Records naming the servers responsible for the name. A referral puts the servers to ask next here.');
  f.add('dns.arcount', 'Additional RRs', o + 10, 2, u16(b, o + 10), 'detail', 'Extra records that help with the others: the addresses (glue) of the servers named in the authority section, or EDNS options.');
  let i = o + 12;
  for (const q of p.questions) {
    const n = readName(b, o, i);
    const start = i;
    i += n.length;
    f.add('dns.question', 'Question', start, n.length + 4, `${q.name} ${typeName(q.type)} IN`, 'key', 'The name being looked up and the record type wanted. "A" asks for IPv4 addresses.', {
      children: [
        { key: 'dns.qname', name: 'Name', offset: start, length: n.length, display: `${q.name} (length-prefixed labels)`, importance: 'detail', explain: `Each label is preceded by its length and the name ends with a zero byte: ${labelsOf(q.name)}.` },
        { key: 'dns.qtype', name: 'Type', offset: i, length: 2, display: `${q.type} (${typeName(q.type)})`, importance: 'detail', explain: 'Record type requested. 1 = A (IPv4 address).' },
        { key: 'dns.qclass', name: 'Class', offset: i + 2, length: 2, display: `${q.cls} (IN)`, importance: 'detail', explain: 'Class 1 = Internet.' },
      ],
    });
    i += 4;
  }
  // The three record sections share one layout; what differs is why each record is there.
  const sections: { key: string; name: string; count: number; importance: (rr: DnsRecord) => 'key' | 'detail'; explain: string }[] = [
    { key: 'dns.answer', name: 'Answer', count: p.answers.length, importance: () => 'key', explain: 'One resource record answering the question. Large sites often return several addresses; clients usually try the first. A CNAME says the name is an alias; the address follows under the real name.' },
    { key: 'dns.authority', name: 'Authority', count: p.authority.length, importance: (rr) => (rr.type === DNS_TYPE_NS ? 'key' : 'detail'), explain: referral ? 'A name server of the zone this server hands the question on to: "not me, ask one of these".' : 'A name server responsible for the zone the answer came from.' },
    { key: 'dns.additional', name: 'Additional (glue)', count: p.additional.length, importance: (rr) => (rr.type === DNS_TYPE_A ? 'key' : 'detail'), explain: 'Where to find a server named in the authority section, so the asker need not look that up first. Without this glue a lookup of "a.gtld-servers.net" would itself need the .net servers.' },
  ];
  for (const s of sections) {
    for (let k = 0; k < s.count; k++) {
      const r = readRecord(b, o, i);
      const { rr, name: n, rdlen } = r;
      const start = i;
      const h = i + n.length;
      const data = h + 10;
      const value = rr.type === DNS_TYPE_AAAA && rdlen === 16 ? bytesToIp6(b, data) : (rr.ip ?? rr.target ?? hexBytes(b, data, data + rdlen));
      const opt = rr.type === DNS_TYPE_OPT;
      const children: Field[] = [
        { key: 'dns.rr.name', name: 'Name', offset: start, length: n.length, display: n.pointer !== undefined ? `${rr.name || '<root>'} (pointer ${hex(0xc000 | n.pointer, 4)})` : rr.name || '<root>', importance: 'detail', explain: n.pointer !== undefined ? `Name compression: ${hex(0xc000 | n.pointer, 4)} points back to offset ${n.pointer}, where the name was already spelled out.` : 'The name this record is about, spelled out as length-prefixed labels.' },
        { key: 'dns.rr.type', name: 'Type', offset: h, length: 2, display: `${rr.type} (${typeName(rr.type)})`, importance: 'detail', explain: 'Record type: 1 = A (IPv4 address), 2 = NS (name server), 5 = CNAME (alias), 28 = AAAA (IPv6 address), 41 = OPT (EDNS).' },
        { key: 'dns.rr.class', name: opt ? 'UDP payload size' : 'Class', offset: h + 2, length: 2, display: opt ? String(rr.cls) : `${rr.cls} (IN)`, importance: 'detail', explain: opt ? 'In an OPT record this field says how big a UDP reply the sender can take.' : 'Internet class.' },
        { key: 'dns.rr.ttl', name: opt ? 'Extended rcode and flags' : 'TTL', offset: h + 4, length: 4, display: opt ? hex(rr.ttl, 8) : `${rr.ttl} s`, importance: 'detail', explain: opt ? 'In an OPT record these bytes carry the upper rcode bits, the EDNS version and the DNSSEC OK bit.' : 'How long this record may be cached. A resolver answering from its cache sends the remaining time.' },
        { key: 'dns.rr.rdlength', name: 'Data length', offset: h + 8, length: 2, display: String(rdlen), importance: 'detail', explain: `Length of the record data: 4 bytes for an IPv4 address, 16 for IPv6, a compressed name for NS and CNAME.` },
        rr.type === DNS_TYPE_NS
          ? { key: 'dns.rr.ns', name: 'Name server', offset: data, length: rdlen, display: value, importance: 'key', explain: `A server that holds the records of ${rr.name || 'the root'}. Names in record data may be compressed too.` }
          : rr.type === DNS_TYPE_CNAME
            ? { key: 'dns.rr.cname', name: 'Alias of', offset: data, length: rdlen, display: value, importance: 'key', explain: `${rr.name} is another name for ${value}; the address records that follow belong to that name.` }
            : rr.type === DNS_TYPE_AAAA
              ? { key: 'dns.rr.addr6', name: 'IPv6 address', offset: data, length: rdlen, display: value, importance: 'detail', explain: `An IPv6 address where ${rr.name} can be reached; this network only uses IPv4.` }
              : rr.type === DNS_TYPE_A
                ? { key: 'dns.rr.addr', name: 'Address', offset: data, length: rdlen, display: value, importance: 'key', explain: `An IPv4 address where ${rr.name} can be reached.` }
                : { key: 'dns.rr.data', name: 'Data', offset: data, length: rdlen, display: value || '(empty)', importance: 'detail', explain: opt ? 'EDNS options, if any: a way to say more than the original 1987 header allows.' : `The record data for type ${rr.type}, shown as hex.` },
      ];
      f.add(s.key, s.name, start, r.length, `${rr.name || '<root>'} ${typeName(rr.type)} ${value}${opt ? '' : ` (TTL ${rr.ttl} s)`}`, s.importance(rr), s.explain, { children });
      i += r.length;
    }
  }
  return {
    protocol: 'dns',
    layer: 5,
    start: o,
    headerEnd: end,
    payloadEnd: end,
    end,
    summary: dnsSummary(p),
    fields: f.list,
  };
}
