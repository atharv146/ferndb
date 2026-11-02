/**
 * The query planner turns a parsed SELECT into a tree of physical operators.
 *
 * Main decisions:
 *  - Predicate pushdown: WHERE / ON conjuncts that mention a single table are
 *    applied at that table's scan; ones spanning two tables become join
 *    conditions. LEFT JOIN semantics restrict what may move (a WHERE filter on
 *    the null-supplying side must stay above the join).
 *  - Access paths: for each table, every usable equality / range / IN
 *    predicate is matched against the primary key and each index, and the
 *    cheapest path wins (point lookup < prefix scan < range scan < full scan).
 *  - Joins: an index nested-loop join when the inner table can be probed
 *    through a key, otherwise a hash join on the equi-join keys, otherwise a
 *    nested-loop join.
 *  - Ordering: if the chosen access path already returns rows in ORDER BY
 *    order, the sort is skipped (and the scan may run backwards for DESC).
 *    With LIMIT, an index on the sort column may be used just for its order.
 *    Otherwise a top-N heap sort is used when there is a LIMIT.
 */
import { hasRowid, ROWID, type AccessPath, type Catalog, type TableInfo } from '../catalog.ts';
import type { Expr, FromItem, OrderItem, SelectCore, SelectStmt } from '../sql/ast.ts';
import { exprEquals, exprToSql } from '../sql/printer.ts';
import { semanticError, typeError, typeOfValue } from '../types.ts';
import {
  AGGREGATES,
  compileExpr,
  containsAggregate,
  containsSubquery,
  isAggregateCall,
  Scope,
  walkExpr,
  type CompileContext,
  type Compiled,
  type ScopeCol,
} from '../exec/expr.ts';
import {
  Distinct,
  Filter,
  HashAggregate,
  HashJoin,
  IndexNestedLoopJoin,
  IndexScan,
  Limit,
  NestedLoopJoin,
  OneRow,
  Project,
  SeqScan,
  SetOperation,
  Sort,
  SubqueryScan,
  type AggSpec,
  type KeyRange,
  type PlanNode,
  type SortKey,
  type TreeProvider,
} from '../exec/operators.ts';

export interface PlannerContext extends TreeProvider {
  catalog: Catalog;
}

export interface PlannedSelect {
  plan: PlanNode;
  columns: string[];
  correlated: boolean;
}

interface Conj {
  expr: Expr;
  /** Table aliases referenced at this query level; null if the conjunct can't be moved. */
  tables: Set<string> | null;
}

interface Planned {
  plan: PlanNode;
  scope: Scope;
  aliases: Set<string>;
  /** Present when the item is a plain table: what an index nested-loop join needs. */
  base?: { table: TableInfo; alias: string; conj: Expr[]; point: boolean };
}

interface OrderHint {
  column: string;
  desc: boolean;
  hasLimit: boolean;
}

interface Sarg {
  conj: Expr;
  col: number;
  op: '=' | '<' | '<=' | '>' | '>=' | 'in';
  values: Expr[];
}

const FLIP: Record<string, Sarg['op']> = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };

export function splitAnd(e: Expr | null): Expr[] {
  if (!e) return [];
  if (e.kind === 'binary' && e.op === 'AND') return [...splitAnd(e.left), ...splitAnd(e.right)];
  return [e];
}

function joinAnd(es: Expr[]): Expr | null {
  if (es.length === 0) return null;
  return es.reduce((a, b) => ({ kind: 'binary', op: 'AND', left: a, right: b }));
}

function take<T>(arr: T[], pred: (x: T) => boolean): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; ) {
    if (pred(arr[i]!)) out.push(arr.splice(i, 1)[0]!);
    else i++;
  }
  return out;
}

function subset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function tableSchema(t: TableInfo, alias: string): ScopeCol[] {
  const cols: ScopeCol[] = t.columns.map((c) => ({ table: alias, name: c.name, type: c.type }));
  if (hasRowid(t)) cols.push({ table: alias, name: ROWID, type: 'INTEGER', hidden: true });
  return cols;
}

/**
 * Index lookups compare encoded bytes, which would silently find nothing for
 * `int_col = 'x'`. Check types up front so the result matches a filter.
 */
