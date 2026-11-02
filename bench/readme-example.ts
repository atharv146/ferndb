// Reproduces the EXPLAIN ANALYZE example at the top of the README.
import { Database } from '../src/index.ts';
const db = Database.memory();
db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL);
CREATE INDEX customers_city ON customers (city);
CREATE INDEX orders_customer ON orders (customer_id);`);
let s = 7; const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
const cities = ['Fremont', 'Berkeley', 'Oakland', 'San Jose', 'Palo Alto', 'Hayward', 'Milpitas', 'Union City', 'Newark', 'Sunnyvale'];
db.transaction(() => {
  for (let i = 1; i <= 400; i++) db.query('INSERT INTO customers VALUES (?, ?, ?)', [i, `customer ${i}`, cities[Math.floor(r() * cities.length)]!]);
  for (let i = 1; i <= 4000; i++) db.query('INSERT INTO orders VALUES (?, ?, ?)', [i, 1 + Math.floor(r() * 400), Math.round(r() * 20000) / 100]);
});
console.log(db.query(`EXPLAIN ANALYZE SELECT c.name, count(*) AS orders, sum(o.total) AS spent FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.city = 'Fremont' GROUP BY c.name ORDER BY spent DESC LIMIT 5`).rows.map((x) => x[0]).join('\n'));
