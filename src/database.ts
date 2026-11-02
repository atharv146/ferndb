/**
 * Database: the public entry point. Parses SQL, runs DDL and DML against the
 * catalog and B+ trees, hands SELECTs to the planner, and wraps every
 * statement in a transaction (implicitly, unless BEGIN was issued).
 */
import {
  Catalog,
  columnIndex,
  hasRowid,
  indexKey,
  keyColumns,
  ROWID,
  tableKey,
  type ColumnInfo,
  type IndexInfo,
  type TableInfo,
} from './catalog.ts';
import { bytesEqual } from './encoding/bytes.ts';
import { decodeKey, encodeKey, prefixUpperBound } from './encoding/keycodec.ts';
import { encodeRow } from './encoding/rowcodec.ts';
import { Scope, type Env, type Row } from './exec/expr.ts';
import { explainLines, planToJson, type PlanJson, type PlanNode } from './exec/operators.ts';
import { Planner, type PlannerContext } from './planner/planner.ts';
import type { Expr, SelectStmt, Statement } from './sql/ast.ts';
import { parse } from './sql/parser.ts';
import { exprToSql, quoteIdent } from './sql/printer.ts';
import { BTree } from './storage/btree.ts';
import { MemoryFile, type BlockFile } from './storage/file.ts';
import { Pager, type PagerOptions, type PagerStats } from './storage/pager.ts';
import {
  constraintError,
  DbError,
  semanticError,
  typeError,
  typeOfValue,
  type Value,
} from './types.ts';

export interface QueryResult {
  command: string;
  columns: string[];
  rows: Value[][];
  /** Rows inserted, updated or deleted. */
  changes: number;
  /** Plan tree, for EXPLAIN. */
  plan?: PlanJson;
  timeMs: number;
}

export type DatabaseOptions = PagerOptions;

export interface TableSummary {
  name: string;
  sql: string;
  columns: { name: string; type: string; notNull: boolean; primaryKey: boolean }[];
  indexes: { name: string; columns: string[]; unique: boolean; auto: boolean }[];
  rowCount: number;
  root: number;
}

export interface TreeView {
  name: string;
  kind: 'table' | 'index';
  keyColumns: string[];
  levels: { id: number; kind: 'leaf' | 'internal'; keys: Value[][]; children: number[]; next: number; bytes: number; overflowCells: number }[][];
  pageSize: number;
}

const NO_PARAMS: Value[] = [];

function emptyResult(command: string, changes = 0): QueryResult {
  return { command, columns: [], rows: [], changes, timeMs: 0 };
}

export function tableSql(t: TableInfo, indexes: IndexInfo[]): string {
  const cols = t.columns.map((c, i) => {
    let s = `  ${quoteIdent(c.name)} ${c.type}`;
    if (t.pk.length === 1 && t.pk[0] === i) s += ' PRIMARY KEY';
    else if (c.notNull) s += ' NOT NULL';
    if (c.default) s += ` DEFAULT ${exprToSql(c.default)}`;
    return s;
  });
  if (t.pk.length > 1) cols.push(`  PRIMARY KEY (${t.pk.map((i) => quoteIdent(t.columns[i]!.name)).join(', ')})`);
  for (const idx of indexes.filter((i) => i.auto)) cols.push(`  UNIQUE (${idx.columns.map((i) => quoteIdent(t.columns[i]!.name)).join(', ')})`);
  return `CREATE TABLE ${quoteIdent(t.name)} (\n${cols.join(',\n')}\n)`;
}

export class Database {
  private readonly pager: Pager;
  private catalog: Catalog;
  private explicitTxn = false;
  private execCounter = 0;
  private readonly parseCache = new Map<string, Statement[]>();
  /** Row counts per table for the planner's estimates; filled lazily, dropped on rollback. */
  private readonly rowCounts = new Map<string, number>();
  private closed = false;

  constructor(dbFile: BlockFile, walFile: BlockFile, opts: DatabaseOptions = {}) {
    this.pager = new Pager(dbFile, walFile, opts);
    if (this.pager.header().schemaRoot === 0) {
      this.pager.begin();
      const root = BTree.create(this.pager);
      this.pager.headerMut().schemaRoot = root;
      this.pager.commit();
    }
    this.catalog = new Catalog(this.pager, this.pager.header().schemaRoot);
  }