function checkKeyType(fn: Compiled, t: TableInfo, col: number): Compiled {
  const type = t.columns[col]?.type ?? 'INTEGER';
  const want = type === 'INTEGER' || type === 'REAL' ? 'number' : type === 'TEXT' ? 'string' : 'boolean';
  return (row, env) => {
    const v = fn(row, env);
    if (v !== null && typeof v !== want) throw typeError(`cannot compare ${type} with ${typeOfValue(v)}`);
    return v;
  };
}

function displayName(item: Expr, alias: string | null): string {
  if (alias) return alias;
  if (item.kind === 'column') return item.name;
  return exprToSql(item);
}

export class Planner {
  private readonly ctx: PlannerContext;
  private readonly scopes: Scope[] = [];
  private readonly fromCache = new Map<FromItem, PlannedSelect>();

  constructor(ctx: PlannerContext) {
    this.ctx = ctx;
  }

  private newScope(cols: ScopeCol[], outer: Scope | null): Scope {
    const s = new Scope(cols, outer);
    this.scopes.push(s);
    return s;
  }

  private cctx(clause: string, substitute?: CompileContext['substitute']): CompileContext {
    return {
      clause,
      substitute,
      planSubquery: (select, scope) => {
        const r = this.planSelect(select, scope);
        return { plan: r.plan, correlated: r.correlated };
      },
    };
  }

  compile(e: Expr, scope: Scope, clause: string): Compiled {
    return compileExpr(e, scope, this.cctx(clause));
  }

  private compileAll(es: Expr[], scope: Scope, clause: string): Compiled | null {
    const e = joinAnd(es);
    return e ? this.compile(e, scope, clause) : null;
  }

  // --------------------------------------------------------------- SELECT

  planSelect(stmt: SelectStmt, outer: Scope | null): PlannedSelect {
    const start = this.scopes.length;
    let result: { plan: PlanNode; columns: string[] };
    if (stmt.compound.length === 0) {
      result = this.planCore(stmt.core, outer, stmt.orderBy, stmt.limit, stmt.offset);
    } else {
      result = this.planCompound(stmt, outer);
    }
    const correlated = outer !== null && this.scopes.slice(start).some((s) => s.outer === outer && s.correlated);
    return { ...result, correlated };
  }

  private planCompound(stmt: SelectStmt, outer: Scope | null): { plan: PlanNode; columns: string[] } {
    const first = this.planCore(stmt.core, outer, [], null, null);
    let plan = first.plan;
    for (const part of stmt.compound) {
      const next = this.planCore(part.core, outer, [], null, null);
      if (next.columns.length !== first.columns.length) {
        throw semanticError(`each ${part.op} query must have the same number of columns`);
      }
      plan = new SetOperation(part.op, plan, next.plan);
    }
    if (stmt.orderBy.length > 0) {
      const keys = stmt.orderBy.map((o) => {
        const idx = this.outputPosition(o.expr, first.columns, []);
        if (idx === -1) throw semanticError('ORDER BY term of a compound SELECT must name or number an output column');
        return { index: idx, desc: o.desc };
      });
      plan = new Sort(plan, keys, this.orderText(stmt.orderBy), first.columns.length, this.topNCount(stmt, outer));
    }
    plan = this.limit(plan, stmt.limit, stmt.offset, outer);
    return { plan, columns: first.columns };
  }

  /** Index of an output column named or numbered by `e`, or -1. */
  private outputPosition(e: Expr, names: string[], exprs: Expr[]): number {
    if (e.kind === 'literal' && typeof e.value === 'number' && Number.isInteger(e.value)) {
      if (e.value < 1 || e.value > names.length) throw semanticError(`ORDER BY position ${e.value} is out of range`);
      return e.value - 1;
    }
    if (e.kind === 'column' && e.table === null) {
      const matches = names.map((n, i) => (n.toLowerCase() === e.name.toLowerCase() ? i : -1)).filter((i) => i >= 0);
      if (matches.length === 1) return matches[0]!;
    }
    return exprs.findIndex((x) => exprEquals(x, e));
  }

  private orderText(order: OrderItem[]): string {
    return order.map((o) => exprToSql(o.expr) + (o.desc ? ' DESC' : '')).join(', ');
  }

  private constScope(outer: Scope | null): Scope {
    return this.newScope([], outer);
  }

