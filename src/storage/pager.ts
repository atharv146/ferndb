/**
 * The pager owns every page of the database file. It provides:
 *
 *  - a buffer pool: an LRU cache of pages, kept in decoded form so the B+ tree
 *    can work with plain objects instead of re-parsing bytes on every access;
 *  - transactions: a NO-STEAL policy, meaning dirty pages never leave memory
 *    before commit, so rollback is just dropping them from the cache;
 *  - durability through a write-ahead log (WAL): commit appends full page
 *    images plus a commit marker to the log and fsyncs it once. The main file
 *    is only touched later, at checkpoint time. After a crash the log is
 *    replayed up to the last valid commit marker; anything after it (a torn or
 *    half-written transaction) fails its checksum and is ignored.
 *
 * WAL layout
 *   header (32 bytes): magic, version, page size, salt1, salt2, header crc
 *   frame: pageId u32 | commit u32 (page count if last frame of a txn, else 0)
 *          | salt1 u32 | salt2 u32 | crc u32 | reserved u32 | page bytes
 *   The crc of each frame chains from the previous one, so frames can only be
 *   accepted in order, and the salts change on every checkpoint so stale frames
 *   left over from an earlier generation of the log are never replayed.
 */
import { ByteReader, ByteWriter, crc32 } from '../encoding/bytes.ts';
import { DbError } from '../types.ts';
import type { BlockFile } from './file.ts';

export interface PageCodec<T> {
  decode(bytes: Uint8Array, pageSize: number): T;
  encode(obj: T, pageSize: number): Uint8Array;
}

interface Entry {
  id: number;
  obj: unknown;
  codec: PageCodec<unknown>;
  dirty: boolean;
}

export interface PagerOptions {
  pageSize?: number;
  /** Maximum number of clean pages kept in the cache. */
  cacheSize?: number;
  /** Checkpoint automatically once the WAL holds this many frames. */
  checkpointFrames?: number;
}

export interface PagerStats {
  pageSize: number;
  pageCount: number;
  freePages: number;
  cachedPages: number;
  cacheHits: number;
  cacheMisses: number;
  walFrames: number;
  commits: number;
  checkpoints: number;
  framesWritten: number;
}

const MAGIC = 0x4645524e; // "FERN"
const WAL_MAGIC = 0x57414c31; // "WAL1"
const FORMAT_VERSION = 1;
const WAL_HEADER = 32;
const FRAME_HEADER = 24;

export const MIN_PAGE_SIZE = 256;
export const DEFAULT_PAGE_SIZE = 4096;

/** Page 0: file header. */
export interface Header {
  pageSize: number;
  pageCount: number;
  freeHead: number;
  freeCount: number;
  schemaRoot: number;
  schemaCookie: number;
}

const HeaderCodec: PageCodec<Header> = {
  decode(bytes) {
    const r = new ByteReader(bytes);
    if (r.u32() !== MAGIC) throw new DbError('CORRUPT', 'not a FernDB database file');
    const version = r.u32();
    if (version !== FORMAT_VERSION) throw new DbError('CORRUPT', `unsupported format version ${version}`);
    return {
      pageSize: r.u32(),
      pageCount: r.u32(),
      freeHead: r.u32(),
      freeCount: r.u32(),
      schemaRoot: r.u32(),
      schemaCookie: r.u32(),
    };
  },
  encode(h, pageSize) {
    const w = new ByteWriter(pageSize);
    w.u32(MAGIC);
    w.u32(FORMAT_VERSION);
    w.u32(h.pageSize);
    w.u32(h.pageCount);
    w.u32(h.freeHead);
    w.u32(h.freeCount);
    w.u32(h.schemaRoot);
    w.u32(h.schemaCookie);
    return pad(w.finish(), pageSize);
  },
};

/** A page on the freelist stores only the id of the next free page. */
interface FreePage {
  next: number;
}

const FreePageCodec: PageCodec<FreePage> = {
  decode: (bytes) => ({ next: new ByteReader(bytes).u32() }),
  encode(p, pageSize) {
    const w = new ByteWriter(8);
    w.u32(p.next);
    return pad(w.finish(), pageSize);
  },
};

