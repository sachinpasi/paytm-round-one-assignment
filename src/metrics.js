import client from 'prom-client';
import { pool } from './db.js';
import logger from './logger.js';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const counter = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [registry] });

export const confirmed = counter('reservations_confirmed_total', 'Reservations created');
export const declined = counter(
  'reservations_declined_total',
  'Reserve requests that did not create a reservation, by reason',
  ['reason'],
);
export const cancelled = counter('reservations_cancelled_total', 'Reservations cancelled');
export const httpRequests = counter('http_requests_total', 'HTTP requests', ['method', 'route', 'status']);

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

new client.Gauge({
  name: 'db_pool_in_use',
  help: 'DB connections checked out',
  registers: [registry],
  collect() {
    this.set(pool.totalCount - pool.idleCount);
  },
});

new client.Gauge({
  name: 'db_pool_waiting',
  help: 'Requests waiting for a DB connection',
  registers: [registry],
  collect() {
    this.set(pool.waitingCount);
  },
});

// Seat counts are read from the database on every scrape, so they can be checked against the
// counters above. Limited to the 20 newest shows to keep the number of series small.
const STATUSES = ['available', 'held', 'confirmed'];
const seatGauges = {};
for (const status of STATUSES) {
  seatGauges[status] = new client.Gauge({
    name: `seats_${status}`,
    help: `Seats ${status}, per show`,
    labelNames: ['show_id'],
    registers: [registry],
  });
}

async function refreshSeatGauges() {
  for (const gauge of Object.values(seatGauges)) gauge.reset();

  let rows;
  try {
    ({ rows } = await pool.query(`
      SELECT show_id, status, count(*) AS n
        FROM seats
       WHERE show_id IN (SELECT id FROM shows ORDER BY created_at DESC LIMIT 20)
       GROUP BY show_id, status`));
  } catch (err) {
    // keep serving the other metrics while the database is down
    logger.warn({ err: err.code ?? err.message }, 'could not read seat counts');
    return;
  }

  const byShow = {};
  for (const { show_id: showId, status, n } of rows) {
    byShow[showId] ??= {};
    byShow[showId][status] = n;
  }
  for (const [showId, counts] of Object.entries(byShow)) {
    for (const status of STATUSES) seatGauges[status].set({ show_id: showId }, counts[status] ?? 0);
  }
}

export async function metricsText() {
  await refreshSeatGauges();
  return registry.metrics();
}
