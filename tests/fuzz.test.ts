import { describe, expect, it } from 'vitest';
import { runScenario } from './fuzz/differential.ts';

describe('differential fuzzing against SQLite', () => {
  it('agrees with SQLite on 150 random scenarios', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const m = runScenario(seed);
      if (m) expect.fail(`seed ${m.seed}\n${m.sql}\n--- ferndb ---\n${m.fern}\n--- sqlite ---\n${m.sqlite}`);
    }
  });
});
