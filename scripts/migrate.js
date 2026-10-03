import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

try {
  await migrate();
} finally {
  await pool.end();
}
