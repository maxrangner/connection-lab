// Captures a real HTTPS (TLS 1.3) session byte for byte, plus its session secrets (like SSLKEYLOGFILE), so the sim
// can replay exactly what went over the wire and the receivers can really decrypt it.
// Usage: node scripts/capture-tls.mjs [host] [path]
// Writes src/sim/scenarios/tlsCapture_<host>.ts and tests/fixtures/<host>-tls.json.
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Duplex } from 'node:stream';

const HOST = process.argv[2] ?? 'example.com';
const PATH = process.argv[3] ?? '/';
const REQUEST =
  `GET ${PATH} HTTP/1.1\r\n` +
  `Host: ${HOST}\r\n` +
  'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0\r\n' +
  'Accept: text/html\r\n' +
  'Connection: close\r\n' +
  '\r\n';

const addrs = await dns.resolve4(HOST, { ttl: true });
const ip = addrs[0].address;
/** Everything that crossed the TCP connection, in order, by direction. */
const wire = [];
const keylog = {};
await new Promise((resolve, reject) => {
  const raw = net.connect(443, ip);
  // TLS talks to this pass-through stream; it records every byte on its way to and from the real socket.
  const tap = new Duplex({
    write(chunk, _enc, cb) {
      wire.push({ from: 'client', bytes: Buffer.from(chunk) });
      raw.write(chunk, cb);
    },
    read() {},
    final(cb) {
      raw.end();
      cb();
    },
  });
  raw.on('data', (c) => {
    wire.push({ from: 'server', bytes: Buffer.from(c) });
    tap.push(c);
  });
  raw.on('end', () => tap.push(null));
  raw.on('error', reject);
  const s = tls.connect({
    socket: tap,
    servername: HOST,
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ciphers: 'TLS_AES_128_GCM_SHA256',
    ALPNProtocols: ['http/1.1'],
  });
  s.on('keylog', (line) => {
    const [label, , secret] = line.toString().trim().split(' ');
    keylog[label] = secret;
  });
  s.on('secureConnect', () => s.write(REQUEST));
  s.on('data', () => {});
  s.on('end', () => s.end());
  s.on('close', resolve);
  s.on('error', reject);
});

// Merge consecutive chunks in the same direction into flights.
const flights = [];
for (const w of wire) {
  const last = flights[flights.length - 1];
  if (last && last.from === w.from) last.bytes = Buffer.concat([last.bytes, w.bytes]);
  else flights.push({ from: w.from, bytes: w.bytes });
}

// Decrypt every record (TLS 1.3, AES-128-GCM) to label what is inside.
const hkdfLabel = (secret, label, len) => {
  const full = Buffer.from('tls13 ' + label);
  const info = Buffer.concat([Buffer.from([len >> 8, len & 255, full.length]), full, Buffer.from([0])]);
  return crypto.createHmac('sha256', secret).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
};
const keysFor = (hex) => {
  const secret = Buffer.from(hex, 'hex');
  return { key: hkdfLabel(secret, 'key', 16), iv: hkdfLabel(secret, 'iv', 12), seq: 0 };
};
const HS = { 1: 'ClientHello', 2: 'ServerHello', 4: 'NewSessionTicket', 8: 'EncryptedExtensions', 11: 'Certificate', 15: 'CertificateVerify', 20: 'Finished' };
const records = [];
for (const dir of ['client', 'server']) {
  const stream = Buffer.concat(flights.filter((f) => f.from === dir).map((f) => f.bytes));
  const hs = keysFor(keylog[dir === 'client' ? 'CLIENT_HANDSHAKE_TRAFFIC_SECRET' : 'SERVER_HANDSHAKE_TRAFFIC_SECRET']);
  const app = keysFor(keylog[dir === 'client' ? 'CLIENT_TRAFFIC_SECRET_0' : 'SERVER_TRAFFIC_SECRET_0']);
  let keys = hs;
  let o = 0;
  while (o + 5 <= stream.length) {
    const type = stream[o];
    const len = stream.readUInt16BE(o + 3);
    const body = stream.subarray(o + 5, o + 5 + len);
    let inner;
    if (type === 22) inner = [HS[body[0]] ?? `handshake ${body[0]}`];
    else if (type === 20) inner = ['ChangeCipherSpec'];
    else if (type === 23) {
      const nonce = Buffer.from(keys.iv);
      for (let i = 0; i < 8; i++) nonce[11 - i] ^= Number((BigInt(keys.seq) >> BigInt(8 * i)) & 255n);
      const d = crypto.createDecipheriv('aes-128-gcm', keys.key, nonce);
      d.setAAD(stream.subarray(o, o + 5));
      d.setAuthTag(body.subarray(body.length - 16));
      let plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
      keys.seq++;
      let end = plain.length - 1;
      while (plain[end] === 0) end--;
      const ct = plain[end];
      plain = plain.subarray(0, end);
      if (ct === 22) {
        inner = [];
        for (let p = 0; p + 4 <= plain.length; ) {
          const t = plain[p];
          inner.push(HS[t] ?? `handshake ${t}`);
          p += 4 + plain.readUIntBE(p + 1, 3);
          if (t === 20) keys = app;
        }
      } else if (ct === 23) inner = [`HTTP ${plain.toString('latin1').split('\r\n')[0]}`];
      else if (ct === 21) inner = ['Alert close_notify'];
      else inner = [`content ${ct}`];
    }
    records.push({ from: dir, offset: o, length: 5 + len, type, inner });
    o += 5 + len;
  }
}