  private topNCount(stmt: { limit: Expr | null; offset: Expr | null }, outer: Scope | null): Compiled | null {
    if (!stmt.limit) return null;
    const scope = this.constScope(outer);
    const lim = this.compile(stmt.limit, scope, 'LIMIT');
    const off = stmt.offset ? this.compile(stmt.offset, scope, 'OFFSET') : null;
    return (r, env) => {
      const l = lim(r, env);
      const o = off ? off(r, env) : 0;
      return typeof l === 'number' && typeof o === 'number' ? l + o : l;
    };
  }

  private limit(plan: PlanNode, limit: Expr | null, offset: Expr | null, outer: Scope | null): PlanNode {
    if (!limit && !offset) return plan;
    const scope = this.constScope(outer);
    const text = [limit ? `limit ${exprToSql(limit)}` : '', offset ? `offset ${exprToSql(offset)}` : ''].filter(Boolean).join(' ');
    return new Limit(plan, limit ? this.compile(limit, scope, 'LIMIT') : null, offset ? this.compile(offset, scope, 'OFFSET') : null, text);
  }

  private planCore(core: SelectCore, outer: Scope | null, orderBy: OrderItem[], limit: Expr | null, offset: Expr | null): { plan: PlanNode; columns: string[] } {
    const hasAgg =
      core.groupBy.length > 0 ||
      core.having !== null ||
      core.columns.some((c) => c.kind === 'expr' && containsAggregate(c.expr)) ||
      orderBy.some((o) => containsAggregate(o.expr));

    // Can the scan itself deliver ORDER BY order?
    let hint: OrderHint | null = null;
    if (!hasAgg && !core.distinct && core.from?.kind === 'table' && orderBy.length === 1) {
      let e = orderBy[0]!.expr;
      const items = core.columns.filter((c) => c.kind === 'expr');
      if (e.kind === 'literal' && typeof e.value === 'number' && core.columns.every((c) => c.kind === 'expr')) {
        const it = core.columns[e.value - 1];
        if (it && it.kind === 'expr') e = it.expr;
      } else if (e.kind === 'column' && e.table === null) {
        const aliased = items.find((c) => c.kind === 'expr' && c.alias?.toLowerCase() === (e as { name: string }).name.toLowerCase());
        if (aliased && aliased.kind === 'expr') e = aliased.expr;
      }
      if (e.kind === 'column') hint = { column: e.name, desc: orderBy[0]!.desc, hasLimit: limit !== null };
    }

    // ---- FROM + WHERE
    let plan: PlanNode;
    let scope: Scope;
    let ordered = false;
    if (core.from) {
      scope = this.newScope(this.fromColumns(core.from, outer), outer);
      const pending = splitAnd(core.where).map((e) => this.classify(e, scope));
      const p = this.planFrom(core.from, pending, outer, scope, hint);
      plan = p.plan;
      ordered = (p as Planned & { ordered?: boolean }).ordered ?? false;
      const rest = pending.map((c) => c.expr);
      if (rest.length > 0) plan = new Filter(plan, this.compileAll(rest, scope, 'WHERE')!, exprToSql(joinAnd(rest)!));
    } else {
      scope = this.newScope([], outer);
      plan = new OneRow();
      if (core.where) plan = new Filter(plan, this.compile(core.where, scope, 'WHERE'), exprToSql(core.where));
    }

    // ---- SELECT list (expand *)
    const items: { expr: Expr; name: string }[] = [];
    for (const c of core.columns) {
      if (c.kind === 'star') {
        const t = c.table?.toLowerCase() ?? null;
        const cols = scope.cols.filter((col) => !col.hidden && (t === null || col.table === t));
        if (t !== null && cols.length === 0 && !scope.cols.some((col) => col.table === t)) throw semanticError(`no such table: ${c.table}`);
        if (t === null && core.from === null) throw semanticError('SELECT * requires a FROM clause');
        for (const col of cols) items.push({ expr: { kind: 'column', table: col.table, name: col.name }, name: col.name });
      } else {
        items.push({ expr: c.expr, name: displayName(c.expr, c.alias) });
      }
    }

    // ---- GROUP BY / aggregates
    let compileOut = (e: Expr, clause: string): Compiled => this.compile(e, scope, clause);
    if (hasAgg) {
      const groupExprs = core.groupBy.map((g) => {
        // GROUP BY may name a select alias or position, as in PostgreSQL.
        if (g.kind === 'literal' && typeof g.value === 'number') {
          const it = items[g.value - 1];
          if (!it) throw semanticError(`GROUP BY position ${g.value} is out of range`);
          return it.expr;
        }
        if (g.kind === 'column' && g.table === null && scope.find(null, g.name) === -1) {
          const it = items.find((i) => i.name.toLowerCase() === g.name.toLowerCase());
          if (it) return it.expr;
        }
        return g;
      });
      const aggCalls: Expr[] = [];
      const collect = (e: Expr) =>
        walkExpr(e, (x) => {
          if (isAggregateCall(x) && !aggCalls.some((a) => exprEquals(a, x))) aggCalls.push(x);
        });
      items.forEach((i) => collect(i.expr));
      if (core.having) collect(core.having);
      orderBy.forEach((o) => collect(o.expr));

      const groups = groupExprs.map((g) => this.compile(g, scope, 'GROUP BY'));
      const specs = aggCalls.map((a) => this.aggSpec(a, scope));
      const schema: ScopeCol[] = [...groupExprs, ...aggCalls].map((e) => ({ table: null, name: exprToSql(e), type: null }));
      plan = new HashAggregate(plan, groups, specs, schema, {
        groups: groupExprs.map(exprToSql).join(', '),
        aggs: aggCalls.map(exprToSql).join(', '),
      });

      const nGroups = groupExprs.length;
      const substitute = (e: Expr): Compiled | null => {
        const gi = groupExprs.findIndex((g) => exprEquals(g, e));
        if (gi >= 0) return (row) => row[gi]!;
        const ai = aggCalls.findIndex((a) => exprEquals(a, e));
        if (ai >= 0) return (row) => row[nGroups + ai]!;
        if (e.kind === 'column' && scope.find(e.table, e.name) !== -1) {
          throw semanticError(`column "${exprToSql(e)}" must appear in the GROUP BY clause or be used in an aggregate function`);
        }
        return null;
      };
      compileOut = (e, clause) => compileExpr(e, scope, this.cctx(clause, substitute));
      if (core.having) plan = new Filter(plan, compileOut(core.having, 'HAVING'), `having: ${exprToSql(core.having)}`);
    }

    // ---- ORDER BY resolution (outputs first, then hidden sort columns)
    const names = items.map((i) => i.name);
    const exprs = items.map((i) => i.expr);
    const hidden: Expr[] = [];
    let keys: SortKey[] = [];
    if (!ordered && orderBy.length > 0) {
      keys = orderBy.map((o) => {
        const idx = this.outputPosition(o.expr, names, exprs);
        if (idx >= 0) return { index: idx, desc: o.desc };
        if (core.distinct) throw semanticError('for SELECT DISTINCT, ORDER BY expressions must appear in the select list');
        hidden.push(o.expr);
        return { index: items.length + hidden.length - 1, desc: o.desc };
      });
    }

    const projected = [...exprs, ...hidden];
    const outSchema: ScopeCol[] = [...names, ...hidden.map(exprToSql)].map((n, i) => ({ table: null, name: n, type: null, hidden: i >= names.length }));
    plan = new Project(plan, projected.map((e) => compileOut(e, clauseOf(e))), outSchema, names);
    if (core.distinct) plan = new Distinct(plan);
    if (keys.length > 0) plan = new Sort(plan, keys, this.orderText(orderBy), names.length, this.topNCount({ limit, offset }, outer));
    plan = this.limit(plan, limit, offset, outer);
    return { plan, columns: names };

    function clauseOf(e: Expr): string {
      return hidden.includes(e) ? 'ORDER BY' : 'the select list';
    }
  }

