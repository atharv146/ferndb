/**
 * Hand-written recursive-descent parser. Expressions use precedence climbing:
 *
 *   OR < AND < NOT < comparison / IS / IN / BETWEEN / LIKE < || < + - < * / % < unary - < primary
 */
import type { ColumnType } from '../types.ts';
import { syntaxError } from '../types.ts';
import type { BinaryOp, ColumnDef, Expr, FromItem, OrderItem, SelectCore, SelectItem, SelectStmt, SetOp, Statement } from './ast.ts';
import { describePosition, tokenize, type Token } from './lexer.ts';

const TYPE_NAMES: Record<string, ColumnType> = {
  INTEGER: 'INTEGER', INT: 'INTEGER', BIGINT: 'INTEGER', SMALLINT: 'INTEGER',
  REAL: 'REAL', FLOAT: 'REAL', DOUBLE: 'REAL', NUMERIC: 'REAL', DECIMAL: 'REAL',
  TEXT: 'TEXT', VARCHAR: 'TEXT', CHAR: 'TEXT', STRING: 'TEXT',
  BOOLEAN: 'BOOLEAN', BOOL: 'BOOLEAN',
};

const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);

export class Parser {
  private readonly sql: string;
  private readonly tokens: Token[];
  private pos = 0;

  constructor(sql: string) {
    this.sql = sql;
    this.tokens = tokenize(sql);
  }

  // ------------------------------------------------------------ token utils

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  private isKw(kw: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'keyword' && t.value === kw;
  }

  private isOp(op: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'op' && t.value === op;
  }

  private acceptKw(...kws: string[]): boolean {
    if (!kws.every((kw, i) => this.isKw(kw, i))) return false;
    this.pos += kws.length;
    return true;
  }