const name = HOST.replace(/[^a-z0-9]/gi, '_');
const at = new Date().toISOString();
const ts = `// AUTO-GENERATED by scripts/capture-tls.mjs — do not edit by hand.
// A real TLS 1.3 session with ${HOST} (${ip}) captured on ${at}: every byte both ways, and the session's
// traffic secrets (as a browser writes them to SSLKEYLOGFILE), so receivers in the sim can decrypt for real.
// Cipher suite TLS_AES_128_GCM_SHA256. The handshake secrets came from an ECDHE key exchange we cannot redo;
// keeping them is what Wireshark does with a key log file.

export const TLS_CAPTURED_AT = ${JSON.stringify(at)};
export const TLS_HOST = ${JSON.stringify(HOST)};
export const TLS_IP = ${JSON.stringify(ip)};
export const TLS_REQUEST = ${JSON.stringify(REQUEST)};

/** Who sent what, in order (base64). The client sends a flight once it has received every earlier server flight. */
export const TLS_FLIGHTS: readonly { from: 'client' | 'server'; base64: string }[] = ${JSON.stringify(flights.map((f) => ({ from: f.from, base64: f.bytes.toString('base64') })), null, 2)};

/** TLS 1.3 traffic secrets (hex) for this session. */
export const TLS_SECRETS = ${JSON.stringify(
  {
    clientHandshake: keylog.CLIENT_HANDSHAKE_TRAFFIC_SECRET,
    serverHandshake: keylog.SERVER_HANDSHAKE_TRAFFIC_SECRET,
    clientApp: keylog.CLIENT_TRAFFIC_SECRET_0,
    serverApp: keylog.SERVER_TRAFFIC_SECRET_0,
  },
  null,
  2,
)};

/** Every TLS record by direction and stream offset, with what was inside it (found by decrypting at capture time). */
export const TLS_RECORDS: readonly { from: 'client' | 'server'; offset: number; length: number; type: number; inner: string[] }[] = ${JSON.stringify(records, null, 2)};
`;
fs.writeFileSync(`src/sim/scenarios/tlsCapture_${name}.ts`, ts);
fs.writeFileSync(`tests/fixtures/${name}-tls.json`, JSON.stringify({ flights: flights.map((f) => ({ from: f.from, length: f.bytes.length })), records }, null, 2));
console.log(`captured ${flights.length} flights from ${ip}:`);
for (const f of flights) console.log(`  ${f.from} ${f.bytes.length} B`);
for (const r of records) console.log(`  ${r.from} @${r.offset} ${r.length} B type ${r.type}: ${r.inner.join(', ')}`);
