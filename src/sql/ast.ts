import type { ColumnType, Value } from '../types.ts';

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '||' | '=' | '<>' | '<' | '<=' | '>' | '>=' | 'AND' | 'OR';

export type Expr =
  | { kind: 'literal'; value: Value }
  | { kind: 'param'; index: number }
  | { kind: 'column'; table: string | null; name: string }
  | { kind: 'unary'; op: 'NOT' | '-'; expr: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'isNull'; expr: Expr; not: boolean }
  | { kind: 'between'; expr: Expr; low: Expr; high: Expr; not: boolean }
  | { kind: 'inList'; expr: Expr; list: Expr[]; not: boolean }
  | { kind: 'inSelect'; expr: Expr; select: SelectStmt; not: boolean }
  | { kind: 'exists'; select: SelectStmt; not: boolean }
  | { kind: 'subquery'; select: SelectStmt }
  | { kind: 'like'; expr: Expr; pattern: Expr; not: boolean; insensitive: boolean }
  | { kind: 'case'; operand: Expr | null; whens: { when: Expr; then: Expr }[]; else: Expr | null }
  | { kind: 'call'; name: string; args: Expr[]; distinct: boolean; star: boolean }
  | { kind: 'cast'; expr: Expr; type: ColumnType };

export type SelectItem = { kind: 'expr'; expr: Expr; alias: string | null } | { kind: 'star'; table: string | null };

export interface OrderItem {
  expr: Expr;
  desc: boolean;
}

export type FromItem =
  | { kind: 'table'; name: string; alias: string | null }
  | { kind: 'subquery'; select: SelectStmt; alias: string }
  | { kind: 'join'; type: 'INNER' | 'LEFT' | 'CROSS'; left: FromItem; right: FromItem; on: Expr | null; using: string[] | null };

export type SetOp = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT';

export interface SelectCore {
  distinct: boolean;
  columns: SelectItem[];
  from: FromItem | null;
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
}

export interface SelectStmt {
  kind: 'select';
  core: SelectCore;
  /** Further cores combined with set operators, left to right. */
  compound: { op: SetOp; core: SelectCore }[];
  orderBy: OrderItem[];
  limit: Expr | null;
  offset: Expr | null;
}

export interface ColumnDef {
  name: string;
  type: ColumnType;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  default: Expr | null;
}

export type Statement =
  | SelectStmt
  | {
      kind: 'createTable';
      name: string;
      ifNotExists: boolean;
      columns: ColumnDef[];
      primaryKey: string[] | null;
      uniques: string[][];
    }
  | { kind: 'dropTable'; name: string; ifExists: boolean }
  | { kind: 'createIndex'; name: string; table: string; columns: string[]; unique: boolean; ifNotExists: boolean }
  | { kind: 'dropIndex'; name: string; ifExists: boolean }
  | {
      kind: 'insert';
      table: string;
      columns: string[] | null;
      source: { kind: 'values'; rows: Expr[][] } | { kind: 'select'; select: SelectStmt };
    }
  | { kind: 'update'; table: string; sets: { column: string; expr: Expr }[]; where: Expr | null }
  | { kind: 'delete'; table: string; where: Expr | null }
  | { kind: 'begin' }
  | { kind: 'commit' }
  | { kind: 'rollback' }
  | { kind: 'explain'; analyze: boolean; stmt: Statement };
