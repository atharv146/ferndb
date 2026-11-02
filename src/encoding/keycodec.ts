/**
 * Order-preserving ("memcomparable") key encoding.
 *
 * Any tuple of values is encoded to bytes such that comparing the bytes with
 * memcmp gives the same answer as comparing the tuples column by column.
 * This lets the B+ tree treat every key as an opaque byte string, while still
 * supporting composite keys, range scans and prefix scans.
 *
 *   NULL     0x05
 *   BOOLEAN  0x10 then 0x00 / 0x01
 *   number   0x20 then 8 bytes: IEEE-754 big-endian with the sign bit flipped
 *            for positives and every bit flipped for negatives
 *   TEXT     0x30 then UTF-8 with 0x00 escaped as 0x00 0xFF, ending in 0x00 0x00
 *
 * Every component is self-delimiting, so concatenating them preserves order.
 */
import type { Value } from '../types.ts';
import { ByteReader, ByteWriter, utf8Decoder, utf8Encoder } from './bytes.ts';

const TAG_NULL = 0x05;
const TAG_BOOL = 0x10;
const TAG_NUM = 0x20;
const TAG_TEXT = 0x30;

const scratch = new DataView(new ArrayBuffer(8));

function writeNumber(w: ByteWriter, n: number): void {
  if (Number.isNaN(n)) throw new RangeError('NaN cannot be stored in a key');
  scratch.setFloat64(0, n === 0 ? 0 : n); // normalise -0 to 0
  const negative = (scratch.getUint8(0) & 0x80) !== 0;
  for (let i = 0; i < 8; i++) {
    const b = scratch.getUint8(i);
    w.u8(negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b);
  }
}

function readNumber(r: ByteReader): number {
  const raw = r.bytes(8);
  const negative = (raw[0]! & 0x80) === 0;
  for (let i = 0; i < 8; i++) {
    const b = raw[i]!;
    scratch.setUint8(i, negative ? ~b & 0xff : i === 0 ? b ^ 0x80 : b);
  }
  return scratch.getFloat64(0);
}

export function writeKeyValue(w: ByteWriter, v: Value): void {
  if (v === null) {
    w.u8(TAG_NULL);
  } else if (typeof v === 'boolean') {
    w.u8(TAG_BOOL);
    w.u8(v ? 1 : 0);
  } else if (typeof v === 'number') {
    w.u8(TAG_NUM);
    writeNumber(w, v);
  } else {
    w.u8(TAG_TEXT);
    for (const b of utf8Encoder.encode(v)) {
      w.u8(b);
      if (b === 0) w.u8(0xff);
    }
    w.u8(0);
    w.u8(0);
  }
}

export function encodeKey(values: readonly Value[]): Uint8Array {
  const w = new ByteWriter(16);
  for (const v of values) writeKeyValue(w, v);
  return w.finish();
}

export function decodeKey(bytes: Uint8Array): Value[] {
  const r = new ByteReader(bytes);
  const out: Value[] = [];
  while (!r.done) {
    const tag = r.u8();
    switch (tag) {
      case TAG_NULL:
        out.push(null);
        break;
      case TAG_BOOL:
        out.push(r.u8() === 1);
        break;
      case TAG_NUM:
        out.push(readNumber(r));
        break;
      case TAG_TEXT: {
        const raw: number[] = [];
        for (;;) {
          const b = r.u8();
          if (b !== 0) {
            raw.push(b);
            continue;
          }
          const next = r.u8();
          if (next === 0) break;
          raw.push(0); // escaped 0x00 0xFF
        }
        out.push(utf8Decoder.decode(new Uint8Array(raw)));
        break;
      }
      default:
        throw new Error(`corrupt key: unknown tag 0x${tag.toString(16)}`);
    }
  }
  return out;
}

/**
 * Smallest byte string greater than every string with the given prefix,
 * or null if no such bound exists (prefix is all 0xFF).
 */
export function prefixUpperBound(prefix: Uint8Array): Uint8Array | null {
  const out = prefix.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 0xff) {
      out[i]!++;
      return out.subarray(0, i + 1);
    }
  }
  return null;
}
