/**
 * A B+ tree over fixed-size pages, mapping byte-string keys to byte-string
 * values. Every table and every index in FernDB is one of these trees.
 *
 * - Keys are compared with memcmp; the key encoding (keycodec.ts) makes that
 *   match SQL ordering.
 * - Nodes split by *bytes*, not by key count, so variable-length keys pack
 *   pages tightly. Any single cell is capped at a quarter page, which
 *   guarantees both halves of a split fit.
 * - Values too large to sit in a leaf spill into a chain of overflow pages.
 * - The root page id never changes: when the root splits its contents move to
 *   a fresh page, and when it shrinks to one child that child moves back up.
 *   The catalog can therefore store root ids without ever updating them.
 * - Sequential appends split off only the new key, keeping pages full.
 * - Deletes merge an underfull node into its sibling when the two fit in one
 *   page (no redistribution).
 * - Cursors are re-seekable: if the tree changes while a scan is suspended,
 *   the scan re-descends from the root just past the last key it returned.
 *
 * Leaf page:     kind=1 u8 | count u16 | next-leaf u32 | cells...
 *   cell:        keyLen u16 | key | 0 u8 | valLen u16 | val
 *            or  keyLen u16 | key | 1 u8 | totalLen u32 | firstOverflowPage u32
 * Internal page: kind=2 u8 | count u16 | child0 u32 | (keyLen u16 | key | child u32)...
 * Overflow page: next u32 | len u16 | data
 */
import { ByteReader, ByteWriter, compareBytes } from '../encoding/bytes.ts';
import { DbError } from '../types.ts';
import { pad, type PageCodec, type Pager } from './pager.ts';

export interface OverflowRef {
  page: number;
  length: number;
}
type Payload = Uint8Array | OverflowRef;

export interface LeafNode {
  kind: 'leaf';
  keys: Uint8Array[];
  vals: Payload[];
  next: number;
  /** Encoded size in bytes, maintained incrementally (see nodeSize for the definition). */
  size: number;
}

export interface InternalNode {
  kind: 'internal';
  keys: Uint8Array[];
  children: number[];
  size: number;
}

export type BTreeNode = LeafNode | InternalNode;

const KIND_LEAF = 1;
const KIND_INTERNAL = 2;
const NODE_HEADER = 7;

function leafCellSize(key: Uint8Array, val: Payload): number {
  return 3 + key.length + (val instanceof Uint8Array ? 2 + val.length : 8);
}

function internalCellSize(key: Uint8Array): number {
  return 6 + key.length;
}

/** Encoded size computed from scratch; nodes cache it in `size`. */
export function nodeSize(n: { kind: 'leaf'; keys: Uint8Array[]; vals: Payload[] } | { kind: 'internal'; keys: Uint8Array[] }): number {
  let size = NODE_HEADER;
  if (n.kind === 'leaf') {
    for (let i = 0; i < n.keys.length; i++) size += leafCellSize(n.keys[i]!, n.vals[i]!);
  } else {
    for (const k of n.keys) size += internalCellSize(k);
  }
  return size;
}

export const NodeCodec: PageCodec<BTreeNode> = {
  decode(bytes) {
    const r = new ByteReader(bytes);
    const kind = r.u8();
    const count = r.u16();
    if (kind === KIND_LEAF) {
      const next = r.u32();
      const keys: Uint8Array[] = new Array(count);
      const vals: Payload[] = new Array(count);
      for (let i = 0; i < count; i++) {
        keys[i] = r.bytes(r.u16());
        if (r.u8() === 0) vals[i] = r.bytes(r.u16());
        else {
          const length = r.u32();
          vals[i] = { length, page: r.u32() };
        }
      }
      return { kind: 'leaf', keys, vals, next, size: r.pos };
    }
    if (kind === KIND_INTERNAL) {
      const children: number[] = [r.u32()];
      const keys: Uint8Array[] = new Array(count);
      for (let i = 0; i < count; i++) {
        keys[i] = r.bytes(r.u16());
        children.push(r.u32());
      }
      return { kind: 'internal', keys, children, size: r.pos };
    }
    throw new DbError('CORRUPT', `unexpected page kind ${kind} where a B+ tree node was expected`);
  },
  encode(n, pageSize) {
    const w = new ByteWriter(pageSize);
    if (n.kind === 'leaf') {
      w.u8(KIND_LEAF);
      w.u16(n.keys.length);
      w.u32(n.next);
      for (let i = 0; i < n.keys.length; i++) {
        const k = n.keys[i]!;
        const v = n.vals[i]!;
        w.u16(k.length);
        w.bytes(k);
        if (v instanceof Uint8Array) {
          w.u8(0);
          w.u16(v.length);
          w.bytes(v);
        } else {
          w.u8(1);
          w.u32(v.length);
          w.u32(v.page);
        }
      }
    } else {
      w.u8(KIND_INTERNAL);
      w.u16(n.keys.length);
      w.u32(n.children[0]!);
      for (let i = 0; i < n.keys.length; i++) {
        w.u16(n.keys[i]!.length);
        w.bytes(n.keys[i]!);
        w.u32(n.children[i + 1]!);
      }
    }
    return pad(w.finish(), pageSize);
  },
};

