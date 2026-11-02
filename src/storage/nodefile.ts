import * as fs from 'node:fs';
import type { BlockFile } from './file.ts';

/** BlockFile backed by a real file on disk, using synchronous fs calls. */
export class NodeFile implements BlockFile {
  private fd: number;

  constructor(path: string) {
    this.fd = fs.openSync(path, fs.existsSync(path) ? 'r+' : 'w+');
  }

  read(offset: number, length: number): Uint8Array {
    const buf = new Uint8Array(length);
    let total = 0;
    while (total < length) {
      const n = fs.readSync(this.fd, buf, total, length - total, offset + total);
      if (n === 0) break;
      total += n;
    }
    return total === length ? buf : buf.subarray(0, total);
  }

  write(offset: number, data: Uint8Array): void {
    let total = 0;
    while (total < data.length) {
      total += fs.writeSync(this.fd, data, total, data.length - total, offset + total);
    }
  }

  size(): number {
    return fs.fstatSync(this.fd).size;
  }

  truncate(size: number): void {
    fs.ftruncateSync(this.fd, size);
  }

  sync(): void {
    fs.fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd >= 0) {
      fs.closeSync(this.fd);
      this.fd = -1;
    }
  }
}
