/**
 * Expression compilation. Each AST expression is turned into a closure
 * `(row, env) => Value` once, with column references already resolved to
 * array positions, so evaluation never looks up names at run time.
 *
 * NULL handling follows SQL three-valued logic: comparisons with NULL yield
 * NULL, `NULL AND false` is false, `NULL OR true` is true, and WHERE keeps a
 * row only when its predicate is exactly true.
 */
import type { Expr, SelectStmt } from '../sql/ast.ts';
import { exprToSql } from '../sql/printer.ts';
import {
  compareStrings,
  semanticError,
  typeError,
  typeOfValue,
  DbError,
  type ColumnType,
  type Value,
} from '../types.ts';

export type Row = Value[];

export interface Env {
  params: readonly Value[];
  /** Rows of enclosing queries, innermost last (for correlated subqueries). */
  outers: Row[];
  /** Incremented per statement; used to cache uncorrelated subquery results. */
  execId: number;
  analyze: boolean;
}

export type Compiled = (row: Row, env: Env) => Value;

export interface ScopeCol {
  /** Table alias (lower case) or null for computed columns. */
  table: string | null;
  name: string;
  type: ColumnType | null;
  hidden?: boolean;
}

export class Scope {
  readonly cols: ScopeCol[];
  readonly outer: Scope | null;
  /** Set when an expression in this scope refers to a column of an enclosing query. */
  correlated = false;

  constructor(cols: ScopeCol[], outer: Scope | null) {
    this.cols = cols;
    this.outer = outer;
  }

  /** Finds a column in this scope only. Returns -1 if absent; throws if ambiguous. */
  find(table: string | null, name: string): number {
    const t = table?.toLowerCase() ?? null;
    const n = name.toLowerCase();
    let found = -1;
    for (let i = 0; i < this.cols.length; i++) {
      const c = this.cols[i]!;
      if (c.name.toLowerCase() !== n) continue;
      if (t !== null && c.table !== t) continue;
      if (found !== -1) throw semanticError(`column reference "${name}" is ambiguous`);
      found = i;
    }
    return found;
  }

  resolve(table: string | null, name: string): { depth: number; index: number } {
    let scope: Scope | null = this;
    let depth = 0;
    while (scope) {
      const index = scope.find(table, name);
      if (index !== -1) {
        // Everything between here and the owning scope is now correlated.
        let s: Scope | null = this;
        for (let d = 0; d < depth && s; d++, s = s.outer) s.correlated = true;
        return { depth, index };
      }
      scope = scope.outer;
      depth++;
    }
    throw semanticError(`no such column: ${table ? `${table}.` : ''}${name}`);
  }
}

/** Anything that produces rows; plan nodes implement this. */
export interface RowSource {
  rows(env: Env): Iterable<Row>;
  readonly schema: ScopeCol[];
}

export interface CompileContext {
  /** Plans a subquery whose outer scope is `scope`. */
  planSubquery(select: SelectStmt, scope: Scope): { plan: RowSource; correlated: boolean };
  /** Lets the aggregation planner substitute precomputed values for sub-expressions. */
  substitute?: (e: Expr) => Compiled | null;
  /** Where this expression appears, for error messages ("WHERE", "ON", ...). */
  clause: string;
}

export const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG']);

export function isAggregateCall(e: Expr): boolean {
  return e.kind === 'call' && AGGREGATES.has(e.name);
}

/** Visits every expression node, not descending into subqueries. */
export function walkExpr(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  switch (e.kind) {
    case 'unary': case 'isNull': case 'cast': walkExpr(e.expr, fn); break;
    case 'binary': walkExpr(e.left, fn); walkExpr(e.right, fn); break;
    case 'between': walkExpr(e.expr, fn); walkExpr(e.low, fn); walkExpr(e.high, fn); break;
    case 'inList': walkExpr(e.expr, fn); e.list.forEach((x) => walkExpr(x, fn)); break;
    case 'inSelect': walkExpr(e.expr, fn); break;
    case 'like': walkExpr(e.expr, fn); walkExpr(e.pattern, fn); break;
    case 'case':
      if (e.operand) walkExpr(e.operand, fn);
      for (const w of e.whens) { walkExpr(w.when, fn); walkExpr(w.then, fn); }
      if (e.else) walkExpr(e.else, fn);
      break;
    case 'call': e.args.forEach((x) => walkExpr(x, fn)); break;
    default: break;
  }
}

