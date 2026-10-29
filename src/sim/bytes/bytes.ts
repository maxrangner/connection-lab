/** Growable big-endian ("network byte order") byte writer. */
export class ByteWriter {
  private buf: number[] = [];

  get length(): number {
    return this.buf.length;
  }

  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    this.buf.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  u32(v: number): this {
    this.buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.buf.push((b[i] ?? 0) & 0xff);
    return this;
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.buf.push(s.charCodeAt(i) & 0xff);
    return this;
  }

  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.buf.push(0);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

export const u8 = (b: Uint8Array, off: number): number => b[off] ?? 0;
export const u16 = (b: Uint8Array, off: number): number => ((b[off] ?? 0) << 8) | (b[off + 1] ?? 0);
export const u32 = (b: Uint8Array, off: number): number =>
  (((b[off] ?? 0) << 24) | ((b[off + 1] ?? 0) << 16) | ((b[off + 2] ?? 0) << 8) | (b[off + 3] ?? 0)) >>> 0;

export function setU16(b: Uint8Array, off: number, v: number): void {
  b[off] = (v >>> 8) & 0xff;
  b[off + 1] = v & 0xff;
}

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function toAscii(b: Uint8Array, start = 0, end = b.length): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

export function hex(v: number, digits: number): string {
  return '0x' + v.toString(16).padStart(digits, '0');
}

export function hexBytes(b: Uint8Array, start = 0, end = b.length, sep = ' '): string {
  const out: string[] = [];
  for (let i = start; i < end; i++) out.push((b[i] ?? 0).toString(16).padStart(2, '0'));
  return out.join(sep);
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Printable preview of bytes: ASCII where printable, "." otherwise, escapes for CR/LF. */
export function preview(b: Uint8Array, start = 0, end = b.length, max = 80): string {
  let s = '';
  for (let i = start; i < end && s.length < max; i++) {
    const c = b[i] ?? 0;
    if (c === 0x0d) s += '\\r';
    else if (c === 0x0a) s += '\\n';
    else s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return end - start > max ? s + '…' : s;
}