export function pad(bytes: Uint8Array, pageSize: number): Uint8Array {
  if (bytes.length > pageSize) throw new Error(`page overflow: ${bytes.length} > ${pageSize}`);
  if (bytes.length === pageSize) return bytes;
  const out = new Uint8Array(pageSize);
  out.set(bytes);
  return out;
}

function randomU32(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

export class Pager {
  readonly pageSize: number;
  private readonly db: BlockFile;
  private readonly wal: BlockFile;
  private readonly cacheSize: number;
  private readonly checkpointFrames: number;

  /** LRU order: Map iteration order is insertion order; touching re-inserts. */
  private readonly cache = new Map<number, Entry>();
  private readonly dirty = new Set<number>();
  /** pageId -> byte offset of its newest committed image in the WAL. */
  private readonly walIndex = new Map<number, number>();
  private walFrames = 0;
  private walSalt1 = 0;
  private walSalt2 = 0;
  private walCrc = 0;

  private txn = false;
  /** Bumped on every page modification; lets cursors detect concurrent changes. */
  modCount = 0;
  readonly isNew: boolean;

  private stats = { cacheHits: 0, cacheMisses: 0, commits: 0, checkpoints: 0, framesWritten: 0 };

  constructor(db: BlockFile, wal: BlockFile, opts: PagerOptions = {}) {
    this.db = db;
    this.wal = wal;
    this.cacheSize = opts.cacheSize ?? 2048;
    this.checkpointFrames = opts.checkpointFrames ?? 1000;

    this.recover();

    if (this.db.size() === 0) {
      const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
      if (pageSize < MIN_PAGE_SIZE || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
        throw new DbError('MISUSE', `page size must be a power of two between ${MIN_PAGE_SIZE} and 65536`);
      }
      this.pageSize = pageSize;
      this.isNew = true;
      const header: Header = { pageSize, pageCount: 1, freeHead: 0, freeCount: 0, schemaRoot: 0, schemaCookie: 0 };
      this.db.write(0, HeaderCodec.encode(header, pageSize));
      this.db.sync();
    } else {
      const first = this.db.read(0, 64);
      this.pageSize = new DataView(first.buffer, first.byteOffset).getUint32(8);
      this.isNew = false;
      HeaderCodec.decode(this.db.read(0, this.pageSize), this.pageSize); // validates magic
    }
  }

  // ---------------------------------------------------------------- recovery

  /** Replays committed WAL frames into the main file, then empties the WAL. */
  private recover(): void {
    const walSize = this.wal.size();
    if (walSize < WAL_HEADER) {
      if (walSize > 0) this.wal.truncate(0);
      return;
    }
    const hdr = this.wal.read(0, WAL_HEADER);
    const r = new ByteReader(hdr);
    const magic = r.u32();
    r.u32(); // version
    const pageSize = r.u32();
    const salt1 = r.u32();
    const salt2 = r.u32();
    const hdrCrc = r.u32();
    if (magic !== WAL_MAGIC || crc32(hdr.subarray(0, 20)) !== hdrCrc) {
      this.wal.truncate(0);
      return;
    }

    const committed = new Map<number, number>();
    const pending = new Map<number, number>();
    let crc = hdrCrc;
    let off = WAL_HEADER;
    let lastCommitPageCount = 0;
    while (off + FRAME_HEADER + pageSize <= walSize) {
      const fh = this.wal.read(off, FRAME_HEADER);
      const fr = new ByteReader(fh);
      const pageId = fr.u32();
      const commit = fr.u32();
      const s1 = fr.u32();
      const s2 = fr.u32();
      const frameCrc = fr.u32();
      if (s1 !== salt1 || s2 !== salt2) break;
      const data = this.wal.read(off + FRAME_HEADER, pageSize);
      const expect = crc32(data, crc32(fh.subarray(0, 16), crc));
      if (expect !== frameCrc) break;
      crc = frameCrc;
      pending.set(pageId, off + FRAME_HEADER);
      if (commit !== 0) {
        for (const [id, o] of pending) committed.set(id, o);
        pending.clear();
        lastCommitPageCount = commit;
      }
      off += FRAME_HEADER + pageSize;
    }

    if (committed.size > 0) {
      for (const [id, o] of committed) this.db.write(id * pageSize, this.wal.read(o, pageSize));
      // Pages past the committed page count belong to rolled-back allocations.
      if (this.db.size() > lastCommitPageCount * pageSize) this.db.truncate(lastCommitPageCount * pageSize);
      this.db.sync();
    }
    this.wal.truncate(0);
    this.wal.sync();
  }

  // ------------------------------------------------------------- page access

  private loadBytes(id: number): Uint8Array {
    const walOff = this.walIndex.get(id);
    const bytes = walOff !== undefined ? this.wal.read(walOff, this.pageSize) : this.db.read(id * this.pageSize, this.pageSize);
    if (bytes.length !== this.pageSize) throw new DbError('CORRUPT', `page ${id} is missing or truncated`);
    return bytes;
  }

  private touch(e: Entry): void {
    this.cache.delete(e.id);
    this.cache.set(e.id, e);
  }

  private entry<T>(id: number, codec: PageCodec<T>): Entry {
    const e = this.cache.get(id);
    if (e) {
      this.stats.cacheHits++;
      if (e.codec !== codec) {
        // Same page reinterpreted (e.g. a freed page being reused).
        e.obj = codec.decode(e.codec.encode(e.obj, this.pageSize), this.pageSize);
        e.codec = codec as PageCodec<unknown>;
      }
      this.touch(e);
      return e;
    }
    this.stats.cacheMisses++;
    const obj = codec.decode(this.loadBytes(id), this.pageSize);
    const fresh: Entry = { id, obj, codec: codec as PageCodec<unknown>, dirty: false };
    this.cache.set(id, fresh);
    this.evict();
    return fresh;
  }

  private evict(): void {
    if (this.cache.size <= this.cacheSize + this.dirty.size) return;
    for (const [id, e] of this.cache) {
      if (this.cache.size <= this.cacheSize + this.dirty.size) break;
      if (!e.dirty && id !== 0) this.cache.delete(id);
    }
  }

  private requireTxn(): void {
    if (!this.txn) throw new DbError('MISUSE', 'write outside of a transaction');
  }

  /** Read-only access. Callers must not mutate the returned object. */
  get<T>(id: number, codec: PageCodec<T>): T {
    if (id <= 0) throw new DbError('CORRUPT', `invalid page reference ${id}`);
    return this.entry(id, codec).obj as T;
  }

  /** Returns the page for in-place modification and marks it dirty. */
  getMut<T>(id: number, codec: PageCodec<T>): T {
    this.requireTxn();
    const e = this.entry(id, codec);
    e.dirty = true;
    this.dirty.add(id);
    this.modCount++;
    return e.obj as T;
  }

  /** Replaces the whole content of a page. */
  put<T>(id: number, obj: T, codec: PageCodec<T>): void {
    this.requireTxn();
    let e = this.cache.get(id);
    if (e) {
      e.obj = obj;
      e.codec = codec as PageCodec<unknown>;
      this.touch(e);
    } else {
      e = { id, obj, codec: codec as PageCodec<unknown>, dirty: true };
      this.cache.set(id, e);
    }
    e.dirty = true;
    this.dirty.add(id);
    this.modCount++;
  }

  header(): Header {
    return this.entry(0, HeaderCodec).obj as Header;
  }

  headerMut(): Header {
    return this.getMutHeader();
  }

  private getMutHeader(): Header {
    this.requireTxn();
    const e = this.entry(0, HeaderCodec);
    e.dirty = true;
    this.dirty.add(0);
    return e.obj as Header;
  }

  /** Allocates a page, reusing the freelist first. The caller must `put` it. */
  allocate(): number {
    const h = this.getMutHeader();
    if (h.freeHead !== 0) {
      const id = h.freeHead;
      h.freeHead = this.get(id, FreePageCodec).next;
      h.freeCount--;
      return id;
    }
    return h.pageCount++;
  }

  /** Returns a page to the freelist. */
  free(id: number): void {
    const h = this.getMutHeader();
    this.put<FreePage>(id, { next: h.freeHead }, FreePageCodec);
    h.freeHead = id;
    h.freeCount++;
  }

  // ------------------------------------------------------------ transactions

  get inTransaction(): boolean {
    return this.txn;
  }

  begin(): void {
    if (this.txn) throw new DbError('MISUSE', 'a transaction is already active');
    this.txn = true;
  }

  rollback(): void {
    for (const id of this.dirty) this.cache.delete(id);
    this.dirty.clear();
    this.txn = false;
    this.modCount++;
  }

  commit(): void {
    this.requireTxn();
    if (this.dirty.size > 0) {
      this.writeFrames();
      this.stats.commits++;
    }
    this.txn = false;
    if (this.walFrames >= this.checkpointFrames) this.checkpoint();
  }

  private writeFrames(): void {
    if (this.wal.size() === 0) this.startWal();
    const ids = [...this.dirty].sort((a, b) => a - b);
    const pageCount = this.header().pageCount;
    let off = WAL_HEADER + this.walFrames * (FRAME_HEADER + this.pageSize);
    const placed: [number, number][] = [];
    let crc = this.walCrc;
    // Frames are written as one buffer per page; the commit marker rides on the last one.
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const e = this.cache.get(id)!;
      const data = e.codec.encode(e.obj, this.pageSize);
      if (data.length !== this.pageSize) throw new Error(`codec produced ${data.length} bytes for page ${id}`);
      const fh = new ByteWriter(FRAME_HEADER);
      fh.u32(id);
      fh.u32(i === ids.length - 1 ? pageCount : 0);
      fh.u32(this.walSalt1);
      fh.u32(this.walSalt2);
      const head = fh.finish();
      crc = crc32(data, crc32(head, crc));
      const frame = new Uint8Array(FRAME_HEADER + this.pageSize);
      frame.set(head);
      new DataView(frame.buffer).setUint32(16, crc);
      frame.set(data, FRAME_HEADER);
      this.wal.write(off, frame);
      placed.push([id, off + FRAME_HEADER]);
      off += frame.length;
    }
    this.wal.sync();
    // Only once the log is durable do the new page versions become visible.
    this.walCrc = crc;
    this.walFrames += ids.length;
    this.stats.framesWritten += ids.length;
    for (const [id, o] of placed) this.walIndex.set(id, o);
    for (const id of ids) this.cache.get(id)!.dirty = false;
    this.dirty.clear();
  }

  private startWal(): void {
    this.walSalt1 = randomU32();
    this.walSalt2 = randomU32();
    const w = new ByteWriter(WAL_HEADER);
    w.u32(WAL_MAGIC);
    w.u32(FORMAT_VERSION);
    w.u32(this.pageSize);
    w.u32(this.walSalt1);
    w.u32(this.walSalt2);
    const head = w.finish();
    this.walCrc = crc32(head);
    const out = new Uint8Array(WAL_HEADER);
    out.set(head);
    new DataView(out.buffer).setUint32(20, this.walCrc);
    this.wal.write(0, out);
    this.walFrames = 0;
  }

  /** Copies the newest committed page images from the WAL into the main file. */
  checkpoint(): void {
    if (this.txn) throw new DbError('MISUSE', 'cannot checkpoint during a transaction');
    if (this.walIndex.size === 0) return;
    for (const [id, off] of this.walIndex) this.db.write(id * this.pageSize, this.wal.read(off, this.pageSize));
    const pageCount = this.header().pageCount;
    if (this.db.size() > pageCount * this.pageSize) this.db.truncate(pageCount * this.pageSize);
    this.db.sync();
    this.walIndex.clear();
    this.wal.truncate(0);
    this.wal.sync();
    this.walFrames = 0;
    this.stats.checkpoints++;
  }

  close(): void {
    if (this.txn) this.rollback();
    this.checkpoint();
    this.db.close();
    this.wal.close();
  }

  getStats(): PagerStats {
    const h = this.header();
    return {
      pageSize: this.pageSize,
      pageCount: h.pageCount,
      freePages: h.freeCount,
      cachedPages: this.cache.size,
      walFrames: this.walFrames,
      ...this.stats,
    };
  }
}
