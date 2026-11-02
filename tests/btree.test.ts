import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BTree } from '../src/storage/btree.ts';
import { MemoryFile } from '../src/storage/file.ts';
import { Pager } from '../src/storage/pager.ts';
import { compareBytes } from '../src/encoding/bytes.ts';
import { decodeKey, encodeKey } from '../src/encoding/keycodec.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function freshTree(pageSize = 512) {
  const pager = new Pager(new MemoryFile(), new MemoryFile(), { pageSize, cacheSize: 64, checkpointFrames: 50 });
  pager.begin();
  const root = BTree.create(pager);
  pager.commit();
  return { pager, tree: new BTree(pager, root) };
}

const key = (n: number) => encodeKey([n]);
const val = (s: string) => new TextEncoder().encode(s);

describe('B+ tree', () => {
  it('inserts, finds and scans in order across many splits', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    const ids = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 3000);
    for (const i of ids) expect(tree.insert(key(i), val(`v${i}`))).toBe(true);
    pager.commit();
    const info = tree.check();
    expect(info.entries).toBe(3000);
    expect(info.depth).toBeGreaterThan(2);
    expect(new TextDecoder().decode(tree.get(key(1234))!)).toBe('v1234');
    const scanned = [...tree.scan()].map(([k]) => k);
    for (let i = 1; i < scanned.length; i++) expect(compareBytes(scanned[i - 1]!, scanned[i]!)).toBeLessThan(0);
  });

  it('rejects duplicate keys unless upserting', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    expect(tree.insert(key(1), val('a'))).toBe(true);
    expect(tree.insert(key(1), val('b'))).toBe(false);
    expect(new TextDecoder().decode(tree.get(key(1))!)).toBe('a');
    expect(tree.insert(key(1), val('c'), true)).toBe(false);
    expect(new TextDecoder().decode(tree.get(key(1))!)).toBe('c');
    pager.commit();
  });

  it('supports bounded and reverse range scans', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    for (let i = 0; i < 500; i++) tree.insert(key(i), val(String(i)));
    pager.commit();
    const nums = (it: Iterable<[Uint8Array, Uint8Array]>) => [...it].map(([, v]) => Number(new TextDecoder().decode(v)));
    expect(nums(tree.scan({ lo: key(100), hi: key(105) }))).toEqual([100, 101, 102, 103, 104, 105]);
    expect(nums(tree.scan({ lo: key(100), loExclusive: true, hi: key(105), hiExclusive: true }))).toEqual([101, 102, 103, 104]);
    expect(nums(tree.scan({ lo: key(495), reverse: true }))).toEqual([499, 498, 497, 496, 495]);
    expect(nums(tree.scan({ hi: key(3), hiExclusive: true, reverse: true }))).toEqual([2, 1, 0]);
    expect(nums(tree.scan({ lo: key(1000) }))).toEqual([]);
  });

  it('stores large values in overflow pages and frees them', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    const big = new Uint8Array(5000).map((_, i) => i % 251);
    tree.insert(key(1), big);
    tree.insert(key(2), val('small'));
    pager.commit();
    expect(hex(tree.get(key(1))!)).toBe(hex(big));
    const before = pager.getStats().freePages;
    pager.begin();
    tree.delete(key(1));
    pager.commit();
    expect(pager.getStats().freePages).toBeGreaterThan(before + 5);
  });

  it('merges nodes on delete and collapses the root', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    for (let i = 0; i < 2000; i++) tree.insert(key(i), val('x'.repeat(20)));
    pager.commit();
    const grown = tree.check();
    pager.begin();
    for (let i = 0; i < 1990; i++) tree.delete(key(i));
    pager.commit();
    const shrunk = tree.check();
    expect(shrunk.entries).toBe(10);
    expect(shrunk.pages).toBeLessThan(grown.pages / 20);
    expect(shrunk.depth).toBeLessThanOrEqual(2);
  });

  it('cursors survive modification of the tree mid-scan', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    for (let i = 0; i < 1000; i++) tree.insert(key(i * 2), val('even'));
    const seen: number[] = [];
    for (const [k] of tree.scan()) {
      const n = decodeKey(k)[0] as number;
      seen.push(n);
      // Delete the key right after the cursor and insert one behind it.
      tree.delete(key(n + 2));
      tree.insert(key(-1 - seen.length), val('behind'));
    }
    pager.commit();
    tree.check();
    expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => i * 4));
  });

  it('rolls back every page change on abort', () => {
    const { pager, tree } = freshTree();
    pager.begin();
    for (let i = 0; i < 300; i++) tree.insert(key(i), val('keep'));
    pager.commit();
    const pagesBefore = pager.getStats().pageCount;
    pager.begin();
    for (let i = 300; i < 2000; i++) tree.insert(key(i), val('drop'));
    for (let i = 0; i < 100; i++) tree.delete(key(i));
    pager.rollback();
    expect(tree.check().entries).toBe(300);
    expect(pager.getStats().pageCount).toBe(pagesBefore);
    expect(tree.get(key(0))).not.toBeNull();
  });

  it('matches a sorted-map model under random operations (property test)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.constantFrom('ins', 'del', 'upsert'), fc.integer({ min: 0, max: 400 }), fc.integer({ min: 0, max: 300 })),
          { maxLength: 600 },
        ),
        (ops) => {
          const { pager, tree } = freshTree(256);
          const model = new Map<number, number>();
          pager.begin();
          for (const [op, k, len] of ops) {
            const v = new Uint8Array(len).fill(k % 256);
            if (op === 'ins') {
              const added = tree.insert(key(k), v);
              expect(added).toBe(!model.has(k));
              if (added) model.set(k, len);
            } else if (op === 'upsert') {
              tree.insert(key(k), v, true);
              model.set(k, len);
            } else {
              expect(tree.delete(key(k))).toBe(model.delete(k));
            }
          }
          pager.commit();
          tree.check();
          const expected = [...model.entries()].sort((a, b) => a[0] - b[0]);
          const actual = [...tree.scan()].map(([k, v]) => [hex(k), v.length]);
          expect(actual).toEqual(expected.map(([k, len]) => [hex(key(k)), len]));
        },
      ),
      { numRuns: 60 },
    );
  });
});
