/**
 * The catalog: table and index definitions, persisted in their own B+ tree
 * (rooted at header.schemaRoot) so that schema changes are transactional
 * exactly like data changes.
 */
import { utf8Decoder, utf8Encoder } from './encoding/bytes.ts';
import { encodeKey } from './encoding/keycodec.ts';
import type { Expr } from './sql/ast.ts';
import { BTree } from './storage/btree.ts';
import type { Pager } from './storage/pager.ts';
import { semanticError, type ColumnType, type Value } from './types.ts';

export interface ColumnInfo {
  name: string;
  type: ColumnType;
  notNull: boolean;
  default: Expr | null;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** Column positions of the primary key. Empty means the table is keyed by a hidden rowid. */
  pk: number[];
  root: number;
}

export interface IndexInfo {
  name: string;
  table: string;
  columns: number[];
  unique: boolean;
  root: number;
  /** Created implicitly for a UNIQUE constraint. */
  auto: boolean;
}

/** Something rows can be found through in key order: the table itself or an index. */
export interface AccessPath {
  kind: 'pk' | 'index';
  name: string;
  columns: number[];
  unique: boolean;
  root: number;
}

export const ROWID = 'rowid';

export function hasRowid(t: TableInfo): boolean {
  return t.pk.length === 0;
}

/** Positions (in a full row, including the trailing rowid if any) that form the table key. */
export function keyColumns(t: TableInfo): number[] {
  return hasRowid(t) ? [t.columns.length] : t.pk;
}

export function tableKey(t: TableInfo, row: readonly Value[]): Uint8Array {
  return encodeKey(keyColumns(t).map((i) => row[i]!));
}

export function indexKey(idx: IndexInfo, row: readonly Value[], tkey: Uint8Array): Uint8Array {
  const prefix = encodeKey(idx.columns.map((i) => row[i]!));
  const out = new Uint8Array(prefix.length + tkey.length);
  out.set(prefix);
  out.set(tkey, prefix.length);
  return out;
}

export function columnIndex(t: TableInfo, name: string): number {
  const lower = name.toLowerCase();
  const i = t.columns.findIndex((c) => c.name.toLowerCase() === lower);
  if (i >= 0) return i;
  if (hasRowid(t) && lower === ROWID) return t.columns.length;
  throw semanticError(`table ${t.name} has no column named ${name}`);
}

export class Catalog {
  readonly tables = new Map<string, TableInfo>();
  readonly indexes = new Map<string, IndexInfo>();
  private readonly tree: BTree;

  constructor(pager: Pager, schemaRoot: number) {
    this.tree = new BTree(pager, schemaRoot);
    this.load();
  }

  load(): void {
    this.tables.clear();
    this.indexes.clear();
    for (const [k, v] of this.tree.scan()) {
      const kind = k[1] === 'i'.charCodeAt(0) ? 'index' : 'table';
      const def = JSON.parse(utf8Decoder.decode(v));
      if (kind === 'table') this.tables.set(def.name.toLowerCase(), def);
      else this.indexes.set(def.name.toLowerCase(), def);
    }
  }

  private key(kind: 'table' | 'index', name: string): Uint8Array {
    return encodeKey([kind, name.toLowerCase()]);
  }

  getTable(name: string): TableInfo {
    const t = this.tables.get(name.toLowerCase());
    if (!t) throw semanticError(`no such table: ${name}`);
    return t;
  }

  findTable(name: string): TableInfo | undefined {
    return this.tables.get(name.toLowerCase());
  }

  indexesOf(table: string): IndexInfo[] {
    const lower = table.toLowerCase();
    return [...this.indexes.values()].filter((i) => i.table.toLowerCase() === lower);
  }

  accessPaths(t: TableInfo): AccessPath[] {
    const paths: AccessPath[] = [{ kind: 'pk', name: 'PRIMARY KEY', columns: keyColumns(t), unique: true, root: t.root }];
    for (const idx of this.indexesOf(t.name)) {
      paths.push({ kind: 'index', name: idx.name, columns: idx.columns, unique: idx.unique, root: idx.root });
    }
    return paths;
  }

  saveTable(t: TableInfo): void {
    this.tree.insert(this.key('table', t.name), utf8Encoder.encode(JSON.stringify(t)), true);
    this.tables.set(t.name.toLowerCase(), t);
  }

  removeTable(name: string): void {
    this.tree.delete(this.key('table', name));
    this.tables.delete(name.toLowerCase());
  }

  saveIndex(i: IndexInfo): void {
    this.tree.insert(this.key('index', i.name), utf8Encoder.encode(JSON.stringify(i)), true);
    this.indexes.set(i.name.toLowerCase(), i);
  }

  removeIndex(name: string): void {
    this.tree.delete(this.key('index', name));
    this.indexes.delete(name.toLowerCase());
  }
}