  private aggSpec(call: Expr, scope: Scope): AggSpec {
    if (call.kind !== 'call' || !AGGREGATES.has(call.name)) throw new Error('not an aggregate');
    const fn = call.name;
    const lower = fn.toLowerCase();
    if (call.star) {
      if (fn !== 'COUNT') throw semanticError(`${lower}(*) is not valid`);
      return { fn, arg: null, separator: null, distinct: false };
    }
    const max = fn === 'GROUP_CONCAT' || fn === 'STRING_AGG' ? 2 : 1;
    const min = fn === 'STRING_AGG' ? 2 : 1;
    if (call.args.length < min || call.args.length > max) throw semanticError(`wrong number of arguments to ${lower}()`);
    return {
      fn,
      arg: this.compile(call.args[0]!, scope, `the argument of ${lower}()`),
      separator: call.args[1] ? this.compile(call.args[1], scope, `the argument of ${lower}()`) : null,
      distinct: call.distinct,
    };
  }

  // ----------------------------------------------------------------- FROM

  private plannedSubquery(item: FromItem & { kind: 'subquery' }, outer: Scope | null): PlannedSelect {
    let r = this.fromCache.get(item);
    if (!r) {
      r = this.planSelect(item.select, outer);
      this.fromCache.set(item, r);
    }
    return r;
  }

