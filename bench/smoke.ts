import { Database } from '../src/index.ts';

const db = Database.memory();
const show = (sql: string) => {
  try {
    for (const r of db.exec(sql)) {
      if (r.command === 'SELECT' || r.command === 'EXPLAIN') {
        console.log(r.columns.join(' | '));
        for (const row of r.rows) console.log(row.join(' | '));
      } else console.log(r.command, r.changes);
    }
  } catch (e) {
    console.log('ERR', (e as Error).message);
  }
  console.log('---');
};

show(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, age INTEGER);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, status TEXT);
CREATE INDEX orders_user ON orders (user_id);`);
show(`INSERT INTO users (name, email, age) VALUES ('ada', 'ada@x.io', 36), ('alan', 'alan@x.io', 41), ('grace', 'grace@x.io', 85), ('linus', NULL, 28)`);
show(`INSERT INTO orders (user_id, amount, status) VALUES (1, 10.5, 'paid'), (1, 20, 'paid'), (2, 5, 'refunded'), (3, 100, 'paid'), (3, 1, 'paid')`);
show(`SELECT u.name, count(o.id) AS n, sum(o.amount) AS total FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.name ORDER BY total DESC`);
show(`EXPLAIN SELECT u.name, count(o.id) AS n, sum(o.amount) AS total FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.name ORDER BY total DESC`);
show(`SELECT name FROM users WHERE id IN (SELECT user_id FROM orders WHERE amount > 15) ORDER BY 1`);
show(`SELECT name, (SELECT max(amount) FROM orders o WHERE o.user_id = u.id) AS biggest FROM users u ORDER BY id DESC LIMIT 3`);
show(`EXPLAIN SELECT * FROM users WHERE id = 2`);
show(`EXPLAIN ANALYZE SELECT * FROM users WHERE id BETWEEN 2 AND 3 ORDER BY id DESC`);
show(`UPDATE users SET age = age + 1 WHERE name LIKE 'a%'`);
show(`SELECT * FROM users`);
show(`DELETE FROM orders WHERE status = 'refunded'`);
show(`SELECT status, count(*) FROM orders GROUP BY status HAVING count(*) > 1`);
show(`INSERT INTO users (name, email) VALUES ('dup', 'ada@x.io')`);
show(`SELECT nme FROM users`);
show(`SELEC * FROM users`);
console.log(db.stats());
