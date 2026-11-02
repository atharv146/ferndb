#!/usr/bin/env node
/**
 * Interactive shell.
 *
 *   ferndb                 in-memory database
 *   ferndb shop.fern       open or create a file
 *   ferndb shop.fern -c "SELECT ..."
 *   ferndb shop.fern < script.sql
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Database, formatValue, type QueryResult, type Value } from './index.ts';
import { openDatabase } from './node.ts';

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

export function renderTable(columns: string[], rows: Value[][]): string {
  const cells = rows.map((r) => r.map(formatValue));
  const widths = columns.map((c, i) => Math.max([...c].length, ...cells.map((r) => [...r[i]!].length)));
  const numeric = columns.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === 'number'));
  const line = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const fmt = (vals: string[]) =>
    '│' + vals.map((v, i) => ' ' + (numeric[i] ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)) + ' ').join('│') + '│';
  return [line('┌', '┬', '┐'), fmt(columns.map(bold)), line('├', '┼', '┤'), ...cells.map(fmt), line('└', '┴', '┘')].join('\n');
}

function printResult(r: QueryResult, timer: boolean): void {
  if (r.command === 'EXPLAIN') {
    console.log(r.rows.map((x) => x[0]).join('\n'));
  } else if (r.command === 'SELECT') {
    if (r.columns.length > 0) console.log(renderTable(r.columns, r.rows));
    console.log(dim(`(${r.rows.length} row${r.rows.length === 1 ? '' : 's'})`));
  } else {
    console.log(dim(r.changes > 0 || /INSERT|UPDATE|DELETE/.test(r.command) ? `${r.command} ${r.changes}` : r.command));
  }
  if (timer) console.log(dim(`Time: ${r.timeMs.toFixed(3)} ms`));
}

const HELP = `
  .tables              list tables with row counts
  .schema [TABLE]      show CREATE statements
  .tree NAME           draw the B+ tree of a table or index
  .stats               pager and buffer-pool statistics
  .integrity           verify every B+ tree and index
  .checkpoint          copy the WAL into the main file
  .timer on|off        show statement timings
  .read FILE           run a SQL script
  .quit                exit

  Statements end with ';'. EXPLAIN and EXPLAIN ANALYZE show query plans.`;

function drawTree(db: Database, name: string): void {
  const view = db.inspectTree(name);
  console.log(bold(`${view.kind} ${view.name}`) + dim(`  key: (${view.keyColumns.join(', ')})  page size ${view.pageSize}`));
  view.levels.forEach((level, depth) => {
    const kind = level[0]?.kind === 'leaf' ? 'leaves' : 'internal';
    const shown = level.slice(0, 6).map((n) => {
      const keys = n.keys.map((k) => k.map(formatValue).join(','));
      const summary = keys.length <= 4 ? keys.join(' | ') : `${keys.slice(0, 2).join(' | ')} … ${keys.at(-1)}`;
      const fill = Math.round((n.bytes / view.pageSize) * 100);
      return `[p${n.id} ${dim(`${fill}%`)} ${summary}]`;
    });
    const more = level.length > 6 ? dim(` … +${level.length - 6} more`) : '';
    console.log(`${dim(`L${depth} ${kind.padEnd(8)} (${level.length})`)} ${shown.join(' ')}${more}`);
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const ci = args.indexOf('-c');
  const command = ci >= 0 ? args[ci + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('-') && !(ci >= 0 && i === ci + 1));
  const db = file ? openDatabase(file) : Database.memory();
  let timer = false;

  const run = (sql: string) => {
    try {
      for (const r of db.exec(sql)) printResult(r, timer);
    } catch (e) {
      console.log(red(`Error: ${(e as Error).message}`));
      return false;
    }
    return true;
  };

  const dot = (line: string): boolean => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    try {
      switch (cmd) {
        case '.help': console.log(HELP); break;
        case '.quit': case '.exit': return false;
        case '.tables': {
          const ts = db.tables();
          if (ts.length === 0) console.log(dim('(no tables)'));
          else console.log(renderTable(['table', 'rows', 'indexes'], ts.map((t) => [t.name, t.rowCount, t.indexes.map((i) => i.name).join(', ')])));
          break;
        }
        case '.schema':
          for (const t of db.tables().filter((t) => !arg || t.name.toLowerCase() === arg.toLowerCase())) {
            console.log(t.sql + ';');
            for (const i of t.indexes.filter((i) => !i.auto)) console.log(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${i.name} ON ${t.name} (${i.columns.join(', ')});`);
          }
          break;
        case '.tree': drawTree(db, arg); break;
        case '.stats': console.log(db.stats()); break;
        case '.integrity': {
          const p = db.checkIntegrity();
          console.log(p.length === 0 ? 'ok' : red(p.join('\n')));
          break;
        }
        case '.checkpoint': db.checkpoint(); console.log('ok'); break;
        case '.timer': timer = arg === 'on'; break;
        case '.read': run(readFileSync(arg, 'utf8')); break;
        default: console.log(red(`unknown command ${cmd}; try .help`));
      }
    } catch (e) {
      console.log(red(`Error: ${(e as Error).message}`));
    }
    return true;
  };

  if (command !== undefined) {
    const ok = command.startsWith('.') ? dot(command) : run(command);
    db.close();
    process.exit(ok ? 0 : 1);
  }

  if (!process.stdin.isTTY) {
    const input = readFileSync(0, 'utf8');
    const ok = run(input);
    db.close();
    process.exit(ok ? 0 : 1);
  }

  console.log(`${bold('FernDB')} ${dim('— a relational database from scratch.')} ${file ? `Opened ${file}.` : 'In-memory database.'} ${dim('Type .help for help.')}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'ferndb> ' });
  let buffer = '';
  rl.prompt();
  rl.on('line', (line) => {
    if (buffer === '' && line.trim().startsWith('.')) {
      if (!dot(line)) {
        rl.close();
        return;
      }
    } else {
      buffer += (buffer ? '\n' : '') + line;
      if (buffer.trim().endsWith(';')) {
        run(buffer);
        buffer = '';
      }
    }
    rl.setPrompt(buffer ? '   ...> ' : 'ferndb> ');
    rl.prompt();
  });
  rl.on('close', () => {
    db.close();
    console.log();
  });
}

main();
