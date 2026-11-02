/** Long-running differential fuzzer: `npm run fuzz -- [scenarios] [startSeed]` */
import { runScenario } from '../tests/fuzz/differential.ts';

const count = Number(process.argv[2] ?? 2000);
const start = Number(process.argv[3] ?? Date.now() % 1_000_000);
const t0 = performance.now();
let statements = 0;
for (let seed = start; seed < start + count; seed++) {
  const m = runScenario(seed, 60, 20);
  statements += 80;
  if (m) {
    console.error(`\nMISMATCH (seed ${m.seed})\n${m.sql}\n--- ferndb ---\n${m.fern}\n--- sqlite ---\n${m.sqlite}`);
    process.exit(1);
  }
  if ((seed - start + 1) % 100 === 0) process.stdout.write(`\r${seed - start + 1}/${count} scenarios ok`);
}
console.log(`\n${count} scenarios (~${statements} statements) matched SQLite in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
