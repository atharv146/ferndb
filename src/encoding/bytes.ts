export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Lexicographic comparison of byte strings (memcmp semantics). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Returns true if `key` starts with `prefix`. */
export function hasPrefix(key: Uint8Array, prefix: Uint8Array): boolean {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (key[i] !== prefix[i]) return false;
  return true;
}

/** Growable byte buffer with big-endian helpers. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initial = 64) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v);
    this.length += 4;
  }

  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.length, v);
    this.length += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v);
    this.length += 8;
  }

  varint(v: number): void {
    while (v >= 0x80) {
      this.u8((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.u8(v);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Sequential reader over a byte array. */
export class ByteReader {
  private readonly view: DataView;
  pos: number;
  readonly buf: Uint8Array;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError('read past end of buffer');
    return this.buf[this.pos++]!;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (;;) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new RangeError('read past end of buffer');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

/** CRC-32 (IEEE 802.3), used to detect torn or corrupt WAL frames. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