export function containsAggregate(e: Expr): boolean {
  let found = false;
  walkExpr(e, (x) => { if (isAggregateCall(x)) found = true; });
  return found;
}

export function containsSubquery(e: Expr): boolean {
  let found = false;
  walkExpr(e, (x) => { if (x.kind === 'subquery' || x.kind === 'exists' || x.kind === 'inSelect') found = true; });
  return found;
}

// ------------------------------------------------------------- value helpers

/** SQL comparison of two non-null values. Mixing incomparable types is an error. */
export function sqlCompare(a: Value, b: Value): number {
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) throw typeError(`cannot compare ${typeOfValue(a)} with ${typeOfValue(b)}`);
  if (ta === 'number') return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ta === 'string') return compareStrings(a as string, b as string);
  return (a ? 1 : 0) - (b ? 1 : 0);
}

export function truthy(v: Value): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  throw typeError(`expected a boolean condition but got TEXT '${v}'`);
}

function num(v: Value, op: string): number {
  if (typeof v !== 'number') throw typeError(`operator ${op} expects numbers, got ${typeOfValue(v)}`);
  return v;
}

function toText(v: Value): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function castValue(v: Value, type: ColumnType): Value {
  if (v === null) return null;
  switch (type) {
    case 'INTEGER':
      if (typeof v === 'number') return Math.trunc(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (/^\s*[-+]?\d+(\.\d*)?\s*$/.test(v)) return Math.trunc(Number(v));
      throw typeError(`cannot cast '${v}' to INTEGER`);
    case 'REAL':
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      throw typeError(`cannot cast '${v}' to REAL`);
    case 'TEXT':
      return toText(v);
    case 'BOOLEAN':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (/^(true|t|yes|1)$/i.test(v.trim())) return true;
      if (/^(false|f|no|0)$/i.test(v.trim())) return false;
      throw typeError(`cannot cast '${v}' to BOOLEAN`);
  }
}

const likeCache = new Map<string, RegExp>();

export function likeToRegex(pattern: string, insensitive: boolean): RegExp {
  const cacheKey = (insensitive ? 'i:' : 's:') + pattern;
  let re = likeCache.get(cacheKey);
  if (!re) {
    let src = '^';
    for (const ch of pattern) {
      if (ch === '%') src += '[\\s\\S]*';
      else if (ch === '_') src += '[\\s\\S]';
      else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    re = new RegExp(src + '$', insensitive ? 'iu' : 'u');
    if (likeCache.size > 500) likeCache.clear();
    likeCache.set(cacheKey, re);
  }
  return re;
}

// ------------------------------------------------------------ scalar functions

type ScalarFn = { min: number; max: number; fn: (args: Value[]) => Value };

const str = (v: Value, name: string): string => {
  if (typeof v !== 'string') throw typeError(`${name}() expects TEXT, got ${typeOfValue(v)}`);
  return v;
};

const nullIfAnyNull = (fn: (args: Value[]) => Value) => (args: Value[]) => (args.some((a) => a === null) ? null : fn(args));

const SCALARS: Record<string, ScalarFn> = {
  ABS: { min: 1, max: 1, fn: nullIfAnyNull(([x]) => Math.abs(num(x!, 'abs'))) },
  ROUND: {
    min: 1, max: 2,
    fn: nullIfAnyNull(([x, d]) => {
      const p = 10 ** (d === undefined ? 0 : num(d, 'round'));
      const v = num(x!, 'round') * p;
      return (Math.sign(v) * Math.round(Math.abs(v))) / p;
    }),
  },
  FLOOR: { min: 1, max: 1, fn: nullIfAnyNull(([x]) => Math.floor(num(x!, 'floor'))) },
  CEIL: { min: 1, max: 1, fn: nullIfAnyNull(([x]) => Math.ceil(num(x!, 'ceil'))) },
  CEILING: { min: 1, max: 1, fn: nullIfAnyNull(([x]) => Math.ceil(num(x!, 'ceiling'))) },
  SQRT: { min: 1, max: 1, fn: nullIfAnyNull(([x]) => (num(x!, 'sqrt') < 0 ? null : Math.sqrt(x as number))) },
  POWER: { min: 2, max: 2, fn: nullIfAnyNull(([x, y]) => num(x!, 'power') ** num(y!, 'power')) },
  MOD: { min: 2, max: 2, fn: nullIfAnyNull(([x, y]) => (num(y!, 'mod') === 0 ? null : num(x!, 'mod') % (y as number))) },
  LENGTH: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => [...str(s!, 'length')].length) },
  UPPER: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => str(s!, 'upper').toUpperCase()) },
  LOWER: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => str(s!, 'lower').toLowerCase()) },
  TRIM: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => str(s!, 'trim').trim()) },
  LTRIM: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => str(s!, 'ltrim').trimStart()) },
  RTRIM: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => str(s!, 'rtrim').trimEnd()) },
  REVERSE: { min: 1, max: 1, fn: nullIfAnyNull(([s]) => [...str(s!, 'reverse')].reverse().join('')) },
  SUBSTR: {
    min: 2, max: 3,
    fn: nullIfAnyNull(([s, start, len]) => {
      const chars = [...str(s!, 'substr')];
      const from = Math.max(num(start!, 'substr') - 1, 0);
      const to = len === undefined ? chars.length : num(start!, 'substr') - 1 + num(len, 'substr');
      return chars.slice(from, Math.max(from, to)).join('');
    }),
  },
  REPLACE: { min: 3, max: 3, fn: nullIfAnyNull(([s, a, b]) => str(s!, 'replace').split(str(a!, 'replace')).join(str(b!, 'replace'))) },
  INSTR: { min: 2, max: 2, fn: nullIfAnyNull(([s, sub]) => str(s!, 'instr').indexOf(str(sub!, 'instr')) + 1) },
  COALESCE: { min: 1, max: Infinity, fn: (args) => args.find((a) => a !== null) ?? null },
  IFNULL: { min: 2, max: 2, fn: ([a, b]) => (a === null ? b! : a!) },
  NULLIF: { min: 2, max: 2, fn: ([a, b]) => (a !== null && b !== null && sqlCompare(a!, b!) === 0 ? null : a!) },
  GREATEST: {
    min: 1, max: Infinity,
    fn: (args) => args.filter((a) => a !== null).reduce<Value>((m, a) => (m === null || sqlCompare(a, m) > 0 ? a : m), null),
  },
  LEAST: {
    min: 1, max: Infinity,
    fn: (args) => args.filter((a) => a !== null).reduce<Value>((m, a) => (m === null || sqlCompare(a, m) < 0 ? a : m), null),
  },
  CONCAT: { min: 1, max: Infinity, fn: (args) => args.filter((a) => a !== null).map(toText).join('') },
  TYPEOF: { min: 1, max: 1, fn: ([a]) => typeOfValue(a!).toLowerCase() },
  RANDOM: { min: 0, max: 0, fn: () => Math.random() },
};

