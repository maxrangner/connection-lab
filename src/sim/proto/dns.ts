import { bytesToIp, ipToBytes, type Ip4 } from '../bytes/addr';
import { ByteWriter, hex, u16, u32, u8 } from '../bytes/bytes';
import { bitField, FieldList, type Field, type LayerPdu } from './types';

export const DNS_TYPE_A = 1;
export const DNS_CLASS_IN = 1;
export const DNS_FLAGS_QUERY = 0x0100; // standard query, recursion desired
export const DNS_FLAGS_RESPONSE = 0x8180; // response, recursion desired + available, no error

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

export function buildDnsQuery(id: number, name: string): Uint8Array {
  const w = new ByteWriter().u16(id).u16(DNS_FLAGS_QUERY).u16(1).u16(0).u16(0).u16(0);
  encodeName(w, name);
  return w.u16(DNS_TYPE_A).u16(DNS_CLASS_IN).toBytes();
}

/** Response repeating the question, with answers that point back at the question name (0xc00c). */
export function buildDnsResponse(id: number, name: string, answers: DnsAnswerA[]): Uint8Array {
  const w = new ByteWriter().u16(id).u16(DNS_FLAGS_RESPONSE).u16(1).u16(answers.length).u16(0).u16(0);
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
    let s = '';
    for (let k = 1; k <= len; k++) s += String.fromCharCode(u8(b, i + k));
    labels.push(s);
    i += len + 1;
  }
  return { name: labels.join('.'), length, pointer };
}

export interface ParsedDns {
  id: number;
  flags: number;
  isResponse: boolean;
  questions: { name: string; type: number; cls: number }[];
  answers: { name: string; type: number; cls: number; ttl: number; ip?: Ip4 }[];
}

export function parseDns(b: Uint8Array, o: number): ParsedDns {
  const qd = u16(b, o + 4);
  const an = u16(b, o + 6);
  let i = o + 12;
  const questions: ParsedDns['questions'] = [];
  for (let q = 0; q < qd; q++) {
    const n = readName(b, o, i);
    i += n.length;
    questions.push({ name: n.name, type: u16(b, i), cls: u16(b, i + 2) });
    i += 4;
  }
  const answers: ParsedDns['answers'] = [];
  for (let a = 0; a < an; a++) {
    const n = readName(b, o, i);
    i += n.length;
    const type = u16(b, i);
    const rdlen = u16(b, i + 8);
    answers.push({
      name: n.name,
      type,
      cls: u16(b, i + 2),
      ttl: u32(b, i + 4),
      ip: type === DNS_TYPE_A && rdlen === 4 ? bytesToIp(b, i + 10) : undefined,
    });
    i += 10 + rdlen;
  }
  const flags = u16(b, o + 2);
  return { id: u16(b, o), flags, isResponse: (flags & 0x8000) !== 0, questions, answers };
}

function typeName(t: number): string {
  return t === DNS_TYPE_A ? 'A' : t === 28 ? 'AAAA' : String(t);
}

