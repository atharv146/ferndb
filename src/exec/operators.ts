/**
 * Physical query operators (the "Volcano" / iterator model). Every operator
 * is a generator that pulls rows from its children on demand, so a query
 * like `SELECT ... LIMIT 5` stops reading the table after five rows.
 */
import { hasRowid, type AccessPath, type TableInfo } from '../catalog.ts';
import { compareBytes } from '../encoding/bytes.ts';
import { decodeKey, encodeKey, prefixUpperBound } from '../encoding/keycodec.ts';
import { decodeRow } from '../encoding/rowcodec.ts';
import type { BTree, ScanRange } from '../storage/btree.ts';
import { compareValues, DbError, typeError, typeOfValue, type Value } from '../types.ts';
import { sqlCompare, truthy, type Compiled, type Env, type Row, type RowSource, type ScopeCol } from './expr.ts';

export interface TreeProvider {
  tree(root: number): BTree;
}

export interface NodeStats {
  rows: number;
  loops: number;
  ms: number;
}

export abstract class PlanNode implements RowSource {
  abstract readonly title: string;
  readonly schema: ScopeCol[];
  readonly children: PlanNode[];
  details: string[] = [];
  readonly actual: NodeStats = { rows: 0, loops: 0, ms: 0 };

  constructor(schema: ScopeCol[], children: PlanNode[] = []) {
    this.schema = schema;
    this.children = children;
  }

  protected abstract produce(env: Env): Iterable<Row>;

  rows(env: Env): Iterable<Row> {
    return env.analyze ? this.instrumented(env) : this.produce(env);
  }

  private *instrumented(env: Env): Generator<Row> {
    this.actual.loops++;
    const it = this.produce(env)[Symbol.iterator]();
    for (;;) {
      const t0 = performance.now();
      const n = it.next();
      this.actual.ms += performance.now() - t0;
      if (n.done) return;
      this.actual.rows++;
      yield n.value;
    }
  }
}

export function rowFromEntry(table: TableInfo, key: Uint8Array, value: Uint8Array): Row {
  const row = decodeRow(value);
  if (hasRowid(table)) row.push(decodeKey(key)[0]!);
  return row;
}

const rowKey = (values: readonly Value[]) => JSON.stringify(values);

// ------------------------------------------------------------------ sources

/** A single empty row: the source for `SELECT 1 + 1` with no FROM clause. */
export class OneRow extends PlanNode {
  readonly title = 'Result';
  constructor() {
    super([]);
  }
  protected *produce(): Generator<Row> {
    yield [];
  }
}

export class SeqScan extends PlanNode {
  readonly title: string;
  private readonly table: TableInfo;
  private readonly trees: TreeProvider;
  readonly reverse: boolean;

  constructor(schema: ScopeCol[], table: TableInfo, alias: string, trees: TreeProvider, reverse = false) {
    super(schema);
    this.table = table;
    this.trees = trees;
    this.reverse = reverse;
    this.title = `Seq Scan on ${table.name}${alias !== table.name.toLowerCase() ? ` ${alias}` : ''}${reverse ? ' (reverse)' : ''}`;
  }

  protected *produce(): Generator<Row> {
    for (const [k, v] of this.trees.tree(this.table.root).scan({ reverse: this.reverse })) {
      yield rowFromEntry(this.table, k, v);
    }
  }
}

export interface RangeBound {
  fn: Compiled;
  inclusive: boolean;
}

/** Equality prefix plus optional range on the next column, for one access path. */
export interface KeyRange {
  eq: Compiled[];
  /** If set, the last equality column takes any of these values (`col IN (...)`). */
  eqIn: Compiled[] | null;
  lo: RangeBound | null;
  hi: RangeBound | null;
}

function nullFree(values: Value[]): boolean {
  for (const v of values) if (v === null) return false;
  return true;
}

