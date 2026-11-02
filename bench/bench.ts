/**
 * Micro-benchmarks, run against an on-disk FernDB file and, for context, the
 * SQLite build bundled with Node. Prints a Markdown table.
 *
 *   npm run bench            (N = 100_000 rows)
 *   npm run bench -- 20000
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/node.ts';

const N = Number(process.argv[2] ?? 100_000);
const dir = mkdtempSync(join(tmpdir(), 'ferndb-bench-'));
const fern = openDatabase(join(dir, 'bench.fern'));
const lite = new DatabaseSync(join(dir, 'bench.sqlite'));
// Same durability as FernDB: on macOS, Node's fsync issues F_FULLFSYNC, so ask SQLite for it too.
lite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;');

const rand = (() => {
  let s = 42;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
})();
const cities = ['Fremont', 'Berkeley', 'Oakland', 'San Jose', 'Palo Alto', 'Los Angeles', 'Seattle', 'Austin'];
const people = Array.from({ length: N }, (_, i) => [i + 1, `user${i + 1}`, cities[Math.floor(rand() * cities.length)]!, Math.floor(rand() * 80) + 18] as const);
const orders = Array.from({ length: N }, (_, i) => [i + 1, Math.floor(rand() * N) + 1, Math.round(rand() * 50000) / 100] as const);

const schema = `
  CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, city TEXT, age INTEGER);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, person_id INTEGER, amount REAL);
`;
fern.exec(schema);
lite.exec(schema);

interface Row {
  name: string;
  ops: number;
  fern: number;
  lite: number;
}
const results: Row[] = [];

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function bench(name: string, ops: number, f: () => void, l: () => void): void {
  const fernMs = time(f);
  const liteMs = time(l);
  results.push({ name, ops, fern: fernMs, lite: liteMs });
  process.stderr.write(`  ${name}: ferndb ${fernMs.toFixed(0)} ms, sqlite ${liteMs.toFixed(0)} ms\n`);
}

bench(
  `Bulk insert ${N.toLocaleString()} rows (1 transaction)`,
  N,
  () => fern.transaction(() => {
    for (const p of people) fern.query('INSERT INTO people VALUES (?, ?, ?, ?)', p);
  }),
  () => {
    const st = lite.prepare('INSERT INTO people VALUES (?, ?, ?, ?)');
    lite.exec('BEGIN');
    for (const p of people) st.run(...p);
    lite.exec('COMMIT');
  },
);
fern.transaction(() => {
  for (const o of orders) fern.query('INSERT INTO orders VALUES (?, ?, ?)', o);
});
{
  const st = lite.prepare('INSERT INTO orders VALUES (?, ?, ?)');
  lite.exec('BEGIN');
  for (const o of orders) st.run(...o);
  lite.exec('COMMIT');
}

const COMMITS = 500;
bench(
  `${COMMITS} single-row transactions (fsync each)`,
  COMMITS,
  () => {
    for (let i = 0; i < COMMITS; i++) fern.query('UPDATE people SET age = age + 1 WHERE id = ?', [i + 1]);
  },
  () => {
    const st = lite.prepare('UPDATE people SET age = age + 1 WHERE id = ?');
    for (let i = 0; i < COMMITS; i++) st.run(i + 1);
  },
);

const LOOKUPS = 50_000;
const ids = Array.from({ length: LOOKUPS }, () => Math.floor(rand() * N) + 1);
bench(
  `${LOOKUPS.toLocaleString()} primary-key lookups`,
  LOOKUPS,
  () => {
    for (const id of ids) fern.query('SELECT name FROM people WHERE id = ?', [id]);
  },
  () => {
    const st = lite.prepare('SELECT name FROM people WHERE id = ?');
    for (const id of ids) st.get(id);
  },
);

bench(
  'Full scan + filter + aggregate',
  1,
  () => fern.query("SELECT city, count(*), avg(age) FROM people WHERE age > 40 GROUP BY city"),
  () => lite.prepare("SELECT city, count(*), avg(age) FROM people WHERE age > 40 GROUP BY city").all(),
);

const Q = 200;
const qs = Array.from({ length: Q }, () => Math.floor(rand() * N) + 1);
bench(
  `${Q} lookups on orders.person_id, no index`,
  Q,
  () => {
    for (const p of qs) fern.query('SELECT sum(amount) FROM orders WHERE person_id = ?', [p]);
  },
  () => {
    const st = lite.prepare('SELECT sum(amount) FROM orders WHERE person_id = ?');
    for (const p of qs) st.get(p);
  },
);
bench(
  'CREATE INDEX on orders.person_id',
  1,
  () => fern.exec('CREATE INDEX orders_person ON orders (person_id)'),
  () => lite.exec('CREATE INDEX orders_person ON orders (person_id)'),
);
bench(
  `${Q} lookups on orders.person_id, with index`,
  Q,
  () => {
    for (const p of qs) fern.query('SELECT sum(amount) FROM orders WHERE person_id = ?', [p]);
  },
  () => {
    const st = lite.prepare('SELECT sum(amount) FROM orders WHERE person_id = ?');
    for (const p of qs) st.get(p);
  },
);

bench(
  'Join people ⋈ orders + group by city',
  1,
  () => fern.query('SELECT p.city, count(*), sum(o.amount) FROM orders o JOIN people p ON p.id = o.person_id GROUP BY p.city'),
  () => lite.prepare('SELECT p.city, count(*), sum(o.amount) FROM orders o JOIN people p ON p.id = o.person_id GROUP BY p.city').all(),
);

bench(
  'Top 10 by amount (top-N heap sort)',
  1,
  () => fern.query('SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 10'),
  () => lite.prepare('SELECT id, amount FROM orders ORDER BY amount DESC LIMIT 10').all(),
);

const integrity = fern.checkIntegrity();
fern.close();
lite.close();
rmSync(dir, { recursive: true, force: true });

const fmtMs = (ms: number) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(0));
const rate = (ops: number, ms: number) => (ops > 1 ? `${Math.round((ops / ms) * 1000).toLocaleString()}/s` : '');
console.log(`\n| Benchmark (N = ${N.toLocaleString()}) | FernDB | SQLite (C, via node:sqlite) |`);
console.log('|---|---:|---:|');
for (const r of results) {
  console.log(`| ${r.name} | ${fmtMs(r.fern)} ms ${rate(r.ops, r.fern) && `(${rate(r.ops, r.fern)})`} | ${fmtMs(r.lite)} ms ${rate(r.ops, r.lite) && `(${rate(r.ops, r.lite)})`} |`);
}
console.log(`\nIntegrity check after benchmark: ${integrity.length === 0 ? 'ok' : integrity.join('; ')}`);
console.log(`Node ${process.version}, ${process.platform} ${process.arch}`);
