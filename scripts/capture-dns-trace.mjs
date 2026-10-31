// Captures a real iterative DNS lookup for each site the scenario knows, the way `dig +trace` does it: one plain
// UDP question (type A, RD=0, no EDNS) to a root server, then to the TLD server it refers us to, then to the site's
// own name server, until one of them answers. Every query and response is saved byte for byte, with the round-trip
// time of each hop, so the sim's cold resolver can replay the real walk root → TLD → authoritative.
// Usage: node scripts/capture-dns-trace.mjs
// Writes src/sim/scenarios/dnsTraceCapture.ts and tests/fixtures/dns-trace-<host>.json.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const HOSTS = ['example.com', 'info.cern.ch', 'httpbin.org'];
const ROOT = { name: 'a.root-servers.net', ip: '198.41.0.4' };
const MAX_HOPS = 5;
const TIMEOUT_MS = 3000;
const ATTEMPTS = 2;

const TYPE_A = 1;
const TYPE_NS = 2;
const TYPE_CNAME = 5;
const TYPE_AAAA = 28;

/** A question the way a resolver asks it: fresh id, RD=0 (we do the recursion ourselves), one A question, no EDNS. */
function buildQuery(id, name) {
  const labels = name.split('.').filter(Boolean).flatMap((l) => [l.length, ...Buffer.from(l, 'ascii')]);
  return Buffer.from([id >> 8, id & 0xff, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, TYPE_A, 0, 1]);
}

function readName(b, off) {
  const labels = [];
  let i = off;
  let length = -1;
  for (let guard = 0; guard < 64; guard++) {
    const len = b[i];
    if (len === 0) {
      if (length < 0) length = i + 1 - off;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (length < 0) length = i + 2 - off;
      i = ((len & 0x3f) << 8) | b[i + 1];
      continue;
    }
    labels.push(b.toString('ascii', i + 1, i + 1 + len));
    i += len + 1;
  }
  return { name: labels.join('.'), length };
}

function parse(b) {
  const counts = [4, 6, 8, 10].map((o) => b.readUInt16BE(o));
  let i = 12;
  const questions = [];
  for (let q = 0; q < counts[0]; q++) {
    const n = readName(b, i);
    i += n.length;
    questions.push({ name: n.name, type: b.readUInt16BE(i) });
    i += 4;
  }
  const sections = [];
  for (const count of counts.slice(1)) {
    const rrs = [];
    for (let k = 0; k < count; k++) {
      const n = readName(b, i);
      i += n.length;
      const type = b.readUInt16BE(i);
      const ttl = b.readUInt32BE(i + 4);
      const rdlen = b.readUInt16BE(i + 8);
      const rr = { name: n.name, type, ttl };
      if (type === TYPE_A && rdlen === 4) rr.ip = [...b.subarray(i + 10, i + 14)].join('.');
      if (type === TYPE_NS || type === TYPE_CNAME) rr.target = readName(b, i + 10).name;
      if (type === TYPE_AAAA) rr.ip6 = b.subarray(i + 10, i + 26).toString('hex');
      rrs.push(rr);
      i += 10 + rdlen;
    }
    sections.push(rrs);
  }
  const flags = b.readUInt16BE(2);
  return { id: b.readUInt16BE(0), flags, tc: (flags & 0x200) !== 0, rcode: flags & 0xf, questions, answers: sections[0], authority: sections[1], additional: sections[2] };
}

/** One question to one server over UDP: the raw reply and how long it took. */
function ask(server, query) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let attempt = 0;
    let timer;
    let sentAt = 0;
    const send = () => {
      attempt++;
      sentAt = performance.now();
      sock.send(query, 53, server.ip);
      timer = setTimeout(() => {
        if (attempt < ATTEMPTS) send();
        else {
          sock.close();
          reject(new Error(`${server.name} (${server.ip}) did not answer`));
        }
      }, TIMEOUT_MS);
    };
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== server.ip || msg.readUInt16BE(0) !== query.readUInt16BE(0)) return;
      clearTimeout(timer);
      sock.close();
      resolve({ response: msg, rttMs: performance.now() - sentAt });
    });
    sock.on('error', reject);
    send();
  });
}