  /** Columns produced by a FROM item, in the order rows will lay them out. */
  private fromColumns(item: FromItem, outer: Scope | null): ScopeCol[] {
    switch (item.kind) {
      case 'table': {
        const t = this.ctx.catalog.getTable(item.name);
        return tableSchema(t, (item.alias ?? item.name).toLowerCase());
      }
      case 'subquery': {
        const r = this.plannedSubquery(item, outer);
        return r.columns.map((n) => ({ table: item.alias.toLowerCase(), name: n, type: null }));
      }
      case 'join': {
        const cols = [...this.fromColumns(item.left, outer), ...this.fromColumns(item.right, outer)];
        const seen = new Set<string>();
        for (const c of cols) {
          if (c.hidden || c.table === null) continue;
          const key = `${c.table}`;
          if (seen.has(key) && cols.filter((x) => x.table === c.table && x.name === c.name).length > 1) {
            throw semanticError(`table name "${c.table}" specified more than once`);
          }
          seen.add(key);
        }
        return cols;
      }
    }
  }

  /** Which tables of this query level an expression refers to. */
  private classify(e: Expr, level: Scope): Conj {
    if (containsSubquery(e) || containsAggregate(e)) return { expr: e, tables: null };
    const tables = new Set<string>();
    walkExpr(e, (x) => {
      if (x.kind !== 'column') return;
      const i = level.find(x.table, x.name);
      if (i >= 0) {
        tables.add(level.cols[i]!.table!);
        return;
      }
      for (let s = level.outer; s; s = s.outer) if (s.find(x.table, x.name) >= 0) return;
      throw semanticError(`no such column: ${x.table ? `${x.table}.` : ''}${x.name}`);
    });
    return { expr: e, tables };
  }

  private planFrom(item: FromItem, pending: Conj[], outer: Scope | null, level: Scope, hint: OrderHint | null): Planned & { ordered?: boolean } {
    switch (item.kind) {
      case 'table': {
        const t = this.ctx.catalog.getTable(item.name);
        const alias = (item.alias ?? item.name).toLowerCase();
        const scope = this.newScope(tableSchema(t, alias), outer);
        const mine = take(pending, (c) => c.tables !== null && c.tables.size > 0 && subset(c.tables, new Set([alias]))).map((c) => c.expr);
        const access = this.accessPath(t, alias, scope, mine, hint);
        return { plan: access.plan, scope, aliases: new Set([alias]), base: { table: t, alias, conj: mine, point: access.point }, ordered: access.ordered };
      }
      case 'subquery': {
        const r = this.plannedSubquery(item, outer);
        const alias = item.alias.toLowerCase();
        const cols: ScopeCol[] = r.columns.map((n) => ({ table: alias, name: n, type: null }));
        const scope = this.newScope(cols, outer);
        let plan: PlanNode = new SubqueryScan(cols, r.plan, alias);
        const mine = take(pending, (c) => c.tables !== null && c.tables.size > 0 && subset(c.tables, new Set([alias]))).map((c) => c.expr);
        if (mine.length > 0) plan = new Filter(plan, this.compileAll(mine, scope, 'WHERE')!, exprToSql(joinAnd(mine)!));
        return { plan, scope, aliases: new Set([alias]) };
      }
      case 'join':
        return this.planJoin(item, pending, outer, level);
    }
  }

