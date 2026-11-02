/** A single SQL value. INTEGER and REAL both map to JS numbers. */
export type Value = null | number | string | boolean;

export type ColumnType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN';

export const COLUMN_TYPES: readonly ColumnType[] = ['INTEGER', 'REAL', 'TEXT', 'BOOLEAN'];

export class DbError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}

export const syntaxError = (msg: string) => new DbError('SYNTAX', msg);
export const semanticError = (msg: string) => new DbError('SEMANTIC', msg);
export const constraintError = (msg: string) => new DbError('CONSTRAINT', msg);
export const typeError = (msg: string) => new DbError('TYPE', msg);

/**
 * Rank used to order values of different types: NULL < BOOLEAN < number < TEXT.
 * Must agree with the tag bytes in the key encoding (see keycodec.ts).
 */
function typeRank(v: Value): number {
  if (v === null) return 0;
  switch (typeof v) {
    case 'boolean': return 1;
    case 'number': return 2;
    default: return 3;
  }
}

/** Maps UTF-16 code units so that comparing them yields Unicode code point order. */
function fixCodeUnit(c: number): number {
  if (c >= 0xd800 && c <= 0xdfff) return c + 0x2000;
  if (c >= 0xe000) return c - 0x800;
  return c;
}

/** Compares strings by code point, matching the byte order of their UTF-8 encodings. */
export function compareStrings(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return fixCodeUnit(ca) - fixCodeUnit(cb);
  }
  return a.length - b.length;
}

/** Total order over values, used for sorting, DISTINCT and grouping. NULLs sort first. */
export function compareValues(a: Value, b: Value): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (a === null) return 0;
  if (typeof a === 'number') return a < (b as number) ? -1 : a > (b as number) ? 1 : 0;
  if (typeof a === 'string') return compareStrings(a, b as string);
  return (a ? 1 : 0) - ((b as boolean) ? 1 : 0);
}

export function typeOfValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
  if (typeof v === 'string') return 'TEXT';
  return 'BOOLEAN';
}

export function formatValue(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
