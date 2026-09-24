import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, closePool } from '../src/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data-model', 'migrations');
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

try {
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    await pool.query(sql);
    console.log(`applied ${f}`);
  }
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('load_test_runs','load_test_results','search_logs')
      ORDER BY 1`,
  );
  console.log('additive tables present:', rows.map((r) => r.table_name).join(', '));
} finally {
  await closePool();
}