  private planJoin(item: FromItem & { kind: 'join' }, pending: Conj[], outer: Scope | null, level: Scope): Planned {
    const leftJoin = item.type === 'LEFT';
    let onConj = splitAnd(item.on);
    let left: Planned;
    let right: Planned;
    let joinConj: Conj[];

    const usingConj = (l: Planned): Expr[] => {
      if (!item.using) return [];
      const rightAlias = item.right.kind === 'join' ? null : (item.right.alias ?? (item.right as { name: string }).name).toLowerCase();
      return item.using.map((name) => {
        const li = l.scope.find(null, name);
        if (li === -1) throw semanticError(`column ${name} specified in USING does not exist in the left table`);
        return {
          kind: 'binary',
          op: '=',
          left: { kind: 'column', table: l.scope.cols[li]!.table, name },
          right: { kind: 'column', table: rightAlias, name },
        } as Expr;
      });
    };

    if (!leftJoin) {
      if (!item.using) pending.push(...onConj.map((e) => this.classify(e, level)));
      left = this.planFrom(item.left, pending, outer, level, null);
      onConj = usingConj(left);
      pending.push(...onConj.map((e) => this.classify(e, level)));
      right = this.planFrom(item.right, pending, outer, level, null);
      const both = new Set([...left.aliases, ...right.aliases]);
      joinConj = take(pending, (c) => c.tables !== null && c.tables.size > 0 && subset(c.tables, both));
    } else {
      left = this.planFrom(item.left, pending, outer, level, null);
      if (item.using) onConj = usingConj(left);
      const rightPending = onConj.map((e) => this.classify(e, level));
      right = this.planFrom(item.right, rightPending, outer, level, null);
      joinConj = rightPending;
    }

    const scope = this.newScope([...left.scope.cols, ...right.scope.cols], outer);
    const aliases = new Set([...left.aliases, ...right.aliases]);

    // Equi-join conditions: one side from each input.
    const equi: { conj: Conj; l: Expr; r: Expr }[] = [];
    for (const c of joinConj) {
      const e = c.expr;
      if (e.kind !== 'binary' || e.op !== '=' || c.tables === null) continue;
      const lt = this.classify(e.left, level).tables;
      const rt = this.classify(e.right, level).tables;
      if (!lt || !rt || lt.size === 0 || rt.size === 0) continue;
      if (subset(lt, left.aliases) && subset(rt, right.aliases)) equi.push({ conj: c, l: e.left, r: e.right });
      else if (subset(lt, right.aliases) && subset(rt, left.aliases)) equi.push({ conj: c, l: e.right, r: e.left });
    }

    // 1) Index nested-loop join: probe the inner table by key for each outer row.
    if (right.base && !right.base.point && equi.length > 0) {
      const { table, alias, conj } = right.base;
      let best: { path: AccessPath; used: typeof equi } | null = null;
      for (const path of this.ctx.catalog.accessPaths(table)) {
        const used: typeof equi = [];
        for (const col of path.columns) {
          const m = equi.find((q) => !used.includes(q) && q.r.kind === 'column' && right.scope.find(q.r.table, q.r.name) === col);
          if (!m) break;
          used.push(m);
        }
        if (used.length === 0) continue;
        const better = !best || used.length > best.used.length || (used.length === best.used.length && path.kind === 'pk' && best.path.kind !== 'pk');
        if (better) best = { path, used };
      }
      if (best) {
        const leftScopeForKeys = left.scope;
        const range: KeyRange = {
          eq: best.used.map((q, i) => checkKeyType(this.compile(q.l, leftScopeForKeys, 'ON'), table, best!.path.columns[i]!)),
          eqIn: null,
          lo: null,
          hi: null,
        };
        const residual = joinConj.filter((c) => !best!.used.some((u) => u.conj === c)).map((c) => c.expr);
        const plan = new IndexNestedLoopJoin(
          left.plan, right.scope.cols, table, alias, best.path, range,
          this.compileAll(conj, right.scope, 'WHERE'),
          this.compileAll(residual, scope, 'ON'),
          {
            lookup: best.used.map((u) => `${exprToSql(u.r)} = ${exprToSql(u.l)}`).join(' AND '),
            filter: conj.length ? exprToSql(joinAnd(conj)!) : '',
            residual: residual.length ? exprToSql(joinAnd(residual)!) : '',
          },
          leftJoin, this.ctx,
        );
        return { plan, scope, aliases };
      }
    }

    // 2) Hash join on equality keys.
    if (equi.length > 0) {
      const residual = joinConj.filter((c) => !equi.some((q) => q.conj === c)).map((c) => c.expr);
      const plan = new HashJoin(
        left.plan, right.plan,
        equi.map((q) => this.compile(q.l, left.scope, 'ON')),
        equi.map((q) => this.compile(q.r, right.scope, 'ON')),
        this.compileAll(residual, scope, 'ON'),
        {
          keys: equi.map((q) => `${exprToSql(q.l)} = ${exprToSql(q.r)}`).join(' AND '),
          residual: residual.length ? exprToSql(joinAnd(residual)!) : '',
        },
        leftJoin,
      );
      return { plan, scope, aliases };
    }

    // 3) Nested loop with an arbitrary condition (or a cross join).
    const conds = joinConj.map((c) => c.expr);
    const plan = new NestedLoopJoin(left.plan, right.plan, this.compileAll(conds, scope, 'ON'), conds.length ? exprToSql(joinAnd(conds)!) : '', leftJoin);
    return { plan, scope, aliases };
  }

