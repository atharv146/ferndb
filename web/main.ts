import { basicSetup, EditorView } from 'codemirror';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { sql, StandardSQL } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { Database, formatValue, MemoryFile, type PlanJson, type QueryResult, type TreeView, type Value } from '../src/index.ts';
import { EXAMPLES, loadSample } from './sample.ts';
import { renderTree } from './tree.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | undefined)[]) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
};

// ------------------------------------------------------------- database

const STORE_KEY = 'ferndb-playground-v1';
let dbFile = new MemoryFile();
let walFile = new MemoryFile();
let db: Database;
let persisted = false;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function freshDatabase(): void {
  dbFile = new MemoryFile();
  walFile = new MemoryFile();
  db = new Database(dbFile, walFile);
  loadSample(db);
  save();
}

function openDatabase(): void {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) {
      dbFile = MemoryFile.from(fromBase64(saved));
      walFile = new MemoryFile();
      db = new Database(dbFile, walFile);
      if (db.checkIntegrity().length === 0) {
        persisted = true;
        return;
      }
    }
  } catch {
    // Fall through to a fresh copy of the sample data.
  }
  freshDatabase();
}

/** Saves the database file itself (after a checkpoint) to localStorage. */
function save(): void {
  if (db.inTransaction) return;
  try {
    db.checkpoint();
    localStorage.setItem(STORE_KEY, toBase64(dbFile.snapshot()));
    persisted = true;
  } catch {
    persisted = false;
  }
  $('persist-note').textContent = persisted
    ? 'Your changes are saved in this browser. The saved copy is the real database file, page for page.'
    : 'Changes last until you close this tab.';
}

openDatabase();

// ---------------------------------------------------------------- editor

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$('run-kbd').textContent = isMac ? '⌘ Enter' : 'Ctrl Enter';

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--fern-strong)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--pollen)' },
  { tag: tags.number, color: 'var(--fern)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--ink-soft)', fontStyle: 'italic' },
  { tag: tags.operator, color: 'var(--ink-soft)' },
  { tag: tags.typeName, color: 'var(--fern)' },
]);

const editorTheme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--fern)', padding: '10px 0' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--ink-soft)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--frond) 35%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--frond-deep) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--fern)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--rule)', color: 'var(--ink)' },
});

function schemaForEditor(): Record<string, string[]> {
  return Object.fromEntries(db.tables().map((t) => [t.name, t.columns.map((c) => c.name)]));
}

const editor = new EditorView({
  parent: $('editor'),
  doc: EXAMPLES[0]!.sql,
  extensions: [
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (run(), true) }])),
    basicSetup,
    sql({ dialect: StandardSQL, schema: schemaForEditor(), upperCaseKeywords: true }),
    syntaxHighlighting(highlight),
    editorTheme,
    EditorView.lineWrapping,
  ],
});

// ------------------------------------------------------------------ tabs

type Tab = 'results' | 'plan' | 'tree' | 'storage';
function showTab(tab: Tab): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const p of document.querySelectorAll<HTMLElement>('.pane')) p.hidden = p.dataset.pane !== tab;
  if (tab === 'tree') drawTree();
  if (tab === 'storage') drawStorage();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab as Tab));

// -------------------------------------------------------------- examples

function renderExamples(): void {
  const box = $('examples');
  box.replaceChildren(
    ...EXAMPLES.map((ex, i) =>
      h('button', {
        type: 'button',
        class: 'example',
        role: 'listitem',
        'aria-current': i === 0 ? 'true' : 'false',
        onclick: (e: Event) => {
          for (const b of box.querySelectorAll('.example')) b.setAttribute('aria-current', 'false');
          (e.currentTarget as HTMLElement).setAttribute('aria-current', 'true');
          editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: ex.sql } });
          run();
        },
      }, ex.label),
    ),
  );
}

// ------------------------------------------------------------------- run

let lastPlans: { sql: string; plan: PlanJson; ms: number }[] = [];

function setStatus(text: string, error = false): void {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('error', error);
}

