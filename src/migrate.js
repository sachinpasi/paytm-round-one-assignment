import fs from 'node:fs/promises';
import { pool } from './db.js';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const LOCK_KEY = 727001; // arbitrary, just needs to be the same for every instance

export async function migrate({ log = console.log } = {}) {
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();

  try {
    // several instances can boot at the same time; only one of them should migrate
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const pending = files.filter((f) => !done.has(f));

    for (const file of pending) {
      const sql = await fs.readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      log(`applied: ${file}`);
    }

    if (pending.length === 0) log('nothing to apply, the database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