  // --------------------------------------------------------- access paths

  /** True if `e` is constant for a scan of `scope`: no columns of this table, no subqueries. */
  private isScanConstant(e: Expr, scope: Scope): boolean {
    if (containsSubquery(e) || containsAggregate(e)) return false;
    let ok = true;
    walkExpr(e, (x) => {
      if (x.kind === 'column' && scope.find(x.table, x.name) !== -1) ok = false;
    });
    return ok;
  }

  private sargs(conj: Expr[], scope: Scope): Sarg[] {
    const out: Sarg[] = [];
    const colOf = (e: Expr): number => (e.kind === 'column' ? scope.find(e.table, e.name) : -1);
    for (const c of conj) {
      if (c.kind === 'binary' && c.op in FLIP) {
        const lc = colOf(c.left);
        const rc = colOf(c.right);
        if (lc >= 0 && this.isScanConstant(c.right, scope)) out.push({ conj: c, col: lc, op: c.op as Sarg['op'], values: [c.right] });
        else if (rc >= 0 && this.isScanConstant(c.left, scope)) out.push({ conj: c, col: rc, op: FLIP[c.op]!, values: [c.left] });
      } else if (c.kind === 'between' && !c.not) {
        const col = colOf(c.expr);
        if (col >= 0 && this.isScanConstant(c.low, scope) && this.isScanConstant(c.high, scope)) {
          out.push({ conj: c, col, op: '>=', values: [c.low] });
          out.push({ conj: c, col, op: '<=', values: [c.high] });
        }
      } else if (c.kind === 'inList' && !c.not) {
        const col = colOf(c.expr);
        if (col >= 0 && c.list.every((v) => this.isScanConstant(v, scope))) out.push({ conj: c, col, op: 'in', values: c.list });
      }
    }
    return out;
  }

