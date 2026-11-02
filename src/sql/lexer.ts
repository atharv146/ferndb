import { syntaxError } from '../types.ts';

export type TokenType = 'keyword' | 'ident' | 'number' | 'string' | 'op' | 'param' | 'eof';

export interface Token {
  type: TokenType;
  /** Upper-cased for keywords, unquoted for identifiers and strings. */
  value: string;
  pos: number;
}

export const KEYWORDS = new Set([
  'ALL', 'AND', 'ANALYZE', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASE', 'CAST', 'COMMIT', 'CREATE', 'CROSS',
  'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXCEPT', 'EXISTS', 'EXPLAIN', 'FALSE', 'FROM',
  'GROUP', 'HAVING', 'IF', 'ILIKE', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTERSECT', 'INTO', 'IS', 'JOIN', 'KEY',
  'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'ROLLBACK', 'SELECT',
  'SET', 'TABLE', 'THEN', 'TRANSACTION', 'TRUE', 'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'WHEN', 'WHERE',
]);

const OPERATORS = ['<>', '!=', '<=', '>=', '||', '=', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '.', ';'];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/** Formats "line L, column C" plus the offending line with a caret under the position. */
export function describePosition(sql: string, pos: number): string {
  const before = sql.slice(0, pos);
  const line = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = sql.indexOf('\n', pos);
  const text = sql.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const col = pos - lineStart + 1;
  return `line ${line}, column ${col}\n  ${text}\n  ${' '.repeat(col - 1)}^`;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let params = 0;
  const fail = (msg: string, at: number) => syntaxError(`${msg} at ${describePosition(sql, at)}`);

  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw fail('unterminated comment', i);
      i = end + 2;
      continue;
    }
    const start = i;
    if (isIdentStart(c)) {
      while (i < sql.length && isIdentPart(sql[i]!)) i++;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();
      tokens.push(KEYWORDS.has(upper) ? { type: 'keyword', value: upper, pos: start } : { type: 'ident', value: word, pos: start });
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      while (i < sql.length && isDigit(sql[i]!)) i++;
      if (sql[i] === '.') {
        i++;
        while (i < sql.length && isDigit(sql[i]!)) i++;
      }
      if (sql[i] === 'e' || sql[i] === 'E') {
        let j = i + 1;
        if (sql[j] === '+' || sql[j] === '-') j++;
        if (isDigit(sql[j] ?? '')) {
          i = j;
          while (i < sql.length && isDigit(sql[i]!)) i++;
        }
      }
      if (i < sql.length && isIdentStart(sql[i]!)) throw fail('malformed number', start);
      tokens.push({ type: 'number', value: sql.slice(start, i), pos: start });
      continue;
    }
    if (c === "'" || c === '"') {
      let out = '';
      i++;
      for (;;) {
        if (i >= sql.length) throw fail(c === "'" ? 'unterminated string' : 'unterminated quoted identifier', start);
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            out += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += sql[i++];
      }
      tokens.push({ type: c === "'" ? 'string' : 'ident', value: out, pos: start });
      continue;
    }
    if (c === '?') {
      tokens.push({ type: 'param', value: String(params++), pos: start });
      i++;
      continue;
    }
    const op = OPERATORS.find((o) => sql.startsWith(o, i));
    if (!op) throw fail(`unexpected character '${c}'`, i);
    tokens.push({ type: 'op', value: op === '!=' ? '<>' : op, pos: start });
    i += op.length;
  }
  tokens.push({ type: 'eof', value: '', pos: sql.length });
  return tokens;
}