function run(): void {
  const text = editor.state.doc.toString();
  const t0 = performance.now();
  let results: QueryResult[] = [];
  let error: string | null = null;
  try {
    results = db.exec(text, [], { plans: true });
  } catch (e) {
    error = (e as Error).message;
    // Statements before the failing one already ran; show what we can.
  }
  const ms = performance.now() - t0;
  const changed = results.some((r) => r.command !== 'SELECT' && r.command !== 'EXPLAIN');

  lastPlans = results.filter((r) => r.plan).map((r) => ({ sql: r.command, plan: r.plan!, ms: r.timeMs }));
  renderResults(results, error);
  renderPlans();

  if (error) setStatus(`Error after ${ms.toFixed(1)} ms`, true);
  else {
    const last = results.at(-1);
    const rows = last && (last.command === 'SELECT') ? `${last.rows.length.toLocaleString()} row${last.rows.length === 1 ? '' : 's'}` : `${results.length} statement${results.length === 1 ? '' : 's'}`;
    setStatus(`${rows} in ${ms.toFixed(1)} ms`);
  }

  if (changed || error) {
    renderSchema();
    save();
  }
  const allExplain = results.length > 0 && results.every((r) => r.command === 'EXPLAIN');
  if (allExplain && !error) showTab('plan');
  else if (!document.querySelector<HTMLElement>('[data-pane="results"]')!.hidden || error) showTab('results');
  else if (!document.querySelector<HTMLElement>('[data-pane="tree"]')!.hidden) drawTree();
  else if (!document.querySelector<HTMLElement>('[data-pane="storage"]')!.hidden) drawStorage();
}

function cell(v: Value): HTMLTableCellElement {
  if (v === null) return h('td', { class: 'null' }, 'NULL');
  return h('td', { class: typeof v === 'number' ? 'num' : '' }, formatValue(v));
}

const MAX_ROWS = 1000;

function resultTable(r: QueryResult): HTMLElement {
  const numeric = r.columns.map((_, i) => r.rows.length > 0 && r.rows.every((row) => row[i] === null || typeof row[i] === 'number'));
  const head = h('tr', {}, ...r.columns.map((c, i) => h('th', { class: numeric[i] ? 'num' : '', scope: 'col' }, c)));
  const body = r.rows.slice(0, MAX_ROWS).map((row) => h('tr', {}, ...row.map(cell)));
  const wrap = h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' }, h('thead', {}, head), h('tbody', {}, ...body)));
  return wrap;
}

function describe(r: QueryResult): string {
  if (r.command === 'SELECT') return `${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? '' : 's'} (${r.timeMs.toFixed(2)} ms)`;
  if (r.command === 'EXPLAIN') return `plan (${r.timeMs.toFixed(2)} ms)`;
  if (/INSERT|UPDATE|DELETE/.test(r.command)) return `${r.command} ${r.changes} row${r.changes === 1 ? '' : 's'} (${r.timeMs.toFixed(2)} ms)`;
  return `${r.command} (${r.timeMs.toFixed(2)} ms)`;
}

function renderResults(results: QueryResult[], error: string | null): void {
  const pane = $('results');
  const parts: Node[] = [];
  const shown = [...results].reverse().find((r) => r.columns.length > 0);
  if (shown) {
    parts.push(resultTable(shown));
    if (shown.rows.length > MAX_ROWS) parts.push(h('p', { class: 'message' }, `Showing the first ${MAX_ROWS.toLocaleString()} rows. Add a LIMIT or a WHERE clause to narrow it down.`));
  }
  if (results.length > 1 || (results.length === 1 && !shown)) {
    parts.push(h('ul', { class: 'log' }, ...results.map((r) => h('li', {}, describe(r)))));
  }
  if (error) parts.push(h('p', { class: 'message error' }, error));
  if (parts.length === 0) parts.push(h('p', { class: 'message' }, 'The statement ran and returned no rows.'));
  pane.replaceChildren(...parts);
}

// ------------------------------------------------------------------ plans

