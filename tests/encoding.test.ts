import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { compareBytes, crc32 } from '../src/encoding/bytes.ts';
import { decodeKey, encodeKey, prefixUpperBound } from '../src/encoding/keycodec.ts';
import { decodeRow, encodeRow } from '../src/encoding/rowcodec.ts';
import { compareValues, type Value } from '../src/types.ts';

const value: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: false }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom('', '\0', 'a\0b', 'a', 'ab', '￿', '\u{1F600}', 'é'),
);
const tuple = fc.array(value, { minLength: 1, maxLength: 4 });

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const compareTuples = (a: Value[], b: Value[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareValues(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
};
const norm = (vs: Value[]) => vs.map((v) => (Object.is(v, -0) ? 0 : v));

describe('order-preserving key encoding', () => {
  it('round-trips', () => {
    fc.assert(fc.property(tuple, (t) => {
      expect(decodeKey(encodeKey(t))).toEqual(norm(t));
    }));
  });

  it('memcmp order equals SQL order for single values', () => {
    fc.assert(
      fc.property(value, value, (a, b) => {
        expect(sign(compareBytes(encodeKey([a]), encodeKey([b])))).toBe(sign(compareValues(a, b)));
      }),
      { numRuns: 2000 },
    );
  });

  it('memcmp order equals column-by-column order for tuples of equal arity', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }).chain((n) => fc.tuple(fc.array(value, { minLength: n, maxLength: n }), fc.array(value, { minLength: n, maxLength: n }))), ([a, b]) => {
        expect(sign(compareBytes(encodeKey(a), encodeKey(b)))).toBe(sign(compareTuples(a, b)));
      }),
      { numRuns: 2000 },
    );
  });

  it('prefix upper bound is above every key with that prefix', () => {
    fc.assert(
      fc.property(tuple, value, (prefix, extra) => {
        const p = encodeKey(prefix);
        const k = encodeKey([...prefix, extra]);
        const ub = prefixUpperBound(p)!;
        expect(compareBytes(k, ub)).toBeLessThan(0);
        expect(compareBytes(p, ub)).toBeLessThan(0);
      }),
    );
  });

  it('orders numbers across integers, floats and infinities', () => {
    const nums = [-Infinity, -1e300, -2, -1.5, -0, 0, 1e-300, 1, 1.0000001, 2 ** 53, Infinity];
    const keys = nums.map((n) => encodeKey([n]));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1]!, keys[i]!)).toBeLessThanOrEqual(0);
  });
});

describe('row encoding', () => {
  it('round-trips', () => {
    fc.assert(fc.property(fc.array(value, { maxLength: 12 }), (row) => {
      expect(decodeRow(encodeRow(row))).toEqual(row);
    }));
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});
