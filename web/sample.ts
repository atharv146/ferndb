/** A deterministic sample university: departments, courses, students and enrollments. */
import type { Database } from '../src/index.ts';

const DEPARTMENTS: [string, string][] = [
  ['Computer Science', 'Soda Hall'],
  ['Mathematics', 'Evans Hall'],
  ['Physics', 'LeConte Hall'],
  ['Biology', 'Valley Life Sciences'],
  ['Economics', 'Evans Hall'],
  ['History', 'Dwinelle Hall'],
  ['Linguistics', 'Dwinelle Hall'],
  ['Statistics', 'Evans Hall'],
];

const COURSE_TOPICS: Record<string, string[]> = {
  'Computer Science': ['Structure and Interpretation of Programs', 'Data Structures', 'Machine Structures', 'Operating Systems', 'Database Systems', 'Compilers', 'Computer Networks', 'Artificial Intelligence', 'Computer Security', 'Algorithms', 'Distributed Systems', 'Computer Graphics', 'Programming Languages', 'Machine Learning', 'Computer Architecture'],
  Mathematics: ['Calculus I', 'Calculus II', 'Multivariable Calculus', 'Linear Algebra', 'Discrete Mathematics', 'Real Analysis', 'Abstract Algebra', 'Number Theory', 'Topology', 'Complex Analysis', 'Combinatorics', 'Numerical Analysis', 'Probability', 'Differential Equations'],
  Physics: ['Mechanics', 'Electricity and Magnetism', 'Waves and Optics', 'Quantum Mechanics', 'Thermodynamics', 'Statistical Mechanics', 'Astrophysics', 'Condensed Matter', 'Particle Physics', 'Relativity', 'Lab Methods', 'Computational Physics'],
  Biology: ['Cell Biology', 'Genetics', 'Ecology', 'Evolution', 'Neuroscience', 'Microbiology', 'Biochemistry', 'Immunology', 'Plant Biology', 'Marine Biology', 'Developmental Biology', 'Bioinformatics'],
  Economics: ['Microeconomics', 'Macroeconomics', 'Econometrics', 'Game Theory', 'Behavioral Economics', 'Labor Economics', 'Public Finance', 'International Trade', 'Development Economics', 'Financial Economics', 'Economic History'],
  History: ['World History', 'American History', 'Ancient Rome', 'Medieval Europe', 'History of Science', 'Modern China', 'The Cold War', 'Latin America', 'History of California', 'Empires and Colonies'],
  Linguistics: ['Introduction to Linguistics', 'Phonetics', 'Phonology', 'Syntax', 'Semantics', 'Sociolinguistics', 'Historical Linguistics', 'Computational Linguistics', 'Language Acquisition'],
  Statistics: ['Foundations of Data Science', 'Probability for Data Science', 'Statistical Inference', 'Linear Models', 'Bayesian Statistics', 'Time Series', 'Causal Inference', 'Sampling Methods', 'Statistical Learning', 'Experimental Design'],
};

const FIRST = ['Aanya', 'Ben', 'Carmen', 'Dev', 'Elena', 'Farah', 'Gabriel', 'Hana', 'Isaac', 'Jaya', 'Kenji', 'Lucia', 'Mateo', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rohan', 'Sofia', 'Tariq', 'Uma', 'Victor', 'Wen', 'Ximena', 'Yusuf', 'Zoe', 'Arjun', 'Bea', 'Chen', 'Diego', 'Esha', 'Felix', 'Grace', 'Hiro', 'Ines', 'Jonah', 'Kavya', 'Liam', 'Maya', 'Noah', 'Olivia', 'Pedro', 'Rania', 'Sam', 'Tara', 'Vikram', 'Yara', 'Zain'];
const LAST = ['Patel', 'Nguyen', 'Garcia', 'Kim', 'Okafor', 'Rossi', 'Chen', 'Singh', 'Haddad', 'Silva', 'Novak', 'Tanaka', 'Mehta', 'Lopez', 'Ibrahim', 'Cohen', 'Park', 'Fischer', 'Reddy', 'Ahmed', 'Kowalski', 'Moreno', 'Shah', 'Ali', 'Wong', 'Iyer', 'Dubois', 'Costa', 'Yilmaz', 'Hughes'];
const TERMS = ['2024 Fall', '2025 Spring', '2025 Fall', '2026 Spring'];
const GRADES = ['A', 'A', 'A-', 'A-', 'B+', 'B+', 'B', 'B', 'B-', 'C+', 'C', 'D', 'F'];
const GRADE_POINTS: Record<string, number> = { A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7, 'C+': 2.3, C: 2, D: 1, F: 0 };

export const SCHEMA = `
CREATE TABLE departments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  building TEXT
);
CREATE TABLE courses (
  id INTEGER PRIMARY KEY,
  dept_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  units INTEGER
);
CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  major_id INTEGER,
  year INTEGER,
  gpa REAL
);
CREATE TABLE enrollments (
  student_id INTEGER,
  course_id INTEGER,
  term TEXT,
  grade TEXT,
  PRIMARY KEY (student_id, course_id, term)
);
CREATE INDEX enrollments_course ON enrollments (course_id);
CREATE INDEX students_major ON students (major_id);
`;

export function loadSample(db: Database, students = 2400): void {
  let s = 20261101;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

  db.exec(SCHEMA);
  db.transaction(() => {
    DEPARTMENTS.forEach(([name, building], i) => db.query('INSERT INTO departments VALUES (?, ?, ?)', [i + 1, name, building]));
    let courseId = 0;
    const deptCourses: number[][] = DEPARTMENTS.map(() => []);
    DEPARTMENTS.forEach(([name], d) => {
      const prefix = name.split(' ').map((w) => w[0]).join('').toUpperCase().padEnd(2, name[1]!.toUpperCase());
      COURSE_TOPICS[name]!.forEach((title, i) => {
        courseId++;
        deptCourses[d]!.push(courseId);
        db.query('INSERT INTO courses VALUES (?, ?, ?, ?, ?)', [courseId, d + 1, `${prefix} ${i < 4 ? i + 1 : 100 + i * 7}`, title, i % 3 === 0 ? 3 : 4]);
      });
    });
    const allCourses = Array.from({ length: courseId }, (_, i) => i + 1);

    for (let id = 1; id <= students; id++) {
      const major = rand() < 0.08 ? null : Math.floor(rand() * DEPARTMENTS.length) + 1;
      const year = 1 + Math.floor(rand() * 4);
      const taken = new Set<string>();
      const points: number[] = [];
      const n = 3 + Math.floor(rand() * 6);
      for (let k = 0; k < n; k++) {
        const course = major !== null && rand() < 0.6 ? pick(deptCourses[major - 1]!) : pick(allCourses);
        const term = TERMS[Math.floor(rand() * Math.min(TERMS.length, year + 1))]!;
        const key = `${course}|${term}`;
        if (taken.has(key)) continue;
        taken.add(key);
        const inProgress = term === '2026 Spring' && rand() < 0.7;
        const grade = inProgress ? null : pick(GRADES);
        if (grade) points.push(GRADE_POINTS[grade]!);
        db.query('INSERT INTO enrollments VALUES (?, ?, ?, ?)', [id, course, term, grade]);
      }
      const gpa = points.length ? Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 100) / 100 : null;
      db.query('INSERT INTO students VALUES (?, ?, ?, ?, ?)', [id, `${pick(FIRST)} ${pick(LAST)}`, major, year, gpa]);
    }
  });
  db.checkpoint();
}

