/**
 * Crash consistency. A workload of several transactions runs against files
 * that "lose power" after N writes (the last write may be torn in half).
 * After every possible N the database is reopened, which runs WAL recovery,
 * and must be structurally sound and equal to the state after some prefix
 * of the committed transactions: never a half-applied one.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/index.ts';
import { CrashingFile, MemoryFile } from '../src/storage/file.ts';

const OPTS = { pageSize: 512, checkpointFrames: 12 };

const SETUP = `
  CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);
  CREATE INDEX items_qty ON items (qty);
`;

const TXNS = [
  `BEGIN;
   INSERT INTO items (name, qty) SELECT 'item-' || x.n || y.n, x.n * y.n FROM
     (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6) x,
     (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8) y;
   COMMIT`,
  `UPDATE items SET qty = qty + 100, name = name || '-updated' WHERE id % 3 = 0`,
  `BEGIN;
   DELETE FROM items WHERE qty < 10;
   CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
   INSERT INTO notes (body) VALUES ('${'long text '.repeat(80)}'), ('short');
   COMMIT`,
  `DROP INDEX items_qty`,
];

function snapshot(db: Database): string {
  const tables = db.tables().map((t) => t.name);
  const out: Record<string, unknown> = { tables };
  for (const t of tables) out[t] = db.query(`SELECT * FROM ${t}`).rows;
  out.indexes = db.tables().flatMap((t) => t.indexes.map((i) => i.name));
  return JSON.stringify(out);
}

/** Runs the workload, returning how many transactions finished. */
function runWorkload(db: Database): number {
  let done = 0;
  for (const sql of TXNS) {
    db.exec(sql);
    done++;
  }
  db.close();
  return done;
}

describe('crash recovery', () => {
  // Reference states: after 0, 1, 2, ... committed transactions.
  const states: string[] = [];
  const baseDb = new MemoryFile();
  const baseWal = new MemoryFile();
  {
    const db = new Database(baseDb, baseWal, OPTS);
    db.exec(SETUP);
    db.checkpoint();
    states.push(snapshot(db));
    for (const sql of TXNS) {
      db.exec(sql);
      states.push(snapshot(db));
    }
  }
  const baseDbBytes = (() => {
    const f = new MemoryFile();
    const db = new Database(f, new MemoryFile(), OPTS);
    db.exec(SETUP);
    db.close();
    return f.snapshot();
  })();

  // Count the writes a clean run performs, so we can crash before each one.
  const counter = { remaining: Number.MAX_SAFE_INTEGER };
  {
    const d = MemoryFile.from(baseDbBytes);
    const w = new MemoryFile();
    runWorkload(new Database(new CrashingFile(d, counter), new CrashingFile(w, counter), OPTS));
  }
  const totalWrites = Number.MAX_SAFE_INTEGER - counter.remaining;

  it('has a meaningful number of crash points', () => {
    expect(totalWrites).toBeGreaterThan(50);
    expect(new Set(states).size).toBe(TXNS.length + 1);
  });

  it(`recovers to a committed state after a crash at each of the write boundaries`, () => {
    const seen = new Set<number>();
    for (let budget = 0; budget <= totalWrites; budget++) {
      const d = MemoryFile.from(baseDbBytes);
      const w = new MemoryFile();
      const c = { remaining: budget };
      let completed = 0;
      try {
        completed = runWorkload(new Database(new CrashingFile(d, c), new CrashingFile(w, c), OPTS));
      } catch (e) {
        expect((e as Error).message).toMatch(/simulated crash/);
      }

      // Power comes back: reopen the same bytes and let recovery run.
      const db = new Database(d, w, OPTS);
      expect(db.checkIntegrity(), `budget ${budget}`).toEqual([]);
      const state = states.indexOf(snapshot(db));
      expect(state, `budget ${budget}: state matches no committed prefix`).toBeGreaterThanOrEqual(0);
      // Anything reported as committed must have survived.
      expect(state, `budget ${budget}`).toBeGreaterThanOrEqual(completed);
      seen.add(state);

      // And the recovered database keeps working.
      db.exec('CREATE TABLE IF NOT EXISTS after_crash (x INTEGER)');
      db.exec('INSERT INTO after_crash VALUES (1)');
      expect(db.query('SELECT count(*) FROM after_crash').rows[0]![0]).toBeGreaterThanOrEqual(1);
    }
    // The sweep must actually land in every intermediate state.
    expect([...seen].sort()).toEqual(states.map((_, i) => i));
  });

  it('survives a second crash during recovery', () => {
    for (let budget = 5; budget <= totalWrites; budget += 7) {
      const d = MemoryFile.from(baseDbBytes);
      const w = new MemoryFile();
      try {
        runWorkload(new Database(new CrashingFile(d, { remaining: budget }), new CrashingFile(w, { remaining: budget }), OPTS));
      } catch {}
      for (let second = 0; second < 6; second++) {
        try {
          new Database(new CrashingFile(d, { remaining: second }), new CrashingFile(w, { remaining: second }), OPTS);
        } catch {}
      }
      const db = new Database(d, w, OPTS);
      expect(db.checkIntegrity()).toEqual([]);
      expect(states).toContain(snapshot(db));
    }
  });

  it('ignores a WAL with a corrupted frame and everything after it', () => {
    const d = MemoryFile.from(baseDbBytes);
    const w = new MemoryFile();
    const db = new Database(d, w, { ...OPTS, checkpointFrames: 1_000_000 });
    db.exec(TXNS[0]!);
    const walAfterFirst = w.size();
    db.exec(TXNS[1]!);
    // Flip one byte inside the second transaction's frames, then "crash".
    const bytes = w.snapshot();
    bytes[walAfterFirst + 100] ^= 0xff;
    const recovered = new Database(MemoryFile.from(d.snapshot()), MemoryFile.from(bytes), OPTS);
    expect(recovered.checkIntegrity()).toEqual([]);
    expect(snapshot(recovered)).toBe(states[1]);
  });
});
