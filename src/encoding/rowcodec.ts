/**
 * Compact row encoding used for B+ tree values.
 *
 *   varint column count, then per column a tag byte and payload:
 *   0 NULL | 1 false | 2 true | 3 int32 | 4 float64 | 5 text (varint length + UTF-8)
 */
import type { Value } from '../types.ts';
import { ByteReader, ByteWriter, utf8Decoder, utf8Encoder } from './bytes.ts';

const T_NULL = 0;
const T_FALSE = 1;
const T_TRUE = 2;
const T_INT32 = 3;
const T_F64 = 4;
const T_TEXT = 5;

export function encodeRow(values: readonly Value[]): Uint8Array {
  const w = new ByteWriter(32);
  w.varint(values.length);
  for (const v of values) {
    if (v === null) w.u8(T_NULL);
    else if (v === false) w.u8(T_FALSE);
    else if (v === true) w.u8(T_TRUE);
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff && !Object.is(v, -0)) {
        w.u8(T_INT32);
        w.i32(v);
      } else {
        w.u8(T_F64);
        w.f64(v);
      }
    } else {
      const b = utf8Encoder.encode(v);
      w.u8(T_TEXT);
      w.varint(b.length);
      w.bytes(b);
    }
  }
  return w.finish();
}

export function decodeRow(bytes: Uint8Array): Value[] {
  const r = new ByteReader(bytes);
  const n = r.varint();
  const out: Value[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const tag = r.u8();
    switch (tag) {
      case T_NULL: out[i] = null; break;
      case T_FALSE: out[i] = false; break;
      case T_TRUE: out[i] = true; break;
      case T_INT32: out[i] = r.i32(); break;
      case T_F64: out[i] = r.f64(); break;
      case T_TEXT: out[i] = utf8Decoder.decode(r.bytes(r.varint())); break;
      default: throw new Error(`corrupt row: unknown tag ${tag}`);
    }
  }
  return out;
}