  /** A database that lives entirely in memory (still paged, logged and checksummed). */
  static memory(opts: DatabaseOptions = {}): Database {
    return new Database(new MemoryFile(), new MemoryFile(), opts);
  }

  private get ctx(): PlannerContext {
    return { catalog: this.catalog, tree: (root) => new BTree(this.pager, root), rowCount: (t) => this.rowCount(t) };
  }

  private rowCount(t: TableInfo): number {
    const key = t.name.toLowerCase();
    let n = this.rowCounts.get(key);
    if (n === undefined) {
      n = this.tree(t.root).count();
      this.rowCounts.set(key, n);
    }
    return n;
  }

  private adjustRowCount(t: TableInfo, delta: number): void {
    const key = t.name.toLowerCase();
    const n = this.rowCounts.get(key);
    if (n !== undefined) this.rowCounts.set(key, n + delta);
  }

  private tree(root: number): BTree {
    return new BTree(this.pager, root);
  }

  private env(params: readonly Value[], analyze = false): Env {
    return { params, outers: [], execId: ++this.execCounter, analyze };
  }

  private parse(sql: string): Statement[] {
    let stmts = this.parseCache.get(sql);
    if (!stmts) {
      stmts = parse(sql);
      if (this.parseCache.size >= 200) this.parseCache.delete(this.parseCache.keys().next().value!);
      this.parseCache.set(sql, stmts);
    }
    return stmts;
  }

  // ------------------------------------------------------------- public API

  /** Runs every statement in `sql` and returns one result per statement. */
  exec(sql: string, params: readonly Value[] = NO_PARAMS): QueryResult[] {
    this.assertOpen();
    return this.parse(sql).map((stmt) => {
      const t0 = performance.now();
      const result = this.run(stmt, params);
      result.timeMs = performance.now() - t0;
      return result;
    });
  }

  /** Runs a single statement. */
  query(sql: string, params: readonly Value[] = NO_PARAMS): QueryResult {
    const stmts = this.parse(sql);
    if (stmts.length !== 1) throw new DbError('MISUSE', `query() expects exactly one statement, got ${stmts.length}`);
    return this.exec(sql, params)[0]!;
  }