  private acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos++;
    return true;
  }

  private describe(t: Token): string {
    if (t.type === 'eof') return 'end of input';
    if (t.type === 'string') return `'${t.value}'`;
    return `'${t.value}'`;
  }

  private error(expected: string, t: Token = this.peek()): Error {
    return syntaxError(`expected ${expected} but found ${this.describe(t)} at ${describePosition(this.sql, t.pos)}`);
  }

  private expectKw(kw: string): void {
    if (!this.acceptKw(kw)) throw this.error(kw);
  }

  private expectOp(op: string): void {
    if (!this.acceptOp(op)) throw this.error(`'${op}'`);
  }

  private ident(what = 'identifier'): string {
    const t = this.peek();
    if (t.type !== 'ident') throw this.error(what);
    this.pos++;
    return t.value;
  }

  // ------------------------------------------------------------- statements

  parseScript(): Statement[] {
    const out: Statement[] = [];
    for (;;) {
      while (this.acceptOp(';'));
      if (this.peek().type === 'eof') return out;
      out.push(this.statement());
      if (this.peek().type !== 'eof' && !this.isOp(';')) throw this.error("';' or end of input");
    }
  }

  private statement(): Statement {
    const t = this.peek();
    if (t.type !== 'keyword') throw this.error('a statement');
    switch (t.value) {
      case 'SELECT':
        return this.select();
      case 'INSERT':
        return this.insert();
      case 'UPDATE':
        return this.update();
      case 'DELETE':
        return this.delete();
      case 'CREATE':
        return this.create();
      case 'DROP':
        return this.drop();
      case 'BEGIN':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'begin' };
      case 'COMMIT':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'commit' };
      case 'END':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'commit' };
      case 'ROLLBACK':
        this.next();
        this.acceptKw('TRANSACTION');
        return { kind: 'rollback' };
      case 'EXPLAIN': {
        this.next();
        const analyze = this.acceptKw('ANALYZE');
        return { kind: 'explain', analyze, stmt: this.statement() };
      }
      default:
        throw this.error('a statement');
    }
  }

  private create(): Statement {
    this.expectKw('CREATE');
    if (this.acceptKw('TABLE')) return this.createTable();
    const unique = this.acceptKw('UNIQUE');
    if (this.acceptKw('INDEX')) {
      const ifNotExists = this.acceptKw('IF', 'NOT', 'EXISTS');
      const name = this.ident('index name');
      this.expectKw('ON');
      const table = this.ident('table name');
      return { kind: 'createIndex', name, table, columns: this.identList(), unique, ifNotExists };
    }
    throw this.error('TABLE or INDEX');
  }

  private identList(): string[] {
    this.expectOp('(');
    const out = [this.ident('column name')];
    while (this.acceptOp(',')) out.push(this.ident('column name'));
    this.expectOp(')');
    return out;
  }

  private columnType(): ColumnType {
    const t = this.peek();
    const type = t.type === 'ident' ? TYPE_NAMES[t.value.toUpperCase()] : undefined;
    if (!type) throw this.error('a column type (INTEGER, REAL, TEXT or BOOLEAN)');
    this.pos++;
    if (this.acceptOp('(')) {
      // VARCHAR(255), DECIMAL(10, 2): length/precision is accepted and ignored.
      do this.next();
      while (this.acceptOp(','));
      this.expectOp(')');
    }
    return type;
  }

  private createTable(): Statement {
    const ifNotExists = this.acceptKw('IF', 'NOT', 'EXISTS');
    const name = this.ident('table name');
    this.expectOp('(');
    const columns: ColumnDef[] = [];
    let primaryKey: string[] | null = null;
    const uniques: string[][] = [];
    do {
      if (this.acceptKw('PRIMARY', 'KEY')) {
        if (primaryKey) throw syntaxError('multiple primary keys');
        primaryKey = this.identList();
      } else if (this.acceptKw('UNIQUE')) {
        uniques.push(this.identList());
      } else {
        const col: ColumnDef = { name: this.ident('column name'), type: 'TEXT', notNull: false, primaryKey: false, unique: false, default: null };
        col.type = this.columnType();
        for (;;) {
          if (this.acceptKw('PRIMARY', 'KEY')) col.primaryKey = true;
          else if (this.acceptKw('NOT', 'NULL')) col.notNull = true;
          else if (this.acceptKw('NULL')) col.notNull = false;
          else if (this.acceptKw('UNIQUE')) col.unique = true;
          else if (this.acceptKw('DEFAULT')) col.default = this.unary();
          else break;
        }
        columns.push(col);
      }
    } while (this.acceptOp(','));
    this.expectOp(')');
    return { kind: 'createTable', name, ifNotExists, columns, primaryKey, uniques };
  }

  private drop(): Statement {
    this.expectKw('DROP');
    if (this.acceptKw('TABLE')) {
      const ifExists = this.acceptKw('IF', 'EXISTS');
      return { kind: 'dropTable', name: this.ident('table name'), ifExists };
    }
    if (this.acceptKw('INDEX')) {
      const ifExists = this.acceptKw('IF', 'EXISTS');
      return { kind: 'dropIndex', name: this.ident('index name'), ifExists };
    }
    throw this.error('TABLE or INDEX');
  }

  private insert(): Statement {
    this.expectKw('INSERT');
    this.expectKw('INTO');
    const table = this.ident('table name');
    let columns: string[] | null = null;
    if (this.isOp('(')) columns = this.identList();
    if (this.acceptKw('VALUES')) {
      const rows: Expr[][] = [];
      do {
        this.expectOp('(');
        const row = [this.expr()];
        while (this.acceptOp(',')) row.push(this.expr());
        this.expectOp(')');
        rows.push(row);
      } while (this.acceptOp(','));
      return { kind: 'insert', table, columns, source: { kind: 'values', rows } };
    }
    if (this.isKw('SELECT')) return { kind: 'insert', table, columns, source: { kind: 'select', select: this.select() } };
    throw this.error('VALUES or SELECT');
  }

  private update(): Statement {
    this.expectKw('UPDATE');
    const table = this.ident('table name');
    this.expectKw('SET');
    const sets: { column: string; expr: Expr }[] = [];
    do {
      const column = this.ident('column name');
      this.expectOp('=');
      sets.push({ column, expr: this.expr() });
    } while (this.acceptOp(','));
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    return { kind: 'update', table, sets, where };
  }

  private delete(): Statement {
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const table = this.ident('table name');
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    return { kind: 'delete', table, where };
  }

  // ----------------------------------------------------------------- select

  select(): SelectStmt {
    const core = this.selectCore();
    const compound: { op: SetOp; core: SelectCore }[] = [];
    for (;;) {
      let op: SetOp | null = null;
      if (this.acceptKw('UNION')) op = this.acceptKw('ALL') ? 'UNION ALL' : 'UNION';
      else if (this.acceptKw('INTERSECT')) op = 'INTERSECT';
      else if (this.acceptKw('EXCEPT')) op = 'EXCEPT';
      if (!op) break;
      compound.push({ op, core: this.selectCore() });
    }
    const orderBy: OrderItem[] = [];
    if (this.acceptKw('ORDER', 'BY')) {
      do {
        const expr = this.expr();
        const desc = this.acceptKw('DESC');
        if (!desc) this.acceptKw('ASC');
        orderBy.push({ expr, desc });
      } while (this.acceptOp(','));
    }
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    if (this.acceptKw('LIMIT')) {
      limit = this.expr();
      if (this.acceptKw('OFFSET')) offset = this.expr();
      else if (this.acceptOp(',')) {
        // LIMIT offset, count (MySQL / SQLite form)
        offset = limit;
        limit = this.expr();
      }
    } else if (this.acceptKw('OFFSET')) offset = this.expr();
    return { kind: 'select', core, compound, orderBy, limit, offset };
  }

  private selectCore(): SelectCore {
    this.expectKw('SELECT');
    const distinct = this.acceptKw('DISTINCT');
    if (!distinct) this.acceptKw('ALL');
    const columns: SelectItem[] = [];
    do columns.push(this.selectItem());
    while (this.acceptOp(','));
    const from = this.acceptKw('FROM') ? this.fromClause() : null;
    const where = this.acceptKw('WHERE') ? this.expr() : null;
    const groupBy: Expr[] = [];
    if (this.acceptKw('GROUP', 'BY')) {
      do groupBy.push(this.expr());
      while (this.acceptOp(','));
    }
    const having = this.acceptKw('HAVING') ? this.expr() : null;
    return { distinct, columns, from, where, groupBy, having };
  }

  private selectItem(): SelectItem {
    if (this.acceptOp('*')) return { kind: 'star', table: null };
    if (this.peek().type === 'ident' && this.isOp('.', 1) && this.isOp('*', 2)) {
      const table = this.ident();
      this.pos += 2;
      return { kind: 'star', table };
    }
    const expr = this.expr();
    return { kind: 'expr', expr, alias: this.alias() };
  }

  private alias(): string | null {
    if (this.acceptKw('AS')) return this.ident('alias');
    if (this.peek().type === 'ident') return this.ident();
    return null;
  }

  private fromClause(): FromItem {
    let left = this.tableRef();
    for (;;) {
      if (this.acceptOp(',')) {
        left = { kind: 'join', type: 'CROSS', left, right: this.tableRef(), on: null, using: null };
        continue;
      }
      let type: 'INNER' | 'LEFT' | 'CROSS' | null = null;
      if (this.acceptKw('JOIN') || this.acceptKw('INNER', 'JOIN')) type = 'INNER';
      else if (this.acceptKw('LEFT', 'JOIN') || this.acceptKw('LEFT', 'OUTER', 'JOIN')) type = 'LEFT';
      else if (this.acceptKw('CROSS', 'JOIN')) type = 'CROSS';
      if (!type) return left;
      const right = this.tableRef();
      let on: Expr | null = null;
      let using: string[] | null = null;
      if (type !== 'CROSS') {
        if (this.acceptKw('ON')) on = this.expr();
        else if (this.acceptKw('USING')) using = this.identList();
        else throw this.error('ON or USING');
      }
      left = { kind: 'join', type, left, right, on, using };
    }
  }

  private tableRef(): FromItem {
    if (this.acceptOp('(')) {
      const select = this.select();
      this.expectOp(')');
      const alias = this.alias();
      if (!alias) throw this.error('an alias for the subquery');
      return { kind: 'subquery', select, alias };
    }
    const name = this.ident('table name');
    return { kind: 'table', name, alias: this.alias() };
  }

  // ------------------------------------------------------------ expressions

  expr(): Expr {
    return this.or();
  }

  private or(): Expr {
    let left = this.and();
    while (this.acceptKw('OR')) left = { kind: 'binary', op: 'OR', left, right: this.and() };
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.acceptKw('AND')) left = { kind: 'binary', op: 'AND', left, right: this.not() };
    return left;
  }

  private not(): Expr {
    if (this.acceptKw('NOT')) return { kind: 'unary', op: 'NOT', expr: this.not() };
    return this.comparison();
  }

  private comparison(): Expr {
    let left = this.concat();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && COMPARISONS.has(t.value)) {
        this.next();
        left = { kind: 'binary', op: t.value as BinaryOp, left, right: this.concat() };
        continue;
      }
      if (this.acceptKw('IS')) {
        const not = this.acceptKw('NOT');
        this.expectKw('NULL');
        left = { kind: 'isNull', expr: left, not };
        continue;
      }
      const not = this.isKw('NOT') && (this.isKw('IN', 1) || this.isKw('BETWEEN', 1) || this.isKw('LIKE', 1) || this.isKw('ILIKE', 1));
      if (not) this.next();
      if (this.acceptKw('IN')) {
        this.expectOp('(');
        if (this.isKw('SELECT')) {
          const select = this.select();
          this.expectOp(')');
          left = { kind: 'inSelect', expr: left, select, not };
        } else {
          const list = [this.expr()];
          while (this.acceptOp(',')) list.push(this.expr());
          this.expectOp(')');
          left = { kind: 'inList', expr: left, list, not };
        }
        continue;
      }
      if (this.acceptKw('BETWEEN')) {
        const low = this.concat();
        this.expectKw('AND');
        left = { kind: 'between', expr: left, low, high: this.concat(), not };
        continue;
      }
      if (this.isKw('LIKE') || this.isKw('ILIKE')) {
        const insensitive = this.next().value === 'ILIKE';
        left = { kind: 'like', expr: left, pattern: this.concat(), not, insensitive };
        continue;
      }
      if (not) throw this.error('IN, BETWEEN or LIKE');
      return left;
    }
  }

  private concat(): Expr {
    let left = this.additive();
    while (this.acceptOp('||')) left = { kind: 'binary', op: '||', left, right: this.additive() };
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    for (;;) {
      if (this.acceptOp('+')) left = { kind: 'binary', op: '+', left, right: this.multiplicative() };
      else if (this.acceptOp('-')) left = { kind: 'binary', op: '-', left, right: this.multiplicative() };
      else return left;
    }
  }

  private multiplicative(): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        left = { kind: 'binary', op: t.value, left, right: this.unary() };
      } else return left;
    }
  }

  private unary(): Expr {
    if (this.acceptOp('-')) {
      const inner = this.unary();
      if (inner.kind === 'literal' && typeof inner.value === 'number') return { kind: 'literal', value: -inner.value };
      return { kind: 'unary', op: '-', expr: inner };
    }
    if (this.acceptOp('+')) return this.unary();
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.type) {
      case 'number':
        this.next();
        return { kind: 'literal', value: Number(t.value) };
      case 'string':
        this.next();
        return { kind: 'literal', value: t.value };
      case 'param':
        this.next();
        return { kind: 'param', index: Number(t.value) };
      case 'op':
        if (t.value === '(') {
          this.next();
          if (this.isKw('SELECT')) {
            const select = this.select();
            this.expectOp(')');
            return { kind: 'subquery', select };
          }
          const e = this.expr();
          this.expectOp(')');
          return e;
        }
        break;
      case 'keyword':
        if (this.acceptKw('NULL')) return { kind: 'literal', value: null };
        if (this.acceptKw('TRUE')) return { kind: 'literal', value: true };
        if (this.acceptKw('FALSE')) return { kind: 'literal', value: false };
        if (this.isKw('CASE')) return this.caseExpr();
        if (this.acceptKw('CAST')) {
          this.expectOp('(');
          const expr = this.expr();
          this.expectKw('AS');
          const type = this.columnType();
          this.expectOp(')');
          return { kind: 'cast', expr, type };
        }
        if (this.isKw('EXISTS') || (this.isKw('NOT') && this.isKw('EXISTS', 1))) {
          const not = this.acceptKw('NOT');
          this.expectKw('EXISTS');
          this.expectOp('(');
          const select = this.select();
          this.expectOp(')');
          return { kind: 'exists', select, not };
        }
        break;
      case 'ident': {
        this.next();
        if (this.acceptOp('(')) return this.call(t.value);
        if (this.acceptOp('.')) return { kind: 'column', table: t.value, name: this.ident('column name') };
        return { kind: 'column', table: null, name: t.value };
      }
      default:
        break;
    }
    throw this.error('an expression');
  }

  private call(name: string): Expr {
    const upper = name.toUpperCase();
    if (this.acceptOp('*')) {
      this.expectOp(')');
      return { kind: 'call', name: upper, args: [], distinct: false, star: true };
    }
    const distinct = this.acceptKw('DISTINCT');
    const args: Expr[] = [];
    if (!this.isOp(')')) {
      do args.push(this.expr());
      while (this.acceptOp(','));
    }
    this.expectOp(')');
    return { kind: 'call', name: upper, args, distinct, star: false };
  }

  private caseExpr(): Expr {
    this.expectKw('CASE');
    const operand = this.isKw('WHEN') ? null : this.expr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.acceptKw('WHEN')) {
      const when = this.expr();
      this.expectKw('THEN');
      whens.push({ when, then: this.expr() });
    }
    if (whens.length === 0) throw this.error('WHEN');
    const elseExpr = this.acceptKw('ELSE') ? this.expr() : null;
    this.expectKw('END');
    return { kind: 'case', operand, whens, else: elseExpr };
  }
}

export function parse(sql: string): Statement[] {
  return new Parser(sql).parseScript();
}
