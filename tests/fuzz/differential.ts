/**
 * Differential fuzzing against SQLite (bundled with Node as node:sqlite).
 *
 * A seeded generator builds random data, indexes, queries and modifications
 * restricted to the SQL subset where FernDB and SQLite agree on semantics
 * (no division, no LIKE since SQLite's is case-insensitive, consistent
 * types). Both engines run everything and must produce identical rows,
 * identical errors-or-not, and identical table contents.
 */
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/index.ts';
import type { Value } from '../../src/types.ts';

export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

type Col = { name: string; kind: 'int' | 'text' };
const T1: Col[] = [{ name: 'id', kind: 'int' }, { name: 'a', kind: 'int' }, { name: 'b', kind: 'text' }, { name: 'c', kind: 'int' }];
const T2: Col[] = [{ name: 'id', kind: 'int' }, { name: 'a', kind: 'int' }, { name: 'b', kind: 'text' }, { name: 'd', kind: 'int' }];
const TEXTS = ['a', 'b', 'c', 'ab', 'B', '', 'zz'];

function lit(r: Rng, kind: 'int' | 'text', nullable = true): string {
  if (nullable && r.chance(0.1)) return 'NULL';
  return kind === 'int' ? String(r.int(-3, 10)) : `'${r.pick(TEXTS)}'`;
}

function intExpr(r: Rng, cols: string[]): string {
  const c = r.pick(cols);
  if (r.chance(0.2)) return `${c} + ${r.pick(cols)}`;
  if (r.chance(0.15)) return `${c} * ${r.int(-2, 3)}`;
  if (r.chance(0.1)) return `abs(${c})`;
  return c;
}

function predicate(r: Rng, cols: { q: string; kind: 'int' | 'text' }[], depth = 0): string {
  if (depth < 2 && r.chance(0.35)) {
    const op = r.pick(['AND', 'OR']);
    const p = `(${predicate(r, cols, depth + 1)} ${op} ${predicate(r, cols, depth + 1)})`;
    return r.chance(0.15) ? `NOT ${p}` : p;
  }
  const col = r.pick(cols);
  const ints = cols.filter((c) => c.kind === 'int').map((c) => c.q);
  switch (r.int(0, 6)) {
    case 0:
      return `${col.q} IS ${r.chance(0.5) ? 'NOT ' : ''}NULL`;
    case 1: {
      const lo = r.int(-3, 6);
      return `${col.kind === 'int' ? col.q : r.pick(ints)} ${r.chance(0.2) ? 'NOT ' : ''}BETWEEN ${lo} AND ${lo + r.int(0, 6)}`;
    }
    case 2: {
      const items = Array.from({ length: r.int(1, 4) }, () => lit(r, col.kind, r.chance(0.3)));
      return `${col.q} ${r.chance(0.25) ? 'NOT ' : ''}IN (${items.join(', ')})`;
    }
    case 3:
      return `${intExpr(r, ints)} ${r.pick(['=', '<>', '<', '<=', '>', '>='])} ${lit(r, 'int')}`;
    case 4:
      return `${r.pick(ints)} ${r.pick(['=', '<', '>='])} ${r.pick(ints)}`;
    default:
      return `${col.q} ${r.pick(['=', '<>', '<', '<=', '>', '>='])} ${lit(r, col.kind)}`;
  }
}

export function genSetup(r: Rng): string[] {
  const out = [
    'CREATE TABLE t1 (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, c INTEGER)',
    'CREATE TABLE t2 (id INTEGER PRIMARY KEY, a INTEGER, b TEXT, d INTEGER)',
  ];
  for (const [name, stmt] of [
    ['t1_a', 'CREATE INDEX t1_a ON t1 (a)'],
    ['t1_bc', 'CREATE INDEX t1_bc ON t1 (b, c)'],
    ['t2_a', 'CREATE INDEX t2_a ON t2 (a)'],
    ['t2_d', 'CREATE INDEX t2_d ON t2 (d)'],
  ] as const) {
    void name;
    if (r.chance(0.5)) out.push(stmt);
  }
  const n1 = r.int(0, 60);
  for (let i = 0; i < n1; i++) out.push(`INSERT INTO t1 (a, b, c) VALUES (${lit(r, 'int')}, ${lit(r, 'text')}, ${r.chance(0.15) ? 'NULL' : r.int(0, 5)})`);
  const n2 = r.int(0, 40);
  for (let i = 0; i < n2; i++) out.push(`INSERT INTO t2 (a, b, d) VALUES (${lit(r, 'int')}, ${lit(r, 'text')}, ${r.chance(0.15) ? 'NULL' : r.int(0, 5)})`);
  return out;
}