  /** Runs a query and returns its rows as objects keyed by column name. */
  all(sql: string, params: readonly Value[] = NO_PARAMS): Record<string, Value>[] {
    const r = this.query(sql, params);
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]!])));
  }

  /** Runs `fn` inside a transaction, committing on success and rolling back on error. */
  transaction<T>(fn: () => T): T {
    this.exec('BEGIN');
    try {
      const out = fn();
      this.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.explicitTxn) this.exec('ROLLBACK');
      throw e;
    }
  }

  get inTransaction(): boolean {
    return this.explicitTxn;
  }

  checkpoint(): void {
    if (this.explicitTxn) throw new DbError('MISUSE', 'cannot checkpoint inside a transaction');
    this.pager.checkpoint();
  }

  stats(): PagerStats {
    return this.pager.getStats();
  }

  close(): void {
    if (this.closed) return;
    this.explicitTxn = false;
    this.pager.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new DbError('MISUSE', 'database is closed');
  }

  tables(): TableSummary[] {
    return [...this.catalog.tables.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const idx = this.catalog.indexesOf(t.name);
        return {
          name: t.name,
          sql: tableSql(t, idx),
          root: t.root,
          rowCount: this.tree(t.root).count(),
          columns: t.columns.map((c, i) => ({ name: c.name, type: c.type, notNull: c.notNull, primaryKey: t.pk.includes(i) })),
          indexes: idx.map((i) => ({ name: i.name, unique: i.unique, auto: i.auto, columns: i.columns.map((c) => t.columns[c]?.name ?? ROWID) })),
        };
      });
  }

  /**
   * Verifies every B+ tree's structure and that each index matches its table
   * exactly. Returns a list of problems (empty means healthy).
   */
  checkIntegrity(): string[] {
    const problems: string[] = [];
    const attempt = (what: string, fn: () => void) => {
      try {
        fn();
      } catch (e) {
        problems.push(`${what}: ${(e as Error).message}`);
      }
    };
    attempt('schema', () => this.tree(this.pager.header().schemaRoot).check());
    for (const t of this.catalog.tables.values()) {
      let rows: Row[] = [];
      attempt(`table ${t.name}`, () => {
        this.tree(t.root).check();
        rows = [...this.scanAll(t)];
      });
      for (const idx of this.catalog.indexesOf(t.name)) {
        attempt(`index ${idx.name}`, () => {
          const info = this.tree(idx.root).check();
          if (info.entries !== rows.length) throw new Error(`has ${info.entries} entries but the table has ${rows.length} rows`);
          const tree = this.tree(idx.root);
          for (const row of rows) {
            const tkey = tableKey(t, row);
            if (!tree.has(indexKey(idx, row, tkey))) throw new Error(`missing entry for row ${JSON.stringify(row)}`);
          }
        });
      }
    }
    return problems;
  }

  /** The B+ tree of a table or index, level by level, with decoded keys. */
  inspectTree(name: string, maxNodes = 4000): TreeView {
    const t = this.catalog.findTable(name);
    const idx = t ? undefined : this.catalog.indexes.get(name.toLowerCase());
    if (!t && !idx) throw semanticError(`no such table or index: ${name}`);
    const table = t ?? this.catalog.getTable(idx!.table);
    const colName = (i: number) => table.columns[i]?.name ?? ROWID;
    const keyCols = t ? keyColumns(t).map(colName) : [...idx!.columns.map(colName), ...keyColumns(table).map(colName)];
    const levels = this.tree(t ? t.root : idx!.root)
      .inspect(maxNodes)
      .map((level) =>
        level.map((n) => ({ ...n, keys: n.keys.map((k) => { try { return decodeKey(k); } catch { return ['?']; } }) })),
      );
    return { name: t ? t.name : idx!.name, kind: t ? 'table' : 'index', keyColumns: keyCols, levels, pageSize: this.pager.pageSize };
  }

  // -------------------------------------------------------------- dispatch

  private run(stmt: Statement, params: readonly Value[]): QueryResult {
    switch (stmt.kind) {
      case 'select':
        return this.select(stmt, params);
      case 'explain':
        return this.explain(stmt.stmt, stmt.analyze, params);
      case 'begin':
        if (this.explicitTxn) throw new DbError('MISUSE', 'cannot BEGIN: a transaction is already active');
        this.pager.begin();
        this.explicitTxn = true;
        return emptyResult('BEGIN');
      case 'commit':
        if (!this.explicitTxn) throw new DbError('MISUSE', 'cannot COMMIT: no transaction is active');
        this.pager.commit();
        this.explicitTxn = false;
        return emptyResult('COMMIT');
      case 'rollback':
        if (!this.explicitTxn) throw new DbError('MISUSE', 'cannot ROLLBACK: no transaction is active');
        this.abort();
        return emptyResult('ROLLBACK');
      default:
        return this.write(() => this.modify(stmt, params));
    }
  }

  private abort(): void {
    this.pager.rollback();
    this.explicitTxn = false;
    this.rowCounts.clear();
    this.catalog = new Catalog(this.pager, this.pager.header().schemaRoot);
  }

  /** Runs a modification inside the current transaction, or its own if none. */
  private write(fn: () => QueryResult): QueryResult {
    if (this.explicitTxn) {
      try {
        return fn();
      } catch (e) {
        this.abort();
        if (e instanceof DbError) throw new DbError(e.code, `${e.message} (the transaction has been rolled back)`);
        throw e;
      }
    }
    this.pager.begin();
    try {
      const r = fn();
      this.pager.commit();
      return r;
    } catch (e) {
      this.abort();
      throw e;
    }
  }

  private modify(stmt: Statement, params: readonly Value[]): QueryResult {
    switch (stmt.kind) {
      case 'createTable': return this.createTable(stmt);
      case 'dropTable': return this.dropTable(stmt.name, stmt.ifExists);
      case 'createIndex': return this.createIndex(stmt);
      case 'dropIndex': return this.dropIndex(stmt.name, stmt.ifExists);
      case 'insert': return this.insert(stmt, params);
      case 'update': return this.update(stmt, params);
      case 'delete': return this.delete(stmt, params);
      default: throw new DbError('MISUSE', `unexpected statement ${stmt.kind}`);
    }
  }

  // ---------------------------------------------------------------- SELECT

  private planSelect(stmt: SelectStmt) {
    return new Planner(this.ctx).planSelect(stmt, null);
  }

  private select(stmt: SelectStmt, params: readonly Value[]): QueryResult {
    const p = this.planSelect(stmt);
    const rows = [...p.plan.rows(this.env(params))];
    return { command: 'SELECT', columns: p.columns, rows, changes: 0, timeMs: 0 };
  }

  private explain(stmt: Statement, analyze: boolean, params: readonly Value[]): QueryResult {
    let plan: PlanJson;
    const extra: string[] = [];
    if (stmt.kind === 'select') {
      const t0 = performance.now();
      const p = this.planSelect(stmt);
      const planMs = performance.now() - t0;
      if (analyze) {
        const t1 = performance.now();
        let n = 0;
        for (const _ of p.plan.rows(this.env(params, true))) n++;
        extra.push(`Planning time: ${planMs.toFixed(3)} ms`, `Execution time: ${(performance.now() - t1).toFixed(3)} ms`, `Rows returned: ${n}`);
      }
      plan = planToJson(p.plan, analyze);
    } else {
      if (analyze) throw new DbError('MISUSE', 'EXPLAIN ANALYZE is only supported for SELECT');
      plan = this.explainModification(stmt);
    }
    const lines = [...explainLines(plan), ...extra];
    return { command: 'EXPLAIN', columns: ['QUERY PLAN'], rows: lines.map((l) => [l]), changes: 0, plan, timeMs: 0 };
  }

  private explainModification(stmt: Statement): PlanJson {
    const node = (title: string, children: PlanJson[] = [], details: string[] = []): PlanJson => ({ title, details, actual: null, children });
    switch (stmt.kind) {
      case 'insert': {
        const t = this.catalog.getTable(stmt.table);
        const child = stmt.source.kind === 'values'
          ? node(`Values (${stmt.source.rows.length} row${stmt.source.rows.length === 1 ? '' : 's'})`)
          : planToJson(this.planSelect(stmt.source.select).plan, false);
        const idx = this.catalog.indexesOf(t.name);
        return node(`Insert on ${t.name}`, [child], idx.length ? [`maintains: ${idx.map((i) => i.name).join(', ')}`] : []);
      }
      case 'update':
      case 'delete': {
        const t = this.catalog.getTable(stmt.table);
        const { plan } = new Planner(this.ctx).planTableRows(t, stmt.where);
        return node(`${stmt.kind === 'update' ? 'Update' : 'Delete'} on ${t.name}`, [planToJson(plan, false)]);
      }
      default:
        throw new DbError('MISUSE', 'EXPLAIN supports SELECT, INSERT, UPDATE and DELETE');
    }
  }

  // ------------------------------------------------------------------- DDL

  private createTable(stmt: Statement & { kind: 'createTable' }): QueryResult {
    if (this.catalog.findTable(stmt.name)) {
      if (stmt.ifNotExists) return emptyResult('CREATE TABLE');
      throw semanticError(`table ${stmt.name} already exists`);
    }
    if (this.catalog.indexes.has(stmt.name.toLowerCase())) throw semanticError(`there is already an index named ${stmt.name}`);
    const seen = new Set<string>();
    for (const c of stmt.columns) {
      const lower = c.name.toLowerCase();
      if (lower === ROWID) throw semanticError('"rowid" is reserved and cannot be used as a column name');
      if (seen.has(lower)) throw semanticError(`duplicate column name: ${c.name}`);
      seen.add(lower);
    }
    if (stmt.columns.length === 0) throw semanticError('a table needs at least one column');

    const inlinePk = stmt.columns.map((c, i) => (c.primaryKey ? i : -1)).filter((i) => i >= 0);
    if (inlinePk.length > 1) throw semanticError('only one column can be declared PRIMARY KEY; use PRIMARY KEY (a, b) for a composite key');
    if (inlinePk.length > 0 && stmt.primaryKey) throw semanticError('multiple primary keys for table ' + stmt.name);
    const colIdx = (name: string) => {
      const i = stmt.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
      if (i < 0) throw semanticError(`no such column: ${name}`);
      return i;
    };
    const pk = stmt.primaryKey ? stmt.primaryKey.map(colIdx) : inlinePk;
    if (new Set(pk).size !== pk.length) throw semanticError('duplicate column in PRIMARY KEY');

    const empty = new Scope([], null);
    const columns: ColumnInfo[] = stmt.columns.map((c, i) => {
      if (c.default) {
        const v = this.constant(c.default, empty, 'DEFAULT', []);
        this.coerce({ name: c.name, type: c.type, notNull: false, default: null }, v, stmt.name);
      }
      return { name: c.name, type: c.type, notNull: c.notNull || pk.includes(i), default: c.default };
    });

    const t: TableInfo = { name: stmt.name, columns, pk, root: BTree.create(this.pager) };
    this.catalog.saveTable(t);

    const uniques = [...stmt.columns.filter((c) => c.unique).map((c) => [c.name]), ...stmt.uniques];
    for (const u of uniques) {
      const cols = u.map(colIdx);
      if (cols.length === pk.length && cols.every((c, i) => c === pk[i])) continue; // already unique
      this.buildIndex(t, `${t.name}_${u.join('_')}_key`.toLowerCase(), cols, true, true);
    }
    return emptyResult('CREATE TABLE');
  }

  private dropTable(name: string, ifExists: boolean): QueryResult {
    const t = this.catalog.findTable(name);
    if (!t) {
      if (ifExists) return emptyResult('DROP TABLE');
      throw semanticError(`no such table: ${name}`);
    }
    for (const idx of this.catalog.indexesOf(t.name)) {
      this.tree(idx.root).destroy();
      this.catalog.removeIndex(idx.name);
    }
    this.tree(t.root).destroy();
    this.catalog.removeTable(t.name);
    this.rowCounts.delete(t.name.toLowerCase());
    return emptyResult('DROP TABLE');
  }

  private createIndex(stmt: Statement & { kind: 'createIndex' }): QueryResult {
    if (this.catalog.indexes.has(stmt.name.toLowerCase())) {
      if (stmt.ifNotExists) return emptyResult('CREATE INDEX');
      throw semanticError(`index ${stmt.name} already exists`);
    }
    if (this.catalog.findTable(stmt.name)) throw semanticError(`there is already a table named ${stmt.name}`);
    const t = this.catalog.getTable(stmt.table);
    const cols = stmt.columns.map((c) => columnIndex(t, c));
    if (new Set(cols).size !== cols.length) throw semanticError('duplicate column in index');
    this.buildIndex(t, stmt.name, cols, stmt.unique, false);
    return emptyResult('CREATE INDEX');
  }

  private buildIndex(t: TableInfo, name: string, columns: number[], unique: boolean, auto: boolean): void {
    const idx: IndexInfo = { name, table: t.name, columns, unique, root: BTree.create(this.pager), auto };
    for (const row of this.scanAll(t)) this.addIndexEntry(t, idx, row, tableKey(t, row));
    this.catalog.saveIndex(idx);
  }

  private dropIndex(name: string, ifExists: boolean): QueryResult {
    const idx = this.catalog.indexes.get(name.toLowerCase());
    if (!idx) {
      if (ifExists) return emptyResult('DROP INDEX');
      throw semanticError(`no such index: ${name}`);
    }
    if (idx.auto) throw semanticError(`index ${name} enforces a UNIQUE constraint and cannot be dropped`);
    this.tree(idx.root).destroy();
    this.catalog.removeIndex(idx.name);
    return emptyResult('DROP INDEX');
  }

  // ------------------------------------------------------------------- DML

  private *scanAll(t: TableInfo): Generator<Row> {
    const { plan } = new Planner(this.ctx).planTableRows(t, null);
    yield* plan.rows(this.env(NO_PARAMS));
  }

  private constant(e: Expr, scope: Scope, clause: string, params: readonly Value[]): Value {
    const planner = new Planner(this.ctx);
    return planner.compile(e, scope, clause)([], this.env(params));
  }

  private coerce(col: ColumnInfo, v: Value, table: string): Value {
    if (v === null) return null;
    const ok =
      col.type === 'INTEGER' ? typeof v === 'number' && Number.isInteger(v)
      : col.type === 'REAL' ? typeof v === 'number'
      : col.type === 'TEXT' ? typeof v === 'string'
      : typeof v === 'boolean';
    if (!ok) {
      if (typeof v === 'number' && Number.isNaN(v)) throw typeError(`cannot store NaN in ${table}.${col.name}`);
      const shown = typeof v === 'string' ? `'${v}'` : String(v);
      throw typeError(`column ${table}.${col.name} is ${col.type}, but ${shown} is ${typeOfValue(v)}`);
    }
    if (typeof v === 'number' && !Number.isFinite(v)) throw typeError(`cannot store ${v} in ${table}.${col.name}`);
    return v;
  }

  private checkNotNull(t: TableInfo, row: Row): void {
    t.columns.forEach((c, i) => {
      if (c.notNull && row[i] === null) throw constraintError(`NOT NULL constraint failed: ${t.name}.${c.name}`);
    });
  }

  /**
   * Next value for a rowid or an INTEGER PRIMARY KEY left NULL: one more than
   * the current largest key (read from the rightmost leaf, so it is O(log n)
   * and can never go stale after deletes or rollbacks).
   */
  private allocateKey(t: TableInfo): number {
    const last = this.tree(t.root).last();
    if (!last) return 1;
    const max = decodeKey(last)[0];
    return typeof max === 'number' ? Math.floor(max) + 1 : 1;
  }

  private isAutoKey(t: TableInfo): boolean {
    return t.pk.length === 1 && t.columns[t.pk[0]!]!.type === 'INTEGER';
  }

  private uniqueViolation(t: TableInfo, cols: number[]): DbError {
    return constraintError(`UNIQUE constraint failed: ${cols.map((i) => `${t.name}.${t.columns[i]?.name ?? ROWID}`).join(', ')}`);
  }

  private addIndexEntry(t: TableInfo, idx: IndexInfo, row: Row, tkey: Uint8Array): void {
    const tree = this.tree(idx.root);
    if (idx.unique) {
      const vals = idx.columns.map((i) => row[i]!);
      if (vals.every((v) => v !== null)) {
        const prefix = encodeKey(vals);
        for (const _ of tree.scan({ lo: prefix, hi: prefixUpperBound(prefix)!, hiExclusive: true })) throw this.uniqueViolation(t, idx.columns);
      }
    }
    tree.insert(indexKey(idx, row, tkey), tkey);
  }

  private insertRow(t: TableInfo, row: Row): void {
    const full = hasRowid(t) ? [...row, this.allocateKey(t)] : row;
    if (!hasRowid(t)) {
      if (this.isAutoKey(t) && full[t.pk[0]!] === null) full[t.pk[0]!] = this.allocateKey(t);
    }
    this.checkNotNull(t, full);
    const key = tableKey(t, full);
    if (!this.tree(t.root).insert(key, encodeRow(full.slice(0, t.columns.length)))) throw this.uniqueViolation(t, t.pk);
    for (const idx of this.catalog.indexesOf(t.name)) this.addIndexEntry(t, idx, full, key);
    this.adjustRowCount(t, 1);
  }

  private insert(stmt: Statement & { kind: 'insert' }, params: readonly Value[]): QueryResult {
    const t = this.catalog.getTable(stmt.table);
    const target = stmt.columns
      ? stmt.columns.map((c) => {
          const i = columnIndex(t, c);
          if (i >= t.columns.length) throw semanticError('cannot insert into rowid');
          return i;
        })
      : t.columns.map((_, i) => i);
    if (new Set(target).size !== target.length) throw semanticError('column specified more than once in INSERT');

    let source: Row[];
    if (stmt.source.kind === 'values') {
      const scope = new Scope([], null);
      const planner = new Planner(this.ctx);
      const env = this.env(params);
      source = stmt.source.rows.map((exprs) => {
        if (exprs.length !== target.length) throw semanticError(`INSERT has ${exprs.length} values but ${target.length} columns`);
        return exprs.map((e) => planner.compile(e, scope, 'VALUES')([], env));
      });
    } else {
      const p = this.planSelect(stmt.source.select);
      if (p.columns.length !== target.length) throw semanticError(`INSERT has ${p.columns.length} values but ${target.length} columns`);
      source = [...p.plan.rows(this.env(params))]; // materialise first: never read our own inserts
    }

    const defaults = t.columns.map((c) => (c.default ? this.constant(c.default, new Scope([], null), 'DEFAULT', params) : null));
    for (const values of source) {
      const row: Row = defaults.slice();
      target.forEach((col, i) => (row[col] = values[i]!));
      for (let i = 0; i < row.length; i++) row[i] = this.coerce(t.columns[i]!, row[i]!, t.name);
      this.insertRow(t, row);
    }
    return emptyResult('INSERT', source.length);
  }

  private matchingRows(t: TableInfo, where: Expr | null, params: readonly Value[]): { rows: Row[]; scope: Scope; planner: Planner } {
    const planner = new Planner(this.ctx);
    const { plan, scope } = planner.planTableRows(t, where);
    // Collect every target row before changing anything (avoids the Halloween problem).
    return { rows: [...(plan as PlanNode).rows(this.env(params))], scope, planner };
  }

  private update(stmt: Statement & { kind: 'update' }, params: readonly Value[]): QueryResult {
    const t = this.catalog.getTable(stmt.table);
    const { rows, scope, planner } = this.matchingRows(t, stmt.where, params);
    const sets = stmt.sets.map((s) => {
      const col = columnIndex(t, s.column);
      if (col >= t.columns.length) throw semanticError('cannot update rowid');
      return { col, fn: planner.compile(s.expr, scope, 'SET') };
    });
    if (new Set(sets.map((s) => s.col)).size !== sets.length) throw semanticError('column assigned more than once in UPDATE');
    const indexes = this.catalog.indexesOf(t.name);
    const tree = this.tree(t.root);
    const env = this.env(params);
    const width = t.columns.length;

    for (const old of rows) {
      const next = old.slice();
      for (const s of sets) next[s.col] = this.coerce(t.columns[s.col]!, s.fn(old, env), t.name);
      this.checkNotNull(t, next);
      const oldKey = tableKey(t, old);
      const newKey = tableKey(t, next);
      const keyChanged = !bytesEqual(oldKey, newKey);
      for (const idx of indexes) {
        const changed = keyChanged || idx.columns.some((c) => old[c] !== next[c]);
        if (!changed) continue;
        this.tree(idx.root).delete(indexKey(idx, old, oldKey));
      }
      if (keyChanged) {
        tree.delete(oldKey);
        if (!tree.insert(newKey, encodeRow(next.slice(0, width)))) throw this.uniqueViolation(t, t.pk);
      } else {
        tree.insert(oldKey, encodeRow(next.slice(0, width)), true);
      }
      for (const idx of indexes) {
        const changed = keyChanged || idx.columns.some((c) => old[c] !== next[c]);
        if (changed) this.addIndexEntry(t, idx, next, newKey);
      }
    }
    return emptyResult('UPDATE', rows.length);
  }

  private delete(stmt: Statement & { kind: 'delete' }, params: readonly Value[]): QueryResult {
    const t = this.catalog.getTable(stmt.table);
    const { rows } = this.matchingRows(t, stmt.where, params);
    const indexes = this.catalog.indexesOf(t.name);
    const tree = this.tree(t.root);
    for (const row of rows) {
      const key = tableKey(t, row);
      tree.delete(key);
      for (const idx of indexes) this.tree(idx.root).delete(indexKey(idx, row, key));
    }
    this.adjustRowCount(t, -rows.length);
    return emptyResult('DELETE', rows.length);
  }
}