export interface Example {
  label: string;
  sql: string;
}

export const EXAMPLES: Example[] = [
  {
    label: 'Most popular courses',
    sql: `-- Join three tables, group, sort, and keep the top 10.
SELECT c.code, c.title, d.name AS department, count(*) AS students
FROM enrollments e
JOIN courses c ON c.id = e.course_id
JOIN departments d ON d.id = c.dept_id
GROUP BY c.code, c.title, d.name
ORDER BY students DESC
LIMIT 10;`,
  },
  {
    label: 'Index vs full scan',
    sql: `-- course_id has an index; grade does not.
-- Open "Query plan" to compare the two plans and their timings.
EXPLAIN ANALYZE SELECT count(*) FROM enrollments WHERE course_id = 42;
EXPLAIN ANALYZE SELECT count(*) FROM enrollments WHERE grade = 'F';`,
  },
  {
    label: 'Grade distribution',
    sql: `SELECT d.name AS department,
       count(*) AS graded,
       round(100.0 * sum(CASE WHEN e.grade IN ('A', 'A-') THEN 1 ELSE 0 END) / count(*), 1) AS pct_a,
       round(100.0 * sum(CASE WHEN e.grade IN ('D', 'F') THEN 1 ELSE 0 END) / count(*), 1) AS pct_d_or_f
FROM enrollments e
JOIN courses c ON c.id = e.course_id
JOIN departments d ON d.id = c.dept_id
WHERE e.grade IS NOT NULL
GROUP BY d.name
ORDER BY pct_a DESC;`,
  },
  {
    label: 'Correlated subquery',
    sql: `-- Seniors whose GPA beats their own department's average.
SELECT s.name, d.name AS major, s.gpa
FROM students s
JOIN departments d ON d.id = s.major_id
WHERE s.year = 4
  AND s.gpa > (SELECT avg(s2.gpa) FROM students s2 WHERE s2.major_id = s.major_id)
ORDER BY s.gpa DESC
LIMIT 15;`,
  },
  {
    label: 'Courses nobody took',
    sql: `-- LEFT JOIN keeps courses with no matching enrollments this term.
SELECT c.code, c.title
FROM courses c
LEFT JOIN enrollments e ON e.course_id = c.id AND e.term = '2026 Spring'
WHERE e.course_id IS NULL
ORDER BY c.code;`,
  },
  {
    label: 'Transactions',
    sql: `-- Everything between BEGIN and ROLLBACK is undone.
BEGIN;
DELETE FROM enrollments WHERE grade = 'F';
SELECT count(*) AS after_delete FROM enrollments;
ROLLBACK;
SELECT count(*) AS after_rollback FROM enrollments;`,
  },
  {
    label: 'Set operations',
    sql: `-- Students enrolled in both Database Systems and Operating Systems.
SELECT s.name FROM students s JOIN enrollments e ON e.student_id = s.id JOIN courses c ON c.id = e.course_id WHERE c.title = 'Database Systems'
INTERSECT
SELECT s.name FROM students s JOIN enrollments e ON e.student_id = s.id JOIN courses c ON c.id = e.course_id WHERE c.title = 'Operating Systems'
ORDER BY 1;`,
  },
  {
    label: 'Make your own table',
    sql: `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, pinned BOOLEAN DEFAULT false);
INSERT INTO notes (body) VALUES ('B+ trees split by bytes, not by key count'), ('The WAL makes commits atomic');
UPDATE notes SET pinned = true WHERE body LIKE '%WAL%';
SELECT * FROM notes;`,
  },
];
