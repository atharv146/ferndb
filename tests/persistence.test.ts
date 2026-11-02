import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/node.ts';

const dir = mkdtempSync(join(tmpdir(), 'ferndb-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('on-disk persistence', () => {
  it('reopens a closed database with all its data and schema', () => {
    const path = join(dir, 'a.fern');
    const db = openDatabase(path);
    db.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER); CREATE INDEX kv_v ON kv (v);`);
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) db.query('INSERT INTO kv VALUES (?, ?)', [`key-${i}`, i % 97]);
    });
    db.close();
    expect(statSync(`${path}-wal`).size).toBe(0); // close checkpoints

    const again = openDatabase(path);
    expect(again.query('SELECT count(*), sum(v) FROM kv').rows[0]).toEqual([2000, [...Array(2000).keys()].reduce((a, i) => a + (i % 97), 0)]);
    expect(again.query("SELECT v FROM kv WHERE k = 'key-1234'").rows).toEqual([[1234 % 97]]);
    expect(again.query('EXPLAIN SELECT k FROM kv WHERE v = 5').rows.flat().join('\n')).toContain('kv_v');
    expect(again.checkIntegrity()).toEqual([]);
    again.close();
  });

  it('recovers committed transactions from the WAL when the process dies without closing', () => {
    const path = join(dir, 'b.fern');
    const db = openDatabase(path, { checkpointFrames: 1_000_000 });
    db.exec('CREATE TABLE t (x INTEGER)');
    db.exec('INSERT INTO t VALUES (1), (2), (3)');
    db.exec('BEGIN; INSERT INTO t VALUES (4);'); // never committed
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    // No close(): simulate the process being killed.

    const again = openDatabase(path);
    expect(again.query('SELECT x FROM t').rows).toEqual([[1], [2], [3]]);
    again.close();
  });

  it('reuses freed pages instead of growing the file', () => {
    const path = join(dir, 'c.fern');
    const db = openDatabase(path);
    db.exec('CREATE TABLE blob (id INTEGER PRIMARY KEY, body TEXT)');
    const body = 'x'.repeat(3000);
    for (let round = 0; round < 3; round++) {
      db.transaction(() => {
        for (let i = 0; i < 200; i++) db.query('INSERT INTO blob (body) VALUES (?)', [body]);
      });
      db.exec('DELETE FROM blob');
    }
    const pagesAfter3 = db.stats().pageCount;
    db.transaction(() => {
      for (let i = 0; i < 200; i++) db.query('INSERT INTO blob (body) VALUES (?)', [body]);
    });
    expect(db.stats().pageCount).toBe(pagesAfter3);
    db.close();
  });
});