interface OverflowPage {
  next: number;
  data: Uint8Array;
}

const OverflowCodec: PageCodec<OverflowPage> = {
  decode(bytes) {
    const r = new ByteReader(bytes);
    const next = r.u32();
    return { next, data: r.bytes(r.u16()) };
  },
  encode(p, pageSize) {
    const w = new ByteWriter(pageSize);
    w.u32(p.next);
    w.u16(p.data.length);
    w.bytes(p.data);
    return pad(w.finish(), pageSize);
  },
};

function lowerBound(keys: Uint8Array[], key: Uint8Array): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(keys[mid]!, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(keys: Uint8Array[], key: Uint8Array): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(keys[mid]!, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface ScanRange {
  lo?: Uint8Array;
  loExclusive?: boolean;
  hi?: Uint8Array;
  hiExclusive?: boolean;
  reverse?: boolean;
}

interface Frame {
  node: BTreeNode;
  idx: number;
}

interface Split {
  key: Uint8Array;
  right: number;
}

export interface NodeInfo {
  id: number;
  kind: 'leaf' | 'internal';
  keys: Uint8Array[];
  children: number[];
  next: number;
  bytes: number;
  overflowCells: number;
}

export class BTree {
  readonly root: number;
  private readonly pager: Pager;
  private readonly pageSize: number;
  private readonly maxCell: number;
  readonly maxKeySize: number;

  constructor(pager: Pager, root: number) {
    this.pager = pager;
    this.root = root;
    this.pageSize = pager.pageSize;
    this.maxCell = Math.floor((this.pageSize - NODE_HEADER) / 4);
    this.maxKeySize = this.maxCell - 11;
  }

  /** Allocates an empty tree and returns its (permanent) root page id. */
  static create(pager: Pager): number {
    const id = pager.allocate();
    pager.put<BTreeNode>(id, { kind: 'leaf', keys: [], vals: [], next: 0, size: NODE_HEADER }, NodeCodec);
    return id;
  }

  private node(id: number): BTreeNode {
    return this.pager.get(id, NodeCodec);
  }

  private nodeMut(id: number): BTreeNode {
    this.pager.bumpTree(this.root);
    return this.pager.getMut(id, NodeCodec);
  }

  private putNode(id: number, node: BTreeNode): void {
    this.pager.bumpTree(this.root);
    this.pager.put(id, node, NodeCodec);
  }

  // ---------------------------------------------------------------- payloads

  private makePayload(key: Uint8Array, value: Uint8Array): Payload {
    if (3 + key.length + 2 + value.length <= this.maxCell) return value;
    const cap = this.pageSize - 6;
    const ids: number[] = [];
    for (let off = 0; off < value.length; off += cap) ids.push(this.pager.allocate());
    for (let i = 0; i < ids.length; i++) {
      const data = value.slice(i * cap, Math.min(value.length, (i + 1) * cap));
      this.pager.put<OverflowPage>(ids[i]!, { next: ids[i + 1] ?? 0, data }, OverflowCodec);
    }
    return { page: ids[0]!, length: value.length };
  }

  private readPayload(p: Payload): Uint8Array {
    if (p instanceof Uint8Array) return p;
    const out = new Uint8Array(p.length);
    let off = 0;
    let id = p.page;
    while (id !== 0) {
      const page = this.pager.get(id, OverflowCodec);
      out.set(page.data, off);
      off += page.data.length;
      id = page.next;
    }
    if (off !== p.length) throw new DbError('CORRUPT', 'overflow chain length mismatch');
    return out;
  }

  private freePayload(p: Payload): void {
    if (p instanceof Uint8Array) return;
    let id = p.page;
    while (id !== 0) {
      const next = this.pager.get(id, OverflowCodec).next;
      this.pager.free(id);
      id = next;
    }
  }

  // ------------------------------------------------------------------ lookup

  get(key: Uint8Array): Uint8Array | null {
    let n = this.node(this.root);
    while (n.kind === 'internal') n = this.node(n.children[upperBound(n.keys, key)]!);
    const i = lowerBound(n.keys, key);
    if (i < n.keys.length && compareBytes(n.keys[i]!, key) === 0) return this.readPayload(n.vals[i]!);
    return null;
  }

  has(key: Uint8Array): boolean {
    return this.get(key) !== null;
  }

  // ------------------------------------------------------------------ insert

  /**
   * Inserts `key -> value`. If the key exists, replaces the value when
   * `upsert` is set and otherwise leaves the tree untouched. Returns true if
   * a new key was added.
   */
  insert(key: Uint8Array, value: Uint8Array, upsert = false): boolean {
    if (key.length > this.maxKeySize) {
      throw new DbError('TOO_BIG', `key is ${key.length} bytes; the limit for ${this.pageSize}-byte pages is ${this.maxKeySize}`);
    }
    const r = this.insertRec(this.root, key, value, upsert);
    if (r.split) this.growRoot(r.split);
    return r.inserted;
  }

  private insertRec(id: number, key: Uint8Array, value: Uint8Array, upsert: boolean): { inserted: boolean; split: Split | null } {
    const node = this.node(id);
    if (node.kind === 'leaf') {
      const i = lowerBound(node.keys, key);
      const exists = i < node.keys.length && compareBytes(node.keys[i]!, key) === 0;
      if (exists && !upsert) return { inserted: false, split: null };
      const m = this.nodeMut(id) as LeafNode;
      const payload = this.makePayload(key, value);
      if (exists) {
        m.size += leafCellSize(key, payload) - leafCellSize(key, m.vals[i]!);
        this.freePayload(m.vals[i]!);
        m.vals[i] = payload;
      } else {
        m.keys.splice(i, 0, key);
        m.vals.splice(i, 0, payload);
        m.size += leafCellSize(key, payload);
      }
      const appended = !exists && m.next === 0 && i === m.keys.length - 1;
      return { inserted: !exists, split: m.size > this.pageSize ? this.splitLeaf(m, appended) : null };
    }
    const ci = upperBound(node.keys, key);
    const r = this.insertRec(node.children[ci]!, key, value, upsert);
    if (!r.split) return r;
    const m = this.nodeMut(id) as InternalNode;
    m.keys.splice(ci, 0, r.split.key);
    m.children.splice(ci + 1, 0, r.split.right);
    m.size += internalCellSize(r.split.key);
    return { inserted: r.inserted, split: m.size > this.pageSize ? this.splitInternal(m) : null };
  }

  /** Index at which the cumulative cell size first reaches half the total. */
  private splitPoint(sizes: number[], min: number, max: number): number {
    const total = sizes.reduce((a, b) => a + b, 0);
    let acc = 0;
    let s = 0;
    while (s < sizes.length && acc + sizes[s]! <= total / 2) acc += sizes[s++]!;
    return Math.min(max, Math.max(min, s));
  }

  /**
   * Splits an overfull leaf. When the new key was appended to the rightmost
   * leaf (sequential inserts, e.g. auto-increment ids) the old page is left
   * full and only the new key moves right, so bulk loads produce ~100% full
   * pages instead of half-empty ones.
   */
  private splitLeaf(m: LeafNode, appended: boolean): Split {
    const sizes = m.keys.map((k, i) => leafCellSize(k, m.vals[i]!));
    const s = appended ? m.keys.length - 1 : this.splitPoint(sizes, 1, m.keys.length - 1);
    const rightId = this.pager.allocate();
    const right: LeafNode = { kind: 'leaf', keys: m.keys.splice(s), vals: m.vals.splice(s), next: m.next, size: 0 };
    right.size = nodeSize(right);
    m.size -= right.size - NODE_HEADER;
    m.next = rightId;
    this.putNode(rightId, right);
    return { key: right.keys[0]!, right: rightId };
  }

  private splitInternal(m: InternalNode): Split {
    const sizes = m.keys.map(internalCellSize);
    const s = this.splitPoint(sizes, 1, m.keys.length - 2);
    const rightKeys = m.keys.splice(s);
    const sep = rightKeys.shift()!;
    const right: InternalNode = { kind: 'internal', keys: rightKeys, children: m.children.splice(s + 1), size: 0 };
    right.size = nodeSize(right);
    m.size = nodeSize(m);
    const rightId = this.pager.allocate();
    this.putNode(rightId, right);
    return { key: sep, right: rightId };
  }

  /** The root split: move its contents to a new page and make it the parent. */
  private growRoot(split: Split): void {
    const old = this.node(this.root);
    const leftId = this.pager.allocate();
    this.putNode(leftId, old);
    this.putNode(this.root, { kind: 'internal', keys: [split.key], children: [leftId, split.right], size: NODE_HEADER + internalCellSize(split.key) });
  }

  // ------------------------------------------------------------------ delete

  delete(key: Uint8Array): boolean {
    const found = this.deleteRec(this.root, key);
    if (found) {
      const r = this.node(this.root);
      if (r.kind === 'internal' && r.keys.length === 0) {
        const childId = r.children[0]!;
        this.putNode(this.root, this.node(childId));
        this.pager.free(childId);
      }
    }
    return found;
  }

  private deleteRec(id: number, key: Uint8Array): boolean {
    const node = this.node(id);
    if (node.kind === 'leaf') {
      const i = lowerBound(node.keys, key);
      if (i >= node.keys.length || compareBytes(node.keys[i]!, key) !== 0) return false;
      const m = this.nodeMut(id) as LeafNode;
      m.size -= leafCellSize(m.keys[i]!, m.vals[i]!);
      this.freePayload(m.vals[i]!);
      m.keys.splice(i, 1);
      m.vals.splice(i, 1);
      return true;
    }
    const ci = upperBound(node.keys, key);
    const found = this.deleteRec(node.children[ci]!, key);
    if (found) this.rebalance(id, ci);
    return found;
  }

  /** Merges child `ci` of `parentId` with a sibling if it is underfull and they fit. */
  private rebalance(parentId: number, ci: number): void {
    const parent = this.node(parentId) as InternalNode;
    const child = this.node(parent.children[ci]!);
    if (child.size >= this.pageSize / 4 || parent.children.length < 2) return;
    const li = ci > 0 ? ci - 1 : ci;
    const leftId = parent.children[li]!;
    const rightId = parent.children[li + 1]!;
    const sep = parent.keys[li]!;
    const left = this.node(leftId);
    const right = this.node(rightId);
    const merged =
      left.kind === 'leaf'
        ? left.size + right.size - NODE_HEADER
        : left.size + right.size - NODE_HEADER + internalCellSize(sep);
    if (merged > this.pageSize) return;

    const L = this.nodeMut(leftId);
    if (L.kind === 'leaf') {
      const R = right as LeafNode;
      L.keys.push(...R.keys);
      L.vals.push(...R.vals);
      L.next = R.next;
    } else {
      const R = right as InternalNode;
      L.keys.push(sep, ...R.keys);
      L.children.push(...R.children);
    }
    L.size = merged;
    this.pager.free(rightId);
    const P = this.nodeMut(parentId) as InternalNode;
    P.keys.splice(li, 1);
    P.children.splice(li + 1, 1);
    P.size -= internalCellSize(sep);
  }

  // ------------------------------------------------------------------- scans

  private descend(stack: Frame[], id: number, rightmost: boolean): void {
    for (;;) {
      const n = this.node(id);
      if (n.kind === 'leaf') {
        stack.push({ node: n, idx: rightmost ? n.keys.length - 1 : 0 });
        return;
      }
      const idx = rightmost ? n.children.length - 1 : 0;
      stack.push({ node: n, idx });
      id = n.children[idx]!;
    }
  }

  private seekFirst(lo: Uint8Array | undefined, exclusive: boolean): Frame[] {
    const stack: Frame[] = [];
    if (lo === undefined) {
      this.descend(stack, this.root, false);
      return stack;
    }
    let id = this.root;
    for (;;) {
      const n = this.node(id);
      if (n.kind === 'leaf') {
        stack.push({ node: n, idx: exclusive ? upperBound(n.keys, lo) : lowerBound(n.keys, lo) });
        return stack;
      }
      const ci = upperBound(n.keys, lo);
      stack.push({ node: n, idx: ci });
      id = n.children[ci]!;
    }
  }

  private seekLast(hi: Uint8Array | undefined, exclusive: boolean): Frame[] {
    const stack: Frame[] = [];
    if (hi === undefined) {
      this.descend(stack, this.root, true);
      return stack;
    }
    let id = this.root;
    for (;;) {
      const n = this.node(id);
      if (n.kind === 'leaf') {
        stack.push({ node: n, idx: (exclusive ? lowerBound(n.keys, hi) : upperBound(n.keys, hi)) - 1 });
        return stack;
      }
      const ci = exclusive ? lowerBound(n.keys, hi) : upperBound(n.keys, hi);
      stack.push({ node: n, idx: ci });
      id = n.children[ci]!;
    }
  }

  /** Moves the cursor to the first entry of the next leaf. */
  private advance(stack: Frame[]): boolean {
    stack.pop();
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const n = top.node as InternalNode;
      if (++top.idx < n.children.length) {
        this.descend(stack, n.children[top.idx]!, false);
        return true;
      }
      stack.pop();
    }
    return false;
  }

  /** Moves the cursor to the last entry of the previous leaf. */
  private retreat(stack: Frame[]): boolean {
    stack.pop();
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const n = top.node as InternalNode;
      if (--top.idx >= 0) {
        this.descend(stack, n.children[top.idx]!, true);
        return true;
      }
      stack.pop();
    }
    return false;
  }

  /** Iterates `[key, value]` pairs in key order (or reverse) within an optional range. */
  *scan(range: ScanRange = {}): Generator<[Uint8Array, Uint8Array]> {
    const { lo, hi, reverse = false } = range;
    const loEx = range.loExclusive ?? false;
    const hiEx = range.hiExclusive ?? false;
    let stack = reverse ? this.seekLast(hi, hiEx) : this.seekFirst(lo, loEx);
    let mod = this.pager.treeVersion(this.root);
    let last: Uint8Array | null = null;
    for (;;) {
      const now = this.pager.treeVersion(this.root);
      if (now !== mod) {
        // The tree changed while we were suspended: re-seek past the last key.
        if (last !== null) stack = reverse ? this.seekLast(last, true) : this.seekFirst(last, true);
        mod = now;
      }
      const top = stack[stack.length - 1]!;
      const leaf = top.node as LeafNode;
      if (!reverse && top.idx >= leaf.keys.length) {
        if (!this.advance(stack)) return;
        continue;
      }
      if (reverse && top.idx < 0) {
        if (!this.retreat(stack)) return;
        continue;
      }
      const key = leaf.keys[top.idx]!;
      if (!reverse && hi !== undefined) {
        const c = compareBytes(key, hi);
        if (c > 0 || (c === 0 && hiEx)) return;
      }
      if (reverse && lo !== undefined) {
        const c = compareBytes(key, lo);
        if (c < 0 || (c === 0 && loEx)) return;
      }
      const value = this.readPayload(leaf.vals[top.idx]!);
      top.idx += reverse ? -1 : 1;
      last = key;
      yield [key, value];
    }
  }

  first(): Uint8Array | null {
    for (const [k] of this.scan()) return k;
    return null;
  }

  last(): Uint8Array | null {
    for (const [k] of this.scan({ reverse: true })) return k;
    return null;
  }

  /** Number of entries (walks the leaves without reading values). */
  count(): number {
    let total = 0;
    const visit = (id: number): void => {
      const n = this.node(id);
      if (n.kind === 'leaf') total += n.keys.length;
      else for (const c of n.children) visit(c);
    };
    visit(this.root);
    return total;
  }

  /** Frees every page of the tree, including the root and overflow chains. */
  destroy(): void {
    const visit = (id: number): void => {
      const n = this.node(id);
      if (n.kind === 'leaf') for (const v of n.vals) this.freePayload(v);
      else for (const c of n.children) visit(c);
      this.pager.free(id);
    };
    this.pager.bumpTree(this.root);
    visit(this.root);
  }

  /** Removes every entry but keeps the root page. */
  clear(): void {
    const n = this.node(this.root);
    if (n.kind === 'leaf') for (const v of n.vals) this.freePayload(v);
    else
      for (const c of n.children) {
        new BTree(this.pager, c).destroy();
      }
    this.putNode(this.root, { kind: 'leaf', keys: [], vals: [], next: 0, size: NODE_HEADER });
  }

  // ----------------------------------------------------------- introspection

  /** Nodes grouped by depth, for visualisation. Stops after `maxNodes`. */
  inspect(maxNodes = 4000): NodeInfo[][] {
    const levels: NodeInfo[][] = [];
    let frontier = [this.root];
    let seen = 0;
    while (frontier.length > 0 && seen < maxNodes) {
      const level: NodeInfo[] = [];
      const next: number[] = [];
      for (const id of frontier) {
        if (seen++ >= maxNodes) break;
        const n = this.node(id);
        level.push({
          id,
          kind: n.kind,
          keys: n.keys.slice(),
          children: n.kind === 'internal' ? n.children.slice() : [],
          next: n.kind === 'leaf' ? n.next : 0,
          bytes: n.size,
          overflowCells: n.kind === 'leaf' ? n.vals.filter((v) => !(v instanceof Uint8Array)).length : 0,
        });
        if (n.kind === 'internal') next.push(...n.children);
      }
      levels.push(level);
      frontier = next;
    }
    return levels;
  }

  /** Verifies structural invariants; throws with a description on failure. */
  check(): { depth: number; entries: number; pages: number } {
    let leafDepth = -1;
    let entries = 0;
    let pages = 0;
    const leaves: number[] = [];
    const visit = (id: number, depth: number, lo: Uint8Array | null, hi: Uint8Array | null): void => {
      pages++;
      const n = this.node(id);
      const size = nodeSize(n);
      if (size !== n.size) throw new Error(`node ${id}: cached size ${n.size} but actual ${size}`);
      if (size > this.pageSize) throw new Error(`node ${id} is ${size} bytes`);
      for (let i = 0; i < n.keys.length; i++) {
        const k = n.keys[i]!;
        if (i > 0 && compareBytes(n.keys[i - 1]!, k) >= 0) throw new Error(`node ${id}: keys out of order`);
        if (lo && compareBytes(k, lo) < 0) throw new Error(`node ${id}: key below separator`);
        if (hi && compareBytes(k, hi) >= 0) throw new Error(`node ${id}: key above separator`);
      }
      if (n.kind === 'leaf') {
        if (leafDepth === -1) leafDepth = depth;
        else if (leafDepth !== depth) throw new Error('leaves at different depths');
        entries += n.keys.length;
        leaves.push(id);
        return;
      }
      if (n.children.length !== n.keys.length + 1) throw new Error(`node ${id}: child count mismatch`);
      for (let i = 0; i < n.children.length; i++) {
        visit(n.children[i]!, depth + 1, i === 0 ? lo : n.keys[i - 1]!, i === n.keys.length ? hi : n.keys[i]!);
      }
    };
    visit(this.root, 0, null, null);
    for (let i = 0; i < leaves.length; i++) {
      const next = (this.node(leaves[i]!) as LeafNode).next;
      if (next !== (leaves[i + 1] ?? 0)) throw new Error(`leaf ${leaves[i]} has next=${next}, expected ${leaves[i + 1] ?? 0}`);
    }
    return { depth: leafDepth + 1, entries, pages };
  }
}