  private accessPath(t: TableInfo, alias: string, scope: Scope, conj: Expr[], hint: OrderHint | null): { plan: PlanNode; ordered: boolean; point: boolean } {
    const sargs = this.sargs(conj, scope);
    const k = this.cctx('WHERE');
    const cs = this.constScope(scope.outer);
    const c = (e: Expr) => compileExpr(e, cs, k);

    type Candidate = { path: AccessPath; cost: number; used: Set<Expr>; range: KeyRange; nEq: number; hasIn: boolean; point: boolean };
    let best: Candidate | null = null;
    for (const path of this.ctx.catalog.accessPaths(t)) {
      const used = new Set<Expr>();
      const eq: Expr[] = [];
      let eqIn: Expr[] | null = null;
      for (const col of path.columns) {
        const s = sargs.find((x) => x.col === col && x.op === '=');
        if (s) {
          eq.push(s.values[0]!);
          used.add(s.conj);
          continue;
        }
        const inS = sargs.find((x) => x.col === col && x.op === 'in');
        if (inS) {
          eqIn = inS.values;
          used.add(inS.conj);
        }
        break;
      }
      let lo: Sarg | undefined;
      let hi: Sarg | undefined;
      const nextCol = path.columns[eq.length];
      if (!eqIn && nextCol !== undefined) {
        lo = sargs.find((x) => x.col === nextCol && (x.op === '>' || x.op === '>='));
        hi = sargs.find((x) => x.col === nextCol && (x.op === '<' || x.op === '<='));
        // BETWEEN contributes both bounds from one conjunct; only consume it if both are used.
        if (lo && lo.conj.kind === 'between' && hi?.conj !== lo.conj) lo = undefined;
        if (hi && hi.conj.kind === 'between' && lo?.conj !== hi.conj) hi = undefined;
        if (lo) used.add(lo.conj);
        if (hi) used.add(hi.conj);
      }
      if (used.size === 0) continue;
      const point = path.unique && !eqIn && eq.length === path.columns.length;
      const nKeys = eq.length + (eqIn ? 1 : 0);
      let cost = point ? 1 : nKeys > 0 ? 10 / nKeys + (eqIn ? eqIn.length : 0) : lo && hi ? 60 : 100;
      if (path.kind === 'index' && !point) cost *= 1.5;
      const typed = (e: Expr, col: number) => checkKeyType(c(e), t, col);
      const range: KeyRange = {
        eq: eq.map((e, i) => typed(e, path.columns[i]!)),
        eqIn: eqIn ? eqIn.map((e) => typed(e, path.columns[eq.length]!)) : null,
        lo: lo ? { fn: typed(lo.values[0]!, nextCol!), inclusive: lo.op === '>=' } : null,
        hi: hi ? { fn: typed(hi.values[0]!, nextCol!), inclusive: hi.op === '<=' } : null,
      };
      if (!best || cost < best.cost) best = { path, cost, used, range, nEq: eq.length, hasIn: eqIn !== null, point };
    }

    // Ordering: does the chosen path return rows in ORDER BY order?
    let ordered = false;
    let reverse = false;
    const hintCol = hint ? scope.find(null, hint.column) : -1;
    const provides = (path: AccessPath, nEq: number) => hintCol >= 0 && path.columns[nEq] === hintCol;
    if (hint && best && !best.hasIn && provides(best.path, best.nEq)) {
      ordered = true;
      reverse = hint.desc;
    }
    if (hint && !best && hintCol >= 0) {
      const paths = this.ctx.catalog.accessPaths(t);
      const pk = paths[0]!;
      if (pk.columns[0] === hintCol) {
        ordered = true;
        reverse = hint.desc;
      } else if (hint.hasLimit) {
        // An index scan just for its order beats sorting the whole table when only a few rows are wanted.
        const idx = paths.find((p) => p.kind === 'index' && p.columns[0] === hintCol);
        if (idx) {
          best = { path: idx, cost: 0, used: new Set(), range: { eq: [], eqIn: null, lo: null, hi: null }, nEq: 0, hasIn: false, point: false };
          ordered = true;
          reverse = hint.desc;
        }
      }
    }

    let plan: PlanNode;
    if (best) {
      const condText = conj.filter((e) => best!.used.has(e)).map(exprToSql).join(' AND ');
      plan = new IndexScan(scope.cols, t, alias, best.path, best.range, condText, this.ctx, reverse);
    } else {
      plan = new SeqScan(scope.cols, t, alias, this.ctx, reverse);
    }
    const rest = conj.filter((e) => !best?.used.has(e));
    if (rest.length > 0) plan = new Filter(plan, this.compileAll(rest, scope, 'WHERE')!, exprToSql(joinAnd(rest)!));
    return { plan, ordered, point: best?.point ?? false };
  }

  /** Plan producing full rows (including rowid) of `t` matching `where`; used by UPDATE and DELETE. */
  planTableRows(t: TableInfo, where: Expr | null): { plan: PlanNode; scope: Scope } {
    const alias = t.name.toLowerCase();
    const scope = this.newScope(tableSchema(t, alias), null);
    const conj = splitAnd(where);
    for (const e of conj) if (containsAggregate(e)) throw semanticError('aggregate functions are not allowed in WHERE');
    return { plan: this.accessPath(t, alias, scope, conj, null).plan, scope };
  }
}