function planNode(n: PlanJson, rootMs: number): HTMLElement {
  const children = n.children.length ? h('ul', {}, ...n.children.map((c) => h('li', {}, planNode(c, rootMs)))) : null;
  const actual = n.actual
    ? h(
        'div',
        { class: 'plan-actual' },
        h('span', {}, `${n.actual.rows.toLocaleString()} row${n.actual.rows === 1 ? '' : 's'}`),
        n.actual.loops > 1 ? h('span', {}, `${n.actual.loops.toLocaleString()} loops`) : null,
        h('span', {}, `${n.actual.ms.toFixed(3)} ms`),
        h('span', { class: 'bar', style: `width:${Math.max(2, Math.round((n.actual.ms / Math.max(rootMs, 0.001)) * 160))}px`, 'aria-hidden': 'true' }),
      )
    : null;
  return h(
    'div',
    {},
    h('div', { class: 'plan-node' }, h('div', { class: 'plan-title' }, n.title), ...n.details.map((d) => h('div', { class: 'plan-detail' }, d)), actual),
    children,
  );
}

function renderPlans(): void {
  const pane = $('plan');
  if (lastPlans.length === 0) {
    pane.replaceChildren(h('p', { class: 'message' }, 'Run a SELECT or an EXPLAIN to see how the planner executes it: which index it picks, which join algorithm, and how many rows flow through each step.'));
    return;
  }
  // One scale for all statements, so plans can be compared side by side.
  const rootMs = Math.max(...lastPlans.map(({ plan }) => plan.actual?.ms ?? 0));
  const blocks = lastPlans.map(({ plan }, i) => {
    return h(
      'section',
      {},
      lastPlans.length > 1 ? h('h3', { class: 'plan-summary' }, `Statement ${i + 1}`) : null,
      h('ul', { class: 'plan-tree' }, h('li', {}, planNode(plan, rootMs))),
    );
  });
  pane.replaceChildren(
    ...blocks,
    h('p', { class: 'plan-summary' }, 'Times are inclusive: each step counts the time spent in the steps beneath it. Bars share one scale across all statements.'),
  );
}

// ----------------------------------------------------------------- schema

let treeTarget = 'enrollments';

function renderSchema(): void {
  const box = $('schema');
  const tables = db.tables();
  box.replaceChildren(
    ...tables.map((t, i) =>
      h(
        'details',
        { class: 'table-entry', open: i < 2 ? true : undefined },
        h('summary', {}, h('span', {}, t.name), h('span', { class: 'count' }, t.rowCount.toLocaleString())),
        h('ul', { class: 'cols' }, ...t.columns.map((c) => h('li', {}, h('span', {}, c.name, c.primaryKey ? h('span', { class: 'key' }, ' key') : null), h('span', { class: 'type' }, c.type.toLowerCase())))),
        t.indexes.length ? h('div', { class: 'idx' }, ...t.indexes.map((x) => h('div', {}, `${x.unique ? 'unique ' : ''}index on ${x.columns.join(', ')}`))) : null,
        h(
          'div',
          { class: 'entry-actions' },
          h('button', { type: 'button', class: 'quiet', onclick: () => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: `SELECT * FROM ${t.name} LIMIT 100;` } }); run(); } }, 'Query'),
          h('button', { type: 'button', class: 'quiet', onclick: () => { treeTarget = t.name; treeMode = 'data'; showTab('tree'); } }, 'Show B+ tree'),
        ),
      ),
    ),
  );
  editor.dispatch({}); // keep autocomplete schema roughly current on next reload
}

// ------------------------------------------------------------------- tree

let treeMode: 'data' | 'lab' = 'data';
const tooltip = $('tooltip');