/** Turns an equality prefix and range bounds into byte-level B+ tree bounds. */
export function byteRange(eq: Value[], lo: { v: Value; inclusive: boolean } | null, hi: { v: Value; inclusive: boolean } | null): ScanRange | null {
  if (!nullFree(eq)) return null; // col = NULL never matches
  const prefix = encodeKey(eq);
  const range: ScanRange = {};
  if (lo) {
    if (lo.v === null) return null;
    const k = concat(prefix, encodeKey([lo.v]));
    if (lo.inclusive) range.lo = k;
    else range.lo = prefixUpperBound(k) ?? undefined;
  } else if (hi) {
    // An upper bound alone must still skip NULLs, which sort first.
    range.lo = prefixUpperBound(concat(prefix, encodeKey([null])))!;
  } else if (prefix.length > 0) {
    range.lo = prefix;
  }
  if (hi) {
    if (hi.v === null) return null;
    const k = concat(prefix, encodeKey([hi.v]));
    if (hi.inclusive) {
      const ub = prefixUpperBound(k);
      if (ub) {
        range.hi = ub;
        range.hiExclusive = true;
      }
    } else {
      range.hi = k;
      range.hiExclusive = true;
    }
  } else if (prefix.length > 0) {
    const ub = prefixUpperBound(prefix);
    if (ub) {
      range.hi = ub;
      range.hiExclusive = true;
    }
  }
  if (range.lo && range.hi && compareBytes(range.lo, range.hi) >= 0) return null;
  return range;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Yields rows of `table` reachable through `path` within a byte range. */
export function* scanPath(trees: TreeProvider, table: TableInfo, path: AccessPath, range: ScanRange): Generator<Row> {
  const tree = trees.tree(path.root);
  if (path.kind === 'pk') {
    for (const [k, v] of tree.scan(range)) yield rowFromEntry(table, k, v);
    return;
  }
  const base = trees.tree(table.root);
  for (const [, tkey] of tree.scan(range)) {
    const v = base.get(tkey);
    if (!v) throw new DbError('CORRUPT', `index ${path.name} points at a missing row`);
    yield rowFromEntry(table, tkey, v);
  }
}

/** Evaluates a KeyRange for one execution and yields matching rows. */
export function* scanKeyRange(trees: TreeProvider, table: TableInfo, path: AccessPath, kr: KeyRange, row: Row, env: Env, reverse: boolean): Generator<Row> {
  const eq = kr.eq.map((f) => f(row, env));
  const lo = kr.lo ? { v: kr.lo.fn(row, env), inclusive: kr.lo.inclusive } : null;
  const hi = kr.hi ? { v: kr.hi.fn(row, env), inclusive: kr.hi.inclusive } : null;
  if (!kr.eqIn) {
    const range = byteRange(eq, lo, hi);
    if (range) yield* scanPath(trees, table, path, { ...range, reverse });
    return;
  }
  const values = [...new Map(kr.eqIn.map((f) => f(row, env)).filter((v) => v !== null).map((v) => [rowKey([v]), v])).values()];
  values.sort(compareValues);
  if (reverse) values.reverse();
  for (const v of values) {
    const range = byteRange([...eq, v], lo, hi);
    if (range) yield* scanPath(trees, table, path, { ...range, reverse });
  }
}

export class IndexScan extends PlanNode {
  readonly title: string;
  private readonly table: TableInfo;
  private readonly path: AccessPath;
  private readonly range: KeyRange;
  private readonly trees: TreeProvider;
  readonly reverse: boolean;

  constructor(schema: ScopeCol[], table: TableInfo, alias: string, path: AccessPath, range: KeyRange, condition: string, trees: TreeProvider, reverse: boolean) {
    super(schema);
    this.table = table;
    this.path = path;
    this.range = range;
    this.trees = trees;
    this.reverse = reverse;
    const point = path.unique && range.eq.length === path.columns.length && !range.lo && !range.hi;
    const kind = path.kind === 'pk' ? (point ? 'PK Lookup' : 'PK Range Scan') : point ? 'Index Lookup' : 'Index Scan';
    const on = `${table.name}${alias !== table.name.toLowerCase() ? ` ${alias}` : ''}`;
    this.title = `${kind} on ${on}${path.kind === 'index' ? ` using ${path.name}` : ''}${reverse ? ' (reverse)' : ''}`;
    if (condition) this.details.push(`cond: ${condition}`);
  }

  protected produce(env: Env): Iterable<Row> {
    return scanKeyRange(this.trees, this.table, this.path, this.range, [], env, this.reverse);
  }
}

/** Re-labels a subquery's output with the alias it has in FROM. */
export class SubqueryScan extends PlanNode {
  readonly title: string;
  constructor(schema: ScopeCol[], child: PlanNode, alias: string) {
    super(schema, [child]);
    this.title = `Subquery Scan ${alias}`;
  }
  protected produce(env: Env): Iterable<Row> {
    return this.children[0]!.rows(env);
  }
}

// --------------------------------------------------------------- transforms

export class Filter extends PlanNode {
  readonly title = 'Filter';
  private readonly pred: Compiled;
  constructor(child: PlanNode, pred: Compiled, text: string) {
    super(child.schema, [child]);
    this.pred = pred;
    this.details.push(text);
  }
  protected *produce(env: Env): Generator<Row> {
    const pred = this.pred;
    for (const row of this.children[0]!.rows(env)) if (truthy(pred(row, env)) === true) yield row;
  }
}

export class Project extends PlanNode {
  readonly title = 'Project';
  private readonly exprs: Compiled[];
  constructor(child: PlanNode, exprs: Compiled[], schema: ScopeCol[], texts: string[]) {
    super(schema, [child]);
    this.exprs = exprs;
    this.details.push(texts.join(', '));
  }
  protected *produce(env: Env): Generator<Row> {
    const exprs = this.exprs;
    for (const row of this.children[0]!.rows(env)) {
      const out: Row = new Array(exprs.length);
      for (let i = 0; i < exprs.length; i++) out[i] = exprs[i]!(row, env);
      yield out;
    }
  }
}

// -------------------------------------------------------------------- joins

export class NestedLoopJoin extends PlanNode {
  readonly title: string;
  private readonly cond: Compiled | null;
  private readonly leftJoin: boolean;

  constructor(left: PlanNode, right: PlanNode, cond: Compiled | null, condText: string, leftJoin: boolean) {
    super([...left.schema, ...right.schema], [left, right]);
    this.cond = cond;
    this.leftJoin = leftJoin;
    this.title = `Nested Loop ${leftJoin ? 'Left ' : ''}Join`;
    if (condText) this.details.push(`on: ${condText}`);
  }

  protected *produce(env: Env): Generator<Row> {
    const [left, right] = this.children as [PlanNode, PlanNode];
    const inner = [...right.rows(env)];
    const pad = new Array<Value>(right.schema.length).fill(null);
    for (const l of left.rows(env)) {
      let matched = false;
      for (const r of inner) {
        const row = [...l, ...r];
        if (this.cond === null || truthy(this.cond(row, env)) === true) {
          matched = true;
          yield row;
        }
      }
      if (!matched && this.leftJoin) yield [...l, ...pad];
    }
  }
}

export class HashJoin extends PlanNode {
  readonly title: string;
  private readonly leftKeys: Compiled[];
  private readonly rightKeys: Compiled[];
  private readonly residual: Compiled | null;
  private readonly leftJoin: boolean;

  constructor(left: PlanNode, right: PlanNode, leftKeys: Compiled[], rightKeys: Compiled[], residual: Compiled | null, texts: { keys: string; residual: string }, leftJoin: boolean) {
    super([...left.schema, ...right.schema], [left, right]);
    this.leftKeys = leftKeys;
    this.rightKeys = rightKeys;
    this.residual = residual;
    this.leftJoin = leftJoin;
    this.title = `Hash ${leftJoin ? 'Left ' : ''}Join`;
    this.details.push(`hash cond: ${texts.keys}`);
    if (texts.residual) this.details.push(`filter: ${texts.residual}`);
  }

  protected *produce(env: Env): Generator<Row> {
    const [left, right] = this.children as [PlanNode, PlanNode];
    const table = new Map<string, Row[]>();
    for (const r of right.rows(env)) {
      const key = this.rightKeys.map((f) => f(r, env));
      if (!nullFree(key)) continue;
      const k = rowKey(key);
      const bucket = table.get(k);
      if (bucket) bucket.push(r);
      else table.set(k, [r]);
    }
    const pad = new Array<Value>(right.schema.length).fill(null);
    for (const l of left.rows(env)) {
      const key = this.leftKeys.map((f) => f(l, env));
      let matched = false;
      const bucket = nullFree(key) ? table.get(rowKey(key)) : undefined;
      if (bucket) {
        for (const r of bucket) {
          const row = [...l, ...r];
          if (this.residual === null || truthy(this.residual(row, env)) === true) {
            matched = true;
            yield row;
          }
        }
      }
      if (!matched && this.leftJoin) yield [...l, ...pad];
    }
  }
}

/** For each outer row, probes the inner table through its primary key or an index. */
export class IndexNestedLoopJoin extends PlanNode {
  readonly title: string;
  private readonly table: TableInfo;
  private readonly path: AccessPath;
  private readonly range: KeyRange;
  private readonly innerFilter: Compiled | null;
  private readonly residual: Compiled | null;
  private readonly leftJoin: boolean;
  private readonly trees: TreeProvider;
  private readonly innerWidth: number;

  constructor(
    left: PlanNode, innerSchema: ScopeCol[], table: TableInfo, alias: string, path: AccessPath, range: KeyRange,
    innerFilter: Compiled | null, residual: Compiled | null, texts: { lookup: string; filter: string; residual: string },
    leftJoin: boolean, trees: TreeProvider,
  ) {
    super([...left.schema, ...innerSchema], [left]);
    this.table = table;
    this.path = path;
    this.range = range;
    this.innerFilter = innerFilter;
    this.residual = residual;
    this.leftJoin = leftJoin;
    this.trees = trees;
    this.innerWidth = innerSchema.length;
    const on = `${table.name}${alias !== table.name.toLowerCase() ? ` ${alias}` : ''}`;
    this.title = `Index Nested Loop ${leftJoin ? 'Left ' : ''}Join`;
    this.details.push(`probe ${on} using ${path.name}: ${texts.lookup}`);
    if (texts.filter) this.details.push(`inner filter: ${texts.filter}`);
    if (texts.residual) this.details.push(`filter: ${texts.residual}`);
  }

  protected *produce(env: Env): Generator<Row> {
    const pad = new Array<Value>(this.innerWidth).fill(null);
    for (const l of this.children[0]!.rows(env)) {
      let matched = false;
      for (const r of scanKeyRange(this.trees, this.table, this.path, this.range, l, env, false)) {
        if (this.innerFilter && truthy(this.innerFilter(r, env)) !== true) continue;
        const row = [...l, ...r];
        if (this.residual && truthy(this.residual(row, env)) !== true) continue;
        matched = true;
        yield row;
      }
      if (!matched && this.leftJoin) yield [...l, ...pad];
    }
  }
}

// -------------------------------------------------------------- aggregation

export interface AggSpec {
  fn: string;
  arg: Compiled | null;
  separator: Compiled | null;
  distinct: boolean;
}

interface Acc {
  count: number;
  value: Value;
  parts: string[];
  seen: Set<string> | null;
}

function newAcc(spec: AggSpec): Acc {
  return { count: 0, value: null, parts: [], seen: spec.distinct ? new Set() : null };
}

function accumulate(spec: AggSpec, acc: Acc, row: Row, env: Env): void {
  if (spec.arg === null) {
    acc.count++; // COUNT(*)
    return;
  }
  const v = spec.arg(row, env);
  if (v === null) return;
  if (acc.seen) {
    const k = rowKey([v]);
    if (acc.seen.has(k)) return;
    acc.seen.add(k);
  }
  acc.count++;
  switch (spec.fn) {
    case 'SUM':
    case 'AVG':
      if (typeof v !== 'number') throw typeError(`${spec.fn.toLowerCase()}() expects numbers, got ${typeOfValue(v)}`);
      acc.value = ((acc.value as number | null) ?? 0) + v;
      break;
    case 'MIN':
      if (acc.value === null || sqlCompare(v, acc.value) < 0) acc.value = v;
      break;
    case 'MAX':
      if (acc.value === null || sqlCompare(v, acc.value) > 0) acc.value = v;
      break;
    case 'GROUP_CONCAT':
    case 'STRING_AGG': {
      const sep = spec.separator ? spec.separator(row, env) : ',';
      if (acc.parts.length > 0) acc.parts.push(sep === null ? '' : String(sep));
      acc.parts.push(typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
      break;
    }
    default:
      break;
  }
}

function finish(spec: AggSpec, acc: Acc): Value {
  switch (spec.fn) {
    case 'COUNT': return acc.count;
    case 'AVG': return acc.count === 0 ? null : (acc.value as number) / acc.count;
    case 'GROUP_CONCAT':
    case 'STRING_AGG': return acc.count === 0 ? null : acc.parts.join('');
    default: return acc.value;
  }
}

export class HashAggregate extends PlanNode {
  readonly title: string;
  private readonly groups: Compiled[];
  private readonly aggs: AggSpec[];

  constructor(child: PlanNode, groups: Compiled[], aggs: AggSpec[], schema: ScopeCol[], texts: { groups: string; aggs: string }) {
    super(schema, [child]);
    this.groups = groups;
    this.aggs = aggs;
    this.title = groups.length > 0 ? 'Hash Aggregate' : 'Aggregate';
    if (texts.groups) this.details.push(`group by: ${texts.groups}`);
    if (texts.aggs) this.details.push(`aggregates: ${texts.aggs}`);
  }

  protected *produce(env: Env): Generator<Row> {
    const table = new Map<string, { key: Value[]; accs: Acc[] }>();
    for (const row of this.children[0]!.rows(env)) {
      const key = this.groups.map((g) => g(row, env));
      const k = rowKey(key);
      let entry = table.get(k);
      if (!entry) {
        entry = { key, accs: this.aggs.map(newAcc) };
        table.set(k, entry);
      }
      for (let i = 0; i < this.aggs.length; i++) accumulate(this.aggs[i]!, entry.accs[i]!, row, env);
    }
    if (table.size === 0 && this.groups.length === 0) {
      yield this.aggs.map((a) => finish(a, newAcc(a)));
      return;
    }
    for (const { key, accs } of table.values()) yield [...key, ...this.aggs.map((a, i) => finish(a, accs[i]!))];
  }
}

// ------------------------------------------------------ ordering and limits

export interface SortKey {
  index: number;
  desc: boolean;
}

export function compareRows(keys: SortKey[]): (a: Row, b: Row) => number {
  return (a, b) => {
    for (const k of keys) {
      const c = compareValues(a[k.index]!, b[k.index]!);
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  };
}

/** Sorts its input. With a limit it becomes a bounded-heap top-N sort. */
export class Sort extends PlanNode {
  readonly title: string;
  private readonly keys: SortKey[];
  private readonly keep: number;
  private readonly topN: Compiled | null;

  constructor(child: PlanNode, keys: SortKey[], keyText: string, keep: number, topN: Compiled | null) {
    super(child.schema.slice(0, keep), [child]);
    this.keys = keys;
    this.keep = keep;
    this.topN = topN;
    this.title = topN ? 'Top-N Sort' : 'Sort';
    this.details.push(`key: ${keyText}`);
  }

  protected *produce(env: Env): Generator<Row> {
    const cmp = compareRows(this.keys);
    const input = this.children[0]!.rows(env);
    let rows: Row[];
    if (this.topN) {
      const n = this.topN([], env) as number;
      rows = topN(input, n, cmp);
    } else {
      rows = [...input];
      rows.sort(cmp);
    }
    const trim = this.keep < this.children[0]!.schema.length;
    for (const r of rows) yield trim ? r.slice(0, this.keep) : r;
  }
}

/** Keeps the n smallest rows using a max-heap: O(N log n) time, O(n) memory. */
function topN(input: Iterable<Row>, n: number, cmp: (a: Row, b: Row) => number): Row[] {
  if (n <= 0) return [];
  const heap: { row: Row; seq: number }[] = [];
  // Ties are broken by arrival order so the result matches a stable sort.
  const less = (a: { row: Row; seq: number }, b: { row: Row; seq: number }) => {
    const c = cmp(a.row, b.row);
    return c !== 0 ? c < 0 : a.seq < b.seq;
  };
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[p]!, heap[i]!)) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[m]!, heap[l]!)) m = l;
      if (r < heap.length && less(heap[m]!, heap[r]!)) m = r;
      if (m === i) return;
      [heap[m], heap[i]] = [heap[i]!, heap[m]!];
      i = m;
    }
  };
  let seq = 0;
  for (const row of input) {
    const item = { row, seq: seq++ };
    if (heap.length < n) {
      heap.push(item);
      up(heap.length - 1);
    } else if (less(item, heap[0]!)) {
      heap[0] = item;
      down(0);
    }
  }
  return heap.sort((a, b) => (less(a, b) ? -1 : 1)).map((h) => h.row);
}

