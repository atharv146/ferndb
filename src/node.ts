import { Database, type DatabaseOptions } from './database.ts';
import { NodeFile } from './storage/nodefile.ts';

/** Opens (or creates) a database file. The write-ahead log lives next to it as `<path>-wal`. */
export function openDatabase(path: string, opts: DatabaseOptions = {}): Database {
  return new Database(new NodeFile(path), new NodeFile(`${path}-wal`), opts);
}

export * from './index.ts';