SCALARS.SUBSTRING = SCALARS.SUBSTR!;
SCALARS.POW = SCALARS.POWER!;
SCALARS.CHAR_LENGTH = SCALARS.LENGTH!;

export const SCALAR_FUNCTION_NAMES = Object.keys(SCALARS);

// ----------------------------------------------------------------- compiler

export function compileExpr(e: Expr, scope: Scope, ctx: CompileContext): Compiled {
  const sub = ctx.substitute?.(e);
  if (sub) return sub;
  const c = (x: Expr) => compileExpr(x, scope, ctx);

  switch (e.kind) {
    case 'literal': {
      const v = e.value;
      return () => v;
    }
    case 'param': {
      const i = e.index;
      return (_r, env) => {
        if (i >= env.params.length) throw new DbError('MISUSE', `missing value for parameter ${i + 1}`);
        return env.params[i]!;
      };
    }
    case 'column': {
      const { depth, index } = scope.resolve(e.table, e.name);
      if (depth === 0) return (row) => row[index]!;
      return (_r, env) => env.outers[env.outers.length - depth]![index]!;
    }
    case 'unary': {
      const inner = c(e.expr);
      if (e.op === 'NOT') {
        return (r, env) => {
          const t = truthy(inner(r, env));
          return t === null ? null : !t;
        };
      }
      return (r, env) => {
        const v = inner(r, env);
        return v === null ? null : -num(v, '-');
      };
    }
    case 'binary':
      return compileBinary(e.op, c(e.left), c(e.right));
    case 'isNull': {
      const inner = c(e.expr);
      return e.not ? (r, env) => inner(r, env) !== null : (r, env) => inner(r, env) === null;
    }
    case 'between': {
      const x = c(e.expr);
      const lo = c(e.low);
      const hi = c(e.high);
      const not = e.not;
      return (r, env) => {
        const v = x(r, env);
        const a = lo(r, env);
        const b = hi(r, env);
        const ge = v === null || a === null ? null : sqlCompare(v, a) >= 0;
        const le = v === null || b === null ? null : sqlCompare(v, b) <= 0;
        const res = ge === false || le === false ? false : ge === null || le === null ? null : true;
        return res === null ? null : not ? !res : res;
      };
    }
    case 'inList': {
      const x = c(e.expr);
      const list = e.list.map(c);
      const not = e.not;
      return (r, env) => inSemantics(x(r, env), list.map((f) => f(r, env)), not);
    }
    case 'inSelect': {
      const x = c(e.expr);
      const sq = subquery(e.select, scope, ctx, 1);
      const not = e.not;
      return (r, env) => inSemantics(x(r, env), sq.values(r, env), not);
    }
    case 'exists': {
      const sq = subquery(e.select, scope, ctx, null);
      const not = e.not;
      return (r, env) => sq.exists(r, env) !== not;
    }
    case 'subquery': {
      const sq = subquery(e.select, scope, ctx, 1);
      return (r, env) => {
        const vals = sq.values(r, env, 2);
        if (vals.length > 1) throw new DbError('CARDINALITY', 'scalar subquery returned more than one row');
        return vals[0] ?? null;
      };
    }
    case 'like': {
      const x = c(e.expr);
      const p = c(e.pattern);
      const { not, insensitive } = e;
      return (r, env) => {
        const v = x(r, env);
        const pat = p(r, env);
        if (v === null || pat === null) return null;
        const m = likeToRegex(str(pat, 'LIKE'), insensitive).test(str(v, 'LIKE'));
        return not ? !m : m;
      };
    }
    case 'case': {
      const operand = e.operand ? c(e.operand) : null;
      const whens = e.whens.map((w) => ({ when: c(w.when), then: c(w.then) }));
      const otherwise = e.else ? c(e.else) : () => null;
      return (r, env) => {
        const base = operand ? operand(r, env) : null;
        for (const w of whens) {
          const cond = w.when(r, env);
          const hit = operand ? base !== null && cond !== null && sqlCompare(base, cond) === 0 : truthy(cond) === true;
          if (hit) return w.then(r, env);
        }
        return otherwise(r, env);
      };
    }
    case 'cast': {
      const inner = c(e.expr);
      const type = e.type;
      return (r, env) => castValue(inner(r, env), type);
    }
    case 'call': {
      if (AGGREGATES.has(e.name)) throw semanticError(`aggregate function ${e.name.toLowerCase()}() is not allowed in ${ctx.clause}`);
      const f = SCALARS[e.name];
      if (!f) throw semanticError(`no such function: ${e.name.toLowerCase()}`);
      if (e.star || e.args.length < f.min || e.args.length > f.max) {
        throw semanticError(`wrong number of arguments to ${e.name.toLowerCase()}()`);
      }
      const args = e.args.map(c);
      const fn = f.fn;
      return (r, env) => fn(args.map((a) => a(r, env)));
    }
  }
}

