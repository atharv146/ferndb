# Contributing to FernDB

FernDB is a teaching-sized database: every layer, from the SQL parser to the write-ahead log, is meant to be readable in an afternoon. Contributions that keep it that way are very welcome.

## Setting up

```bash
git clone https://github.com/atharv146/ferndb
cd ferndb
npm install
npm test          # unit, SQL logic, crash-recovery and fuzz tests
npm run dev       # the browser playground
npm run bench     # benchmarks
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walks through each layer and lists the known limitations.

## Good first contributions

- **Missing SQL.** `ALTER TABLE`, views and window functions aren't supported. Each one touches the parser, the planner and the executor, which makes it a good tour of the codebase.
- **Join ordering.** Joins currently run in `FROM` order. A small cost-based reordering for three or four tables would make a real difference in the plan view.
- **Tests.** The SQL logic tests in `tests/sql/*.slt` are plain text files of statements and expected results; adding cases for edge cases you find (NULL handling, collation, overflow) is always useful.

## Ground rules

- No runtime dependencies.
- Every change to storage or recovery needs a test that crashes mid-write and checks nothing was lost.
- Explain the why in comments where the code is subtle; the codebase is meant to be learned from.
