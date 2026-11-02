/** Turns AST nodes back into SQL text, for EXPLAIN output and column names. */
import type { Expr, FromItem, SelectCore, SelectStmt } from './ast.ts';
import type { Value } from '../types.ts';

const PREC: Record<string, number> = {
  OR: 1, AND: 2, NOT: 3, '=': 4, '<>': 4, '<': 4, '<=': 4, '>': 4, '>=': 4, '||': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7,
};

export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function literalToSql(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function prec(e: Expr): number {
  switch (e.kind) {
    case 'binary': return PREC[e.op]!;
    case 'unary': return e.op === 'NOT' ? 3 : 8;
    case 'isNull': case 'between': case 'inList': case 'inSelect': case 'like': return 4;
    default: return 9;
  }
}

function wrap(e: Expr, min: number): string {
  const s = exprToSql(e);
  return prec(e) < min ? `(${s})` : s;
}

export function exprToSql(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      return literalToSql(e.value);
    case 'param':
      return '?';
    case 'column':
      return e.table ? `${quoteIdent(e.table)}.${quoteIdent(e.name)}` : quoteIdent(e.name);
    case 'unary':
      return e.op === 'NOT' ? `NOT ${wrap(e.expr, 3)}` : `-${wrap(e.expr, 8)}`;
    case 'binary': {
      const p = PREC[e.op]!;
      return `${wrap(e.left, p)} ${e.op} ${wrap(e.right, p + 1)}`;
    }
    case 'isNull':
      return `${wrap(e.expr, 5)} IS ${e.not ? 'NOT ' : ''}NULL`;
    case 'between':
      return `${wrap(e.expr, 5)} ${e.not ? 'NOT ' : ''}BETWEEN ${wrap(e.low, 5)} AND ${wrap(e.high, 5)}`;
    case 'inList':
      return `${wrap(e.expr, 5)} ${e.not ? 'NOT ' : ''}IN (${e.list.map(exprToSql).join(', ')})`;
    case 'inSelect':
      return `${wrap(e.expr, 5)} ${e.not ? 'NOT ' : ''}IN (${selectToSql(e.select)})`;
    case 'exists':
      return `${e.not ? 'NOT ' : ''}EXISTS (${selectToSql(e.select)})`;
    case 'subquery':
      return `(${selectToSql(e.select)})`;
    case 'like':
      return `${wrap(e.expr, 5)} ${e.not ? 'NOT ' : ''}${e.insensitive ? 'ILIKE' : 'LIKE'} ${wrap(e.pattern, 5)}`;
    case 'case': {
      const parts = ['CASE'];
      if (e.operand) parts.push(exprToSql(e.operand));
      for (const w of e.whens) parts.push(`WHEN ${exprToSql(w.when)} THEN ${exprToSql(w.then)}`);
      if (e.else) parts.push(`ELSE ${exprToSql(e.else)}`);
      parts.push('END');
      return parts.join(' ');
    }
    case 'call':
      if (e.star) return `${e.name.toLowerCase()}(*)`;
      return `${e.name.toLowerCase()}(${e.distinct ? 'DISTINCT ' : ''}${e.args.map(exprToSql).join(', ')})`;
    case 'cast':
      return `CAST(${exprToSql(e.expr)} AS ${e.type})`;
  }
}

function fromToSql(f: FromItem): string {
  switch (f.kind) {
    case 'table':
      return f.alias ? `${quoteIdent(f.name)} ${quoteIdent(f.alias)}` : quoteIdent(f.name);
    case 'subquery':
      return `(${selectToSql(f.select)}) ${quoteIdent(f.alias)}`;
    case 'join': {
      const kw = f.type === 'CROSS' ? 'CROSS JOIN' : f.type === 'LEFT' ? 'LEFT JOIN' : 'JOIN';
      const cond = f.on ? ` ON ${exprToSql(f.on)}` : f.using ? ` USING (${f.using.join(', ')})` : '';
      return `${fromToSql(f.left)} ${kw} ${fromToSql(f.right)}${cond}`;
    }
  }
}

function coreToSql(c: SelectCore): string {
  let s = `SELECT ${c.distinct ? 'DISTINCT ' : ''}${c.columns
    .map((col) =>
      col.kind === 'star' ? (col.table ? `${col.table}.*` : '*') : col.alias ? `${exprToSql(col.expr)} AS ${col.alias}` : exprToSql(col.expr),
    )
    .join(', ')}`;
  if (c.from) s += ` FROM ${fromToSql(c.from)}`;
  if (c.where) s += ` WHERE ${exprToSql(c.where)}`;
  if (c.groupBy.length) s += ` GROUP BY ${c.groupBy.map(exprToSql).join(', ')}`;
  if (c.having) s += ` HAVING ${exprToSql(c.having)}`;
  return s;
}

export function selectToSql(s: SelectStmt): string {
  let out = coreToSql(s.core);
  for (const c of s.compound) out += ` ${c.op} ${coreToSql(c.core)}`;
  if (s.orderBy.length) out += ` ORDER BY ${s.orderBy.map((o) => exprToSql(o.expr) + (o.desc ? ' DESC' : '')).join(', ')}`;
  if (s.limit) out += ` LIMIT ${exprToSql(s.limit)}`;
  if (s.offset) out += ` OFFSET ${exprToSql(s.offset)}`;
  return out;
}

/** Structural equality of expressions (case-insensitive for identifiers). */
export function exprEquals(a: Expr, b: Expr): boolean {
  return exprKey(a) === exprKey(b);
}

function exprKey(e: Expr): string {
  return JSON.stringify(e, (k, v) => ((k === 'name' || k === 'table' || k === 'alias') && typeof v === 'string' ? v.toLowerCase() : v));
}