function inSemantics(v: Value, candidates: Value[], not: boolean): Value {
  if (v === null) return candidates.length === 0 ? not : null;
  let sawNull = false;
  for (const cand of candidates) {
    if (cand === null) sawNull = true;
    else if (sqlCompare(v, cand) === 0) return !not;
  }
  return sawNull ? null : not;
}

function compileBinary(op: string, l: Compiled, r: Compiled): Compiled {
  switch (op) {
    case 'AND':
      return (row, env) => {
        const a = truthy(l(row, env));
        if (a === false) return false;
        const b = truthy(r(row, env));
        if (b === false) return false;
        return a === null || b === null ? null : true;
      };
    case 'OR':
      return (row, env) => {
        const a = truthy(l(row, env));
        if (a === true) return true;
        const b = truthy(r(row, env));
        if (b === true) return true;
        return a === null || b === null ? null : false;
      };
    case '||':
      return (row, env) => {
        const a = l(row, env);
        const b = r(row, env);
        return a === null || b === null ? null : toText(a) + toText(b);
      };
    case '=': case '<>': case '<': case '<=': case '>': case '>=': {
      const test =
        op === '=' ? (c: number) => c === 0 : op === '<>' ? (c: number) => c !== 0 : op === '<' ? (c: number) => c < 0
        : op === '<=' ? (c: number) => c <= 0 : op === '>' ? (c: number) => c > 0 : (c: number) => c >= 0;
      return (row, env) => {
        const a = l(row, env);
        const b = r(row, env);
        return a === null || b === null ? null : test(sqlCompare(a, b));
      };
    }
    default: {
      const arith =
        op === '+' ? (a: number, b: number) => a + b
        : op === '-' ? (a: number, b: number) => a - b
        : op === '*' ? (a: number, b: number) => a * b
        : op === '/' ? (a: number, b: number) => {
            if (b === 0) throw new DbError('ARITHMETIC', 'division by zero');
            return a / b;
          }
        : (a: number, b: number) => {
            if (b === 0) throw new DbError('ARITHMETIC', 'division by zero');
            return a % b;
          };
      return (row, env) => {
        const a = l(row, env);
        const b = r(row, env);
        if (a === null || b === null) return null;
        return arith(num(a, op), num(b, op));
      };
    }
  }
}