export function evalCount(fn: Compiled | null, env: Env, what: string): number | null {
  if (!fn) return null;
  const v = fn([], env);
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw typeError(`${what} must be a non-negative integer`);
  return v;
}

export class Limit extends PlanNode {
  readonly title = 'Limit';
  private readonly limit: Compiled | null;
  private readonly offset: Compiled | null;

  constructor(child: PlanNode, limit: Compiled | null, offset: Compiled | null, text: string) {
    super(child.schema, [child]);
    this.limit = limit;
    this.offset = offset;
    this.details.push(text);
  }

  protected *produce(env: Env): Generator<Row> {
    const limit = evalCount(this.limit, env, 'LIMIT') ?? Infinity;
    let skip = evalCount(this.offset, env, 'OFFSET') ?? 0;
    if (limit === 0) return;
    let n = 0;
    for (const row of this.children[0]!.rows(env)) {
      if (skip > 0) {
        skip--;
        continue;
      }
      yield row;
      if (++n >= limit) return;
    }
  }
}

export class Distinct extends PlanNode {
  readonly title = 'Distinct';
  constructor(child: PlanNode) {
    super(child.schema, [child]);
  }
  protected *produce(env: Env): Generator<Row> {
    const seen = new Set<string>();
    for (const row of this.children[0]!.rows(env)) {
      const k = rowKey(row);
      if (seen.has(k)) continue;
      seen.add(k);
      yield row;
    }
  }
}

