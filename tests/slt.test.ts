/**
 * Runs the SQL logic tests in tests/sql/*.slt, a small dialect inspired by
 * SQLite's sqllogictest:
 *
 *   statement ok                 the SQL below must succeed
 *   statement error <text>       it must fail with a message containing <text>
 *   query [rowsort]              run it and compare rows with the lines after ----
 *   plan <text>                  EXPLAIN of the SQL must contain <text>
 *
 * Records are separated by blank lines. Result rows are printed with values
 * joined by " | " and NULL spelled out.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/index.ts';
import type { Value } from '../src/types.ts';

const dir = join(import.meta.dirname, 'sql');

function fmt(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

interface Record {
  line: number;
  kind: string;
  arg: string;
  sql: string;
  expected: string[];
}

function parseFile(text: string): Record[] {
  const lines = text.split('\n');
  const records: Record[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) {
      i++;
      continue;
    }
    const [kind, ...rest] = line.split(/\s+/);
    const start = i + 1;
    i++;
    const sql: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.trim() !== '----') sql.push(lines[i++]!);
    const expected: string[] = [];
    if (lines[i]?.trim() === '----') {
      i++;
      while (i < lines.length && lines[i]!.trim() !== '') expected.push(lines[i++]!.trim());
    }
    if (kind === 'statement' && rest[0] === 'ok') records.push({ line: start, kind: 'ok', arg: '', sql: sql.join('\n'), expected });
    else if (kind === 'statement' && rest[0] === 'error') records.push({ line: start, kind: 'error', arg: rest.slice(1).join(' '), sql: sql.join('\n'), expected });
    else if (kind === 'query') records.push({ line: start, kind: 'query', arg: rest.join(' '), sql: sql.join('\n'), expected });
    else if (kind === 'plan') records.push({ line: start, kind: 'plan', arg: rest.join(' '), sql: sql.join('\n'), expected });
    else throw new Error(`line ${start}: unknown record type "${line}"`);
  }
  return records;
}

describe('SQL logic tests', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.slt')).sort()) {
    it(file, () => {
      const db = Database.memory({ pageSize: 512 });
      for (const r of parseFile(readFileSync(join(dir, file), 'utf8'))) {
        const where = `${file}:${r.line}\n${r.sql}`;
        switch (r.kind) {
          case 'ok':
            try {
              db.exec(r.sql);
            } catch (e) {
              throw new Error(`${where}\nexpected success, got: ${(e as Error).message}`);
            }
            break;
          case 'error': {
            let msg: string | null = null;
            try {
              db.exec(r.sql);
            } catch (e) {
              msg = (e as Error).message;
            }
            if (msg === null) throw new Error(`${where}\nexpected an error containing "${r.arg}", but it succeeded`);
            expect(msg, where).toContain(r.arg);
            break;
          }
          case 'query': {
            let rows: string[];
            try {
              const res = db.query(r.sql);
              rows = res.rows.map((row) => row.map(fmt).join(' | '));
            } catch (e) {
              throw new Error(`${where}\nquery failed: ${(e as Error).message}`);
            }
            const expected = r.expected.slice();
            if (r.arg.includes('rowsort')) {
              rows.sort();
              expected.sort();
            }
            expect(rows, where).toEqual(expected);
            break;
          }
          case 'plan': {
            const plan = db.query(`EXPLAIN ${r.sql}`).rows.map((x) => x[0]).join('\n');
            expect(plan, `${where}\n${plan}`).toContain(r.arg);
            break;
          }
        }
      }
    });
  }
});