/** Walks the hierarchy for one name: a list of hops, each with the server asked and the real bytes both ways. */
async function trace(host) {
  const hops = [];
  const notes = [];
  let server = ROOT;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const query = buildQuery(crypto.randomInt(0x10000), host);
    const { response, rttMs } = await ask(server, query);
    const msg = parse(response);
    hops.push({ server, query: query.toString('base64'), response: response.toString('base64'), rttMs: Math.round(rttMs * 10) / 10 });
    const what = msg.answers.length ? `answer ${msg.answers.map((a) => a.ip ?? a.target).join(', ')}` : `referral ${msg.authority[0]?.name ?? '?'} NS ×${msg.authority.length}`;
    console.log(`  ${host} @ ${server.name} (${server.ip}): ${response.length} bytes, ${rttMs.toFixed(1)} ms: ${what}${msg.tc ? ' [truncated]' : ''}`);
    if (msg.tc) notes.push(`the reply from ${server.name} was truncated (TC)`);
    if (msg.rcode !== 0) throw new Error(`${server.name} answered rcode ${msg.rcode} for ${host}`);
    if (msg.answers.length) return { hops, notes };
    const ns = msg.authority.filter((rr) => rr.type === TYPE_NS);
    if (!ns.length) throw new Error(`${server.name} sent neither an answer nor a referral for ${host}`);
    // The next server: the first name server the referral also gives an IPv4 address for (glue).
    let next;
    for (const rr of ns) {
      const glue = msg.additional.find((a) => a.type === TYPE_A && a.name.toLowerCase() === rr.target.toLowerCase());
      if (glue) {
        next = { name: rr.target, ip: glue.ip };
        break;
      }
    }
    if (!next) {
      // No glue: a real resolver would now look the server's name up itself; we ask the system resolver.
      const name = ns[0].target;
      const [ip] = await dns.resolve4(name);
      next = { name, ip };
      notes.push(`the referral from ${server.name} came without glue; ${name} was resolved with the system resolver (${ip})`);
    }
    server = next;
  }
  throw new Error(`${host}: no answer after ${MAX_HOPS} hops`);
}

const traces = {};
const allNotes = [];
for (const host of HOSTS) {
  console.log(host);
  try {
    const { hops, notes } = await trace(host);
    traces[host] = { hops };
    for (const n of notes) allNotes.push(`${host}: ${n}`);
    fs.writeFileSync(`tests/fixtures/dns-trace-${host}.json`, JSON.stringify({ host, capturedAt: new Date().toISOString(), hops }, null, 2));
  } catch (e) {
    console.log(`  skipped: ${e.message}`);
    allNotes.push(`${host}: not captured (${e.message})`);
  }
}

const capturedAt = new Date().toISOString();
const ts = `// AUTO-GENERATED by scripts/capture-dns-trace.mjs — do not edit by hand.
// Real DNS walks captured on ${capturedAt}: for each site one plain A question (RD=0, no EDNS) to a root server,
// then to the TLD server and the site's own name server it was referred to, with every query and reply byte for byte.
${allNotes.map((n) => `// Note: ${n}\n`).join('')}
export const CAPTURED_AT = ${JSON.stringify(capturedAt)};

export interface DnsTraceHop {
  /** The server asked at this hop: its name and the IPv4 address the previous referral (or the root hints) gave. */
  server: { name: string; ip: string };
  /** The exact question sent, base64. */
  query: string;
  /** The exact reply, base64: a referral (NS records plus glue addresses) or the answer. */
  response: string;
  /** Measured round-trip time to this server, in milliseconds. */
  rttMs: number;
}

export const DNS_TRACES: Record<string, { hops: DnsTraceHop[] }> = ${JSON.stringify(traces, null, 2)};
`;
fs.writeFileSync('src/sim/scenarios/dnsTraceCapture.ts', ts);
console.log(`captured ${Object.keys(traces).length} of ${HOSTS.length} traces`);