function hover(text: string | null, ev?: MouseEvent): void {
  if (!text) {
    tooltip.hidden = true;
    return;
  }
  tooltip.textContent = text;
  tooltip.hidden = false;
  if (ev) {
    const x = Math.min(ev.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }
}

// The tree lab: a separate tiny database with 256-byte pages so splits happen after a handful of keys.
let lab = Database.memory({ pageSize: 256 });
lab.exec('CREATE TABLE lab (k INTEGER PRIMARY KEY, label TEXT)');
let labNext = 1;
let labChanged = new Set<number>();
let labLog = 'Insert some keys to grow the tree.';

function pageSignature(view: TreeView): Map<number, string> {
  const m = new Map<number, string>();
  for (const level of view.levels) for (const n of level) m.set(n.id, JSON.stringify([n.keys, n.children]));
  return m;
}

function labDo(action: () => string): void {
  const before = pageSignature(lab.inspectTree('lab'));
  labLog = action();
  const after = pageSignature(lab.inspectTree('lab'));
  labChanged = new Set([...after].filter(([id, sig]) => before.get(id) !== sig).map(([id]) => id));
  drawTree();
}

function labInsert(keys: number[]): string {
  let added = 0;
  lab.transaction(() => {
    for (const k of keys) {
      if (lab.query('SELECT 1 FROM lab WHERE k = ?', [k]).rows.length) continue;
      lab.query('INSERT INTO lab VALUES (?, ?)', [k, `item ${k}`]);
      added++;
    }
  });
  return added === 1 ? `Inserted key ${keys[0]}.` : `Inserted ${added} keys.`;
}

function drawTree(): void {
  const pane = $('tree');
  const names = db.tables().flatMap((t) => [t.name, ...t.indexes.map((i) => i.name)]);
  if (!names.includes(treeTarget)) treeTarget = names[0] ?? '';

  const modeSelect = h(
    'select',
    { 'aria-label': 'Tree to show', onchange: (e: Event) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === '__lab') treeMode = 'lab';
      else {
        treeMode = 'data';
        treeTarget = v;
      }
      drawTree();
    } },
    h('optgroup', { label: 'Tables and indexes' }, ...names.map((n) => h('option', { value: n, selected: treeMode === 'data' && n === treeTarget ? true : undefined }, n))),
    h('optgroup', { label: 'Experiment' }, h('option', { value: '__lab', selected: treeMode === 'lab' ? true : undefined }, 'Tree lab (256-byte pages)')),
  );

  const controls = h('div', { class: 'tree-controls' }, modeSelect);
  let caption: HTMLElement;
  let view: TreeView;
  let changed: Set<number> | undefined;

  if (treeMode === 'lab') {
    controls.append(
      h(
        'div',
        { class: 'lab-controls' },
        h('button', { type: 'button', onclick: () => labDo(() => labInsert([1 + Math.floor(Math.random() * 999)])) }, 'Insert a random key'),
        h('button', { type: 'button', onclick: () => labDo(() => labInsert(Array.from({ length: 10 }, () => labNext++ * 3))) }, 'Insert 10 in order'),
        h('button', { type: 'button', onclick: () => labDo(() => {
          const keys = lab.query('SELECT k FROM lab').rows.map((r) => r[0] as number);
          const victims = keys.sort(() => Math.random() - 0.5).slice(0, 5);
          for (const k of victims) lab.query('DELETE FROM lab WHERE k = ?', [k]);
          return victims.length ? `Deleted ${victims.join(', ')}.` : 'Nothing to delete.';
        }) }, 'Delete 5 random'),
        h('button', { type: 'button', onclick: () => {
          lab = Database.memory({ pageSize: 256 });
          lab.exec('CREATE TABLE lab (k INTEGER PRIMARY KEY, label TEXT)');
          labNext = 1;
          labChanged = new Set();
          labLog = 'Insert some keys to grow the tree.';
          drawTree();
        } }, 'Start over'),
      ),
    );
    view = lab.inspectTree('lab');
    changed = labChanged;
    caption = h('p', { class: 'tree-caption' }, `${labLog} Each page holds at most 256 bytes, so a leaf fits only a few rows. When one overflows it splits, and the separator key moves up into the parent. Highlighted pages changed in the last step.`);
  } else {
    view = db.inspectTree(treeTarget);
    const leaves = view.levels.at(-1) ?? [];
    const avgFill = leaves.length ? leaves.reduce((a, n) => a + n.bytes, 0) / leaves.length / view.pageSize : 0;
    const rows = leaves.reduce((a, n) => a + n.keys.length, 0);
    caption = h(
      'p',
      { class: 'tree-caption' },
      `${view.kind === 'table' ? 'Table' : 'Index'} ${view.name}, keyed by (${view.keyColumns.join(', ')}): ${rows.toLocaleString()} entries in ${leaves.length.toLocaleString()} leaf pages, ${view.levels.length} levels deep, leaves ${Math.round(avgFill * 100)}% full on average. Any row is at most ${view.levels.length} page reads away. Hover a page to see its key range.`,
    );
  }

  const canvas = h('div', { class: 'tree-canvas' });
  pane.replaceChildren(controls, caption, canvas);
  canvas.append(renderTree(view, { showKeys: treeMode === 'lab', changed, onHover: hover, fitWidth: canvas.clientWidth - 2 }));
  // Bring what just changed (or else the root) into view.
  const focus = canvas.querySelector<SVGRectElement>('.page.changed') ?? canvas.querySelector<SVGRectElement>('.page.internal');
  if (focus) canvas.scrollLeft = Math.max(0, Number(focus.getAttribute('x')) - canvas.clientWidth / 2);
  const legend = h(
    'div',
    { class: 'tree-legend' },
    h('span', {}, h('span', { class: 'swatch' }), treeMode === 'lab' ? 'page' : 'leaf page, shaded by how full it is'),
    treeMode === 'lab' ? h('span', {}, h('span', { class: 'swatch changed' }), 'changed by the last step') : null,
  );
  pane.append(legend);
}