export function genQuery(r: Rng): string {
  let from: string;
  let cols: { q: string; kind: 'int' | 'text' }[];
  if (r.chance(0.45)) {
    const kind = r.pick(['JOIN', 'LEFT JOIN', 'JOIN', 'LEFT JOIN', 'CROSS JOIN']);
    const on = kind === 'CROSS JOIN' ? '' : ` ON ${r.pick(['t1.a = t2.a', 't1.c = t2.d', 't2.id = t1.c', 't1.a < t2.d', 't1.b = t2.b', 't1.a = t2.a AND t2.d > 1', 't2.a = t1.a + 1'])}`;
    from = `t1 ${kind} t2${on}`;
    cols = [...T1.map((c) => ({ q: `t1.${c.name}`, kind: c.kind })), ...T2.map((c) => ({ q: `t2.${c.name}`, kind: c.kind }))];
  } else {
    const t = r.pick(['t1', 't2']);
    from = t;
    cols = (t === 't1' ? T1 : T2).map((c) => ({ q: c.name, kind: c.kind }));
  }
  const where = r.chance(0.7) ? ` WHERE ${predicate(r, cols)}` : '';
  const ints = cols.filter((c) => c.kind === 'int').map((c) => c.q);

  let select: string;
  let n: number;
  let groupBy = '';
  let having = '';
  let distinct = '';
  if (r.chance(0.35)) {
    const groups = Array.from({ length: r.int(0, 2) }, () => r.pick(cols).q);
    const uniq = [...new Set(groups)];
    const aggs = Array.from({ length: r.int(1, 3) }, () =>
      r.pick([
        'count(*)',
        `count(${r.pick(cols).q})`,
        `sum(${r.pick(ints)})`,
        `min(${r.pick(cols).q})`,
        `max(${r.pick(cols).q})`,
        `count(DISTINCT ${r.pick(cols).q})`,
        `sum(${intExpr(r, ints)})`,
      ]),
    );
    select = [...uniq, ...aggs].join(', ');
    n = uniq.length + aggs.length;
    if (uniq.length) groupBy = ` GROUP BY ${uniq.join(', ')}`;
    if (uniq.length && r.chance(0.3)) having = ` HAVING count(*) > ${r.int(0, 3)}`;
  } else {
    const exprs = Array.from({ length: r.int(1, 3) }, () => (r.chance(0.25) ? intExpr(r, ints) : r.pick(cols).q));
    select = exprs.join(', ');
    n = exprs.length;
    if (r.chance(0.2)) distinct = 'DISTINCT ';
  }
  const order = Array.from({ length: n }, (_, i) => `${i + 1}${r.chance(0.4) ? ' DESC' : ''}`).join(', ');
  const limit = r.chance(0.4) ? ` LIMIT ${r.int(0, 12)}${r.chance(0.3) ? ` OFFSET ${r.int(0, 5)}` : ''}` : '';
  return `SELECT ${distinct}${select} FROM ${from}${where}${groupBy}${having} ORDER BY ${order}${limit}`;
}

export function genModification(r: Rng): string {
  const t = r.pick(['t1', 't2']);
  const cols = (t === 't1' ? T1 : T2).map((c) => ({ q: c.name, kind: c.kind }));
  const last = t === 't1' ? 'c' : 'd';
  switch (r.int(0, 3)) {
    case 0:
      return `INSERT INTO ${t} (a, b, ${last}) VALUES (${lit(r, 'int')}, ${lit(r, 'text')}, ${r.int(0, 5)})`;
    case 1:
      return `INSERT INTO ${t} (id, a) VALUES (${r.int(1, 80)}, ${lit(r, 'int')})`;
    case 2:
      return `UPDATE ${t} SET a = ${r.chance(0.5) ? 'a + 1' : lit(r, 'int')}, b = ${lit(r, 'text')} WHERE ${predicate(r, cols)}`;
    default:
      return `DELETE FROM ${t} WHERE ${predicate(r, cols)}`;
  }
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  return JSON.stringify(v);
}

export interface Mismatch {
  seed: number;
  sql: string;
  fern: string;
  sqlite: string;
}

/** Runs one seeded scenario; returns the first mismatch, or null. */
export function runScenario(seed: number, queries = 40, mods = 15): Mismatch | null {
  const r = rng(seed);
  const fern = Database.memory({ pageSize: 256 });
  const lite = new DatabaseSync(':memory:');

  const both = (sql: string, isQuery: boolean): Mismatch | null => {
    let a: string;
    let b: string;
    try {
      const res = fern.query(sql);
      a = isQuery ? res.rows.map((row) => row.map(norm).join('|')).join('\n') : 'ok';
    } catch (e) {
      a = `error`;
      if (!/constraint|UNIQUE/i.test((e as Error).message)) a = `error: ${(e as Error).message}`;
    }
    try {
      if (isQuery) {
        const stmt = lite.prepare(sql);
        stmt.setReturnArrays(true);
        const rows = stmt.all() as unknown as Value[][];
        b = rows.map((row) => row.map(norm).join('|')).join('\n');
      } else {
        lite.exec(sql);
        b = 'ok';
      }
    } catch (e) {
      b = 'error';
      if (!/constraint/i.test((e as Error).message)) b = `error: ${(e as Error).message}`;
    }
    return a === b ? null : { seed, sql, fern: a, sqlite: b };
  };

  for (const sql of genSetup(r)) {
    const m = both(sql, false);
    if (m) return m;
  }
  for (let i = 0; i < queries + mods; i++) {
    const isQuery = r.next() < queries / (queries + mods);
    const sql = isQuery ? genQuery(r) : genModification(r);
    const m = both(sql, isQuery);
    if (m) return m;
    if (!isQuery) {
      for (const t of ['t1', 't2']) {
        const m2 = both(`SELECT * FROM ${t} ORDER BY id`, true);
        if (m2) return { ...m2, sql: `${sql}\n-- then: ${m2.sql}` };
      }
    }
  }
  const problems = fern.checkIntegrity();
  if (problems.length) return { seed, sql: '(integrity check)', fern: problems.join('; '), sqlite: '' };
  lite.close();
  return null;
}