export function describeDns(b: Uint8Array, o: number, end: number): LayerPdu {
  const p = parseDns(b, o);
  const f = new FieldList();
  f.add('dns.id', 'Transaction ID', o, 2, hex(p.id, 4), 'key', 'Random number picked by the client. The reply must carry the same value, which is how the client matches answers to questions and rejects spoofed ones.');
  const fl = p.flags;
  f.add('dns.flags', 'Flags', o + 2, 2, `${hex(fl, 4)} (${p.isResponse ? 'standard response, no error' : 'standard query'})`, 'key', p.isResponse
    ? '0x8180: this is a response (QR=1), recursion was desired and is available, and the result code is 0 (no error).'
    : '0x0100: a standard query (QR=0) with Recursion Desired, asking the resolver to do the full lookup on our behalf.', {
    children: [
      bitField('dns.flags.qr', 'QR', o + 2, 2, 0, 1, (fl >>> 15) & 1, 'detail', '0 = query, 1 = response.'),
      bitField('dns.flags.opcode', 'Opcode', o + 2, 2, 1, 4, (fl >>> 11) & 0xf, 'detail', '0 = standard query.'),
      bitField('dns.flags.aa', 'Authoritative', o + 2, 2, 5, 1, (fl >>> 10) & 1, 'detail', '1 if the answer comes from the server responsible for the domain. A caching resolver answers with 0.'),
      bitField('dns.flags.tc', 'Truncated', o + 2, 2, 6, 1, (fl >>> 9) & 1, 'detail', '1 if the answer did not fit in this UDP packet; the client would then retry over TCP.'),
      bitField('dns.flags.rd', 'Recursion desired', o + 2, 2, 7, 1, (fl >>> 8) & 1, 'detail', 'Client asks the resolver to chase the answer through the DNS hierarchy for it.'),
      bitField('dns.flags.ra', 'Recursion available', o + 2, 2, 8, 1, (fl >>> 7) & 1, 'detail', 'The server offers recursive lookups.'),
      bitField('dns.flags.z', 'Reserved / AD / CD', o + 2, 2, 9, 3, (fl >>> 4) & 7, 'detail', 'Reserved bit plus DNSSEC flags (authentic data, checking disabled).'),
      bitField('dns.flags.rcode', 'Response code', o + 2, 2, 12, 4, fl & 0xf, 'detail', '0 = no error, 3 = name does not exist.'),
    ],
  });
  f.add('dns.qdcount', 'Questions', o + 4, 2, u16(b, o + 4), 'detail', 'Number of entries in the question section.');
  f.add('dns.ancount', 'Answer RRs', o + 6, 2, u16(b, o + 6), p.isResponse ? 'key' : 'detail', 'Number of resource records in the answer section.');
  f.add('dns.nscount', 'Authority RRs', o + 8, 2, u16(b, o + 8), 'detail', 'Records naming authoritative servers; empty here.');
  f.add('dns.arcount', 'Additional RRs', o + 10, 2, u16(b, o + 10), 'detail', 'Extra records (for example EDNS options); empty here.');
  let i = o + 12;
  for (const q of p.questions) {
    const n = readName(b, o, i);
    const start = i;
    i += n.length;
    f.add('dns.question', 'Question', start, n.length + 4, `${q.name} ${typeName(q.type)} IN`, 'key', 'The name being looked up and the record type wanted. "A" asks for IPv4 addresses.', {
      children: [
        { key: 'dns.qname', name: 'Name', offset: start, length: n.length, display: `${q.name} (length-prefixed labels)`, importance: 'detail', explain: 'Each label is preceded by its length and the name ends with a zero byte: 7 "example" 3 "com" 0.' },
        { key: 'dns.qtype', name: 'Type', offset: i, length: 2, display: `${q.type} (${typeName(q.type)})`, importance: 'detail', explain: 'Record type requested. 1 = A (IPv4 address).' },
        { key: 'dns.qclass', name: 'Class', offset: i + 2, length: 2, display: `${q.cls} (IN)`, importance: 'detail', explain: 'Class 1 = Internet.' },
      ],
    });
    i += 4;
  }
  for (const a of p.answers) {
    const n = readName(b, o, i);
    const start = i;
    i += n.length;
    const rdlen = u16(b, i + 8);
    const children: Field[] = [
      { key: 'dns.rr.name', name: 'Name', offset: start, length: n.length, display: n.pointer !== undefined ? `${a.name} (pointer ${hex(0xc000 | n.pointer, 4)})` : a.name, importance: 'detail', explain: 'Name compression: 0xc00c points back to offset 12, where the question already spelled out the name.' },
      { key: 'dns.rr.type', name: 'Type', offset: i, length: 2, display: `${a.type} (${typeName(a.type)})`, importance: 'detail', explain: 'Record type.' },
      { key: 'dns.rr.class', name: 'Class', offset: i + 2, length: 2, display: `${a.cls} (IN)`, importance: 'detail', explain: 'Internet class.' },
      { key: 'dns.rr.ttl', name: 'TTL', offset: i + 4, length: 4, display: `${a.ttl} s`, importance: 'detail', explain: 'How long this answer may be cached. A resolver answering from its cache sends the remaining time.' },
      { key: 'dns.rr.rdlength', name: 'Data length', offset: i + 8, length: 2, display: String(rdlen), importance: 'detail', explain: 'Length of the record data: 4 bytes for an IPv4 address.' },
      { key: 'dns.rr.addr', name: 'Address', offset: i + 10, length: rdlen, display: a.ip ?? '?', importance: 'key', explain: 'The answer: an IPv4 address where example.com can be reached.' },
    ];
    f.add('dns.answer', 'Answer', start, n.length + 10 + rdlen, `${a.name} ${typeName(a.type)} ${a.ip ?? ''} (TTL ${a.ttl} s)`, 'key', 'One resource record. Large sites often return several addresses; clients usually try the first.', { children });
    i += 10 + rdlen;
  }
  const q = p.questions[0];
  return {
    protocol: 'dns',
    layer: 5,
    start: o,
    headerEnd: end,
    payloadEnd: end,
    end,
    summary: p.isResponse
      ? `DNS response ${hex(p.id, 4)}: ${q?.name ?? ''} A ${p.answers.map((a) => a.ip).join(', ')}`
      : `DNS query ${hex(p.id, 4)}: ${q?.name ?? ''} A?`,
    fields: f.list,
  };
}