// ---------------------------------------------------------------- storage

function drawStorage(message?: string): void {
  const s = db.stats();
  const hitRate = s.cacheHits + s.cacheMisses > 0 ? (100 * s.cacheHits) / (s.cacheHits + s.cacheMisses) : 0;
  const stat = (label: string, value: string) => h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, value));
  $('storage').replaceChildren(
    h(
      'dl',
      { class: 'stats' },
      stat('Database size', `${((s.pageCount * s.pageSize) / 1024).toFixed(0)} KB`),
      stat('Pages', s.pageCount.toLocaleString()),
      stat('Page size', `${s.pageSize} bytes`),
      stat('Free pages', s.freePages.toLocaleString()),
      stat('Buffer pool hit rate', `${hitRate.toFixed(1)}%`),
      stat('Commits this session', s.commits.toLocaleString()),
      stat('Log frames written', s.framesWritten.toLocaleString()),
      stat('Checkpoints', s.checkpoints.toLocaleString()),
    ),
    h(
      'div',
      { class: 'storage-notes' },
      h('p', {}, 'Every change is first appended to the write-ahead log as full page images with a CRC-32 checksum, ending in a commit marker. Only after the log is flushed does the commit count. A checkpoint later copies those pages into the main file.'),
      h('p', {}, 'If the process dies halfway through, recovery replays the log up to the last intact commit marker and ignores the rest, so a transaction is either fully there or not there at all. The test suite proves this by simulating a power cut at every single write.'),
      h(
        'div',
        { class: 'storage-actions' },
        h('button', { type: 'button', onclick: () => { save(); drawStorage('Checkpoint complete.'); } }, 'Run a checkpoint'),
        h('button', { type: 'button', onclick: () => { const p = db.checkIntegrity(); drawStorage(p.length ? p.join('\n') : 'Every B+ tree and index checked out.'); } }, 'Check integrity'),
      ),
      message ? h('p', { class: 'message' }, message) : null,
    ),
  );
}

// ------------------------------------------------------------------ setup

$('run').addEventListener('click', run);
$('reset').addEventListener('click', () => {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {}
  freshDatabase();
  renderSchema();
  run();
});

renderExamples();
renderSchema();
save();

// Deep links: #example=2&tab=plan&tree=students
window.addEventListener('hashchange', () => location.reload());
const params = new URLSearchParams(location.hash.slice(1));
const exampleIndex = Number(params.get('example'));
if (Number.isInteger(exampleIndex) && exampleIndex >= 1 && exampleIndex <= EXAMPLES.length) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: EXAMPLES[exampleIndex - 1]!.sql } });
  $('examples').querySelectorAll('.example').forEach((b, i) => b.setAttribute('aria-current', String(i === exampleIndex - 1)));
}
if (params.get('tree')) treeTarget = params.get('tree')!;
if (params.get('lab') !== null) treeMode = 'lab';
run();
const startTab = params.get('tab');
if (startTab === 'results' || startTab === 'plan' || startTab === 'tree' || startTab === 'storage') showTab(startTab);
if (treeMode === 'lab') {
  labDo(() => labInsert(Array.from({ length: 40 }, (_, i) => (i * 37) % 200)));
  labDo(() => labInsert([101]));
}
