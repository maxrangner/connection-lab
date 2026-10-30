/**
 * Just enough cryptography for a TLS 1.3 receiver to open real records: SHA-256, HMAC, HKDF-Expand-Label and
 * AES-128-GCM decryption. Plain TypeScript (no Web Crypto, which is asynchronous and not in every test runner),
 * checked against Node's implementation in crypto.test.ts. Not constant-time; for teaching, not for secrets.
 */

// ---------- SHA-256 (FIPS 180-4) ----------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const inner = new Uint8Array(64 + data.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i]! ^ 0x36;
    outer[i] = k[i]! ^ 0x5c;
  }
  inner.set(data, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** HKDF-Expand-Label from TLS 1.3 (RFC 8446 §7.1), for outputs up to 32 bytes and an empty context. */
export function hkdfExpandLabel(secret: Uint8Array, label: string, length: number): Uint8Array {
  const full = new TextEncoder().encode('tls13 ' + label);
  const info = new Uint8Array(2 + 1 + full.length + 1 + 1);
  info[0] = length >> 8;
  info[1] = length & 0xff;
  info[2] = full.length;
  info.set(full, 3);
  info[3 + full.length] = 0; // empty context
  info[4 + full.length] = 1; // HKDF-Expand block counter
  return hmacSha256(secret, info).slice(0, length);
}

// ---------- AES-128 (FIPS 197), encryption only: GCM never needs the inverse cipher ----------

const SBOX = (() => {
  const s = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();

const xtime = (b: number): number => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

function expandKey(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t = [w[i - 4]!, w[i - 3]!, w[i - 2]!, w[i - 1]!];
    if (i % 16 === 0) {
      t = [SBOX[t[1]!]! ^ rcon, SBOX[t[2]!]!, SBOX[t[3]!]!, SBOX[t[0]!]!];
      rcon = xtime(rcon);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j]! ^ t[j]!;
  }
  return w;
}

function encryptBlock(rk: Uint8Array, input: Uint8Array): Uint8Array {
  const s = input.slice(0, 16);
  for (let i = 0; i < 16; i++) s[i]! ^= rk[i]!;
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;
    // ShiftRows (state is column-major: s[col * 4 + row]).
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[c * 4 + r] = t[((c + r) % 4) * 4 + r]!;
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const [a0, a1, a2, a3] = [s[c * 4]!, s[c * 4 + 1]!, s[c * 4 + 2]!, s[c * 4 + 3]!];
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[c * 4] = a0 ^ all ^ xtime(a0 ^ a1);
        s[c * 4 + 1] = a1 ^ all ^ xtime(a1 ^ a2);
        s[c * 4 + 2] = a2 ^ all ^ xtime(a2 ^ a3);
        s[c * 4 + 3] = a3 ^ all ^ xtime(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) s[i]! ^= rk[round * 16 + i]!;
  }
  return s;
}

// ---------- GCM (NIST SP 800-38D) ----------

/** Multiply two 128-bit blocks in GF(2^128) with GCM's bit order. */
function gmul(x: Uint8Array, y: Uint8Array): Uint8Array {
  const z = new Uint8Array(16);
  const v = y.slice();
  for (let i = 0; i < 128; i++) {
    if ((x[i >> 3]! >> (7 - (i & 7))) & 1) for (let j = 0; j < 16; j++) z[j]! ^= v[j]!;
    const lsb = v[15]! & 1;
    for (let j = 15; j > 0; j--) v[j] = (v[j]! >> 1) | ((v[j - 1]! & 1) << 7);
    v[0] = v[0]! >> 1;
    if (lsb) v[0]! ^= 0xe1;
  }
  return z;
}

function ghash(h: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  let y: Uint8Array = new Uint8Array(16);
  const absorb = (data: Uint8Array): void => {
    for (let o = 0; o < data.length; o += 16) {
      const block = new Uint8Array(16);
      block.set(data.subarray(o, o + 16));
      for (let j = 0; j < 16; j++) y[j]! ^= block[j]!;
      y = gmul(y, h);
    }
  };
  absorb(aad);
  absorb(ct);
  const lens = new Uint8Array(16);
  const dv = new DataView(lens.buffer);
  dv.setUint32(4, aad.length * 8);
  dv.setUint32(12, ct.length * 8);
  for (let j = 0; j < 16; j++) y[j]! ^= lens[j]!;
  return gmul(y, h);
}

/** AES-128-GCM decryption with a 12-byte nonce; returns null when the tag does not match (tampered or wrong key). */
export function aes128GcmDecrypt(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ctWithTag: Uint8Array): Uint8Array | null {
  const rk = expandKey(key);
  const h = encryptBlock(rk, new Uint8Array(16));
  const ct = ctWithTag.subarray(0, ctWithTag.length - 16);
  const tag = ctWithTag.subarray(ctWithTag.length - 16);
  const j0 = new Uint8Array(16);
  j0.set(nonce);
  j0[15] = 1;
  const s = ghash(h, aad, ct);
  const ek = encryptBlock(rk, j0);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= (s[i]! ^ ek[i]!) ^ tag[i]!;
  if (diff) return null;
  const out = new Uint8Array(ct.length);
  const counter = j0.slice();
  for (let o = 0; o < ct.length; o += 16) {
    // Increment the last 32 bits of the counter block (big-endian), carrying between bytes.
    for (let i = 15; i >= 12; i--) {
      counter[i] = (counter[i]! + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
    const ks = encryptBlock(rk, counter);
    for (let i = 0; i < 16 && o + i < ct.length; i++) out[o + i] = ct[o + i]! ^ ks[i]!;
  }
  return out;
}
