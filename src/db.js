import pg from 'pg';
import config from './config.js';
import { HttpError } from './errors.js';
import logger from './logger.js';

// bigint comes back as a string by default; paise and counts fit in a JS number
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: config.poolSize,
  connectionTimeoutMillis: config.poolWaitMs,
});

// an idle client erroring (e.g. postgres restarted) would otherwise crash the process
pool.on('error', (err) => logger.error({ err }, 'idle db client error'));

export const isPoolTimeout = (err) => /timeout exceeded when trying to connect/i.test(err.message);

export const isConnectionError = (err) =>
  /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|08.*|57P.*)$/.test(err.code ?? '') ||
  /Connection terminated/i.test(err.message);

export const busyError = () => new HttpError(429, 'overloaded', 'The server is busy, please retry shortly');

// pool.query, except that running out of connections becomes a 429 rather than a 500
export async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    throw isPoolTimeout(err) ? busyError() : err;
  }
}

// for query modules that take a client: pass `db` outside a transaction, `tx` inside one
export const db = { query };

export async function transaction(fn) {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    throw isPoolTimeout(err) ? busyError() : err;
  }

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
