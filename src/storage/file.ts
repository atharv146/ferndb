/**
 * Minimal random-access file abstraction. The pager talks to two of these:
 * the main database file and the write-ahead log.
 */
export interface BlockFile {
  /** Reads up to `length` bytes; the result is shorter if the file ends first. */
  read(offset: number, length: number): Uint8Array;
  write(offset: number, data: Uint8Array): void;
  size(): number;
  truncate(size: number): void;
  /** Durability barrier: everything written before this call survives a crash. */
  sync(): void;
  close(): void;
}

/** In-memory file. Used by the browser playground and the test suite. */
export class MemoryFile implements BlockFile {
  private data = new Uint8Array(0);
  private len = 0;
  syncCount = 0;

  read(offset: number, length: number): Uint8Array {
    const end = Math.min(this.len, offset + length);
    return offset >= end ? new Uint8Array(0) : this.data.slice(offset, end);
  }

  write(offset: number, bytes: Uint8Array): void {
    const end = offset + bytes.length;
    if (end > this.data.length) {
      let cap = Math.max(4096, this.data.length * 2);
      while (cap < end) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.data.subarray(0, this.len));
      this.data = next;
    }
    this.data.set(bytes, offset);
    if (end > this.len) this.len = end;
  }

  size(): number {
    return this.len;
  }

  truncate(size: number): void {
    if (size < this.len) this.data.fill(0, size, this.len);
    this.len = size;
  }

  sync(): void {
    this.syncCount++;
  }

  close(): void {}

  /** Copy of the current contents (for snapshots and crash tests). */
  snapshot(): Uint8Array {
    return this.data.slice(0, this.len);
  }

  static from(bytes: Uint8Array): MemoryFile {
    const f = new MemoryFile();
    f.write(0, bytes);
    return f;
  }
}

/**
 * Wraps a file and simulates a power cut: after `budget` write operations
 * every further write throws. Writes that already happened stay on "disk",
 * exactly like a real crash in the middle of a commit.
 */
export class CrashingFile implements BlockFile {
  private readonly inner: BlockFile;
  private readonly counter: { remaining: number };

  constructor(inner: BlockFile, counter: { remaining: number }) {
    this.inner = inner;
    this.counter = counter;
  }

  private tick(): void {
    if (this.counter.remaining <= 0) throw new Error('simulated crash');
    this.counter.remaining--;
  }

  read(offset: number, length: number): Uint8Array {
    return this.inner.read(offset, length);
  }

  write(offset: number, data: Uint8Array): void {
    this.tick();
    // A torn write: when the crash lands mid-page, only part of it reaches disk.
    if (this.counter.remaining === 0 && data.length > 1) {
      this.inner.write(offset, data.subarray(0, data.length >> 1));
      throw new Error('simulated crash (torn write)');
    }
    this.inner.write(offset, data);
  }

  size(): number {
    return this.inner.size();
  }

  truncate(size: number): void {
    this.tick();
    this.inner.truncate(size);
  }

  sync(): void {
    this.tick();
    this.inner.sync();
  }

  close(): void {}
}