/**
 * Wraps a subquery. Uncorrelated subqueries run once per statement and are
 * cached; correlated ones re-run for every outer row, with that row pushed
 * onto `env.outers` so inner column references can reach it.
 */
function subquery(select: SelectStmt, scope: Scope, ctx: CompileContext, columns: number | null) {
  const { plan, correlated } = ctx.planSubquery(select, scope);
  if (columns !== null && plan.schema.filter((c) => !c.hidden).length !== columns) {
    throw semanticError(`subquery must return exactly ${columns} column: ${exprToSql({ kind: 'subquery', select })}`);
  }
  if (correlated && ctx.substitute) {
    throw semanticError('correlated subqueries are not supported after aggregation');
  }
  let cacheId = -1;
  let cache: Value[] = [];
  let cacheExists = false;

  const innerEnv = (row: Row, env: Env): Env => ({ ...env, outers: [...env.outers, row] });

  return {
    values(row: Row, env: Env, limit = Infinity): Value[] {
      if (!correlated && cacheId === env.execId) return cache;
      const out: Value[] = [];
      for (const r of plan.rows(innerEnv(row, env))) {
        out.push(r[0]!);
        if (out.length >= limit && correlated) break;
      }
      if (!correlated) {
        cacheId = env.execId;
        cache = out;
      }
      return out;
    },
    exists(row: Row, env: Env): boolean {
      if (!correlated && cacheId === env.execId) return cacheExists;
      let found = false;
      for (const _ of plan.rows(innerEnv(row, env))) {
        found = true;
        break;
      }
      if (!correlated) {
        cacheId = env.execId;
        cacheExists = found;
      }
      return found;
    },
  };
}