export class SetOperation extends PlanNode {
  readonly title: string;
  private readonly op: string;

  constructor(op: string, left: PlanNode, right: PlanNode) {
    super(left.schema, [left, right]);
    this.op = op;
    this.title = op === 'UNION ALL' ? 'Append' : op.charAt(0) + op.slice(1).toLowerCase();
  }

  protected *produce(env: Env): Generator<Row> {
    const [left, right] = this.children as [PlanNode, PlanNode];
    if (this.op === 'UNION ALL') {
      yield* left.rows(env);
      yield* right.rows(env);
      return;
    }
    const seen = new Set<string>();
    if (this.op === 'UNION') {
      for (const src of [left, right]) {
        for (const row of src.rows(env)) {
          const k = rowKey(row);
          if (!seen.has(k)) {
            seen.add(k);
            yield row;
          }
        }
      }
      return;
    }
    const rightKeys = new Set<string>();
    for (const row of right.rows(env)) rightKeys.add(rowKey(row));
    const keepIfInRight = this.op === 'INTERSECT';
    for (const row of left.rows(env)) {
      const k = rowKey(row);
      if (seen.has(k) || rightKeys.has(k) !== keepIfInRight) continue;
      seen.add(k);
      yield row;
    }
  }
}

// ------------------------------------------------------------------ explain

export interface PlanJson {
  title: string;
  details: string[];
  actual: NodeStats | null;
  children: PlanJson[];
}

export function planToJson(node: PlanNode, analyze: boolean): PlanJson {
  return {
    title: node.title,
    details: node.details,
    actual: analyze ? { ...node.actual } : null,
    children: node.children.map((c) => planToJson(c, analyze)),
  };
}

export function explainLines(node: PlanJson): string[] {
  const out: string[] = [];
  const visit = (n: PlanJson, prefix: string, childPrefix: string) => {
    let line = prefix + n.title;
    if (n.actual) line += `  (rows=${n.actual.rows} loops=${n.actual.loops} time=${n.actual.ms.toFixed(3)}ms)`;
    out.push(line);
    const detailPrefix = childPrefix + (n.children.length > 0 ? '│  ' : '   ');
    for (const d of n.details) out.push(`${detailPrefix}${d}`);
    n.children.forEach((c, i) => {
      const last = i === n.children.length - 1;
      visit(c, childPrefix + (last ? '└─ ' : '├─ '), childPrefix + (last ? '   ' : '│  '));
    });
  };
  visit(node, '', '');
  return out;
}
