#!/usr/bin/env node
// The same request with the same idempotency key, sent many times concurrently (an over-eager
// client or proxy retrying). It must be booked exactly once.
// usage: node scripts/retry.mjs [BASE_URL] [--copies 20]
import { cli, createClient } from './lib/client.mjs';

const { positional, flag } = cli(process.argv.slice(2));
const COPIES = flag('copies', 20);
const { base, call, tokenFor } = createClient(positional[0] ?? process.env.BASE_URL ?? 'http://localhost:3000', {
  maxSockets: COPIES,
});
const runId = Date.now().toString(36);

console.log(`Retry test against ${base.origin}: ${COPIES} copies of each request\n`);

const admin = await tokenFor('retry-admin', process.env.ADMIN_KEY ?? 'demo-admin-key');
const created = await call('POST', '/shows', {
  token: admin,
  body: { name: `retry-${runId}`, seats: ['T1', 'T2', 'T3', 'T4'], price_paise: 25000 },
});
if (created.status !== 201) {
  console.error('Could not create a show:', created.status, created.body);
  process.exit(2);
}
const showId = created.body.show_id;
const alice = await tokenFor('retry-alice');
const bob = await tokenFor('retry-bob');

const reserve = (token, seats, key) =>
  call('POST', `/shows/${showId}/reserve`, { token, body: { seats }, headers: { 'idempotency-key': key } });
const count = (results, status) => results.filter((r) => r.status === status).length;

let failures = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}\n      ${detail}`);
  if (!ok) failures++;
};

// 1. identical requests
{
  const key = `${runId}-same`;
  const results = await Promise.all(Array.from({ length: COPIES }, () => reserve(alice, ['T1'], key)));
  const ids = new Set(results.filter((r) => r.status === 200 || r.status === 201).map((r) => r.body.reservation_id));
  report(
    `Part 1: the same request ${COPIES} times at once`,
    count(results, 201) === 1 && count(results, 200) === COPIES - 1 && ids.size === 1,
    `${count(results, 201)} got 201 Created, ${count(results, 200)} got 200 (replay), ${ids.size} distinct reservation id(s)`,
  );
}

// 2. one key, two different requests at once: only one of them can own the key
{
  const key = `${runId}-mixed`;
  const results = await Promise.all(
    Array.from({ length: COPIES }, (_, i) => reserve(bob, i % 2 ? ['T2'] : ['T3'], key)),
  );
  const created201 = results.filter((r) => r.status === 201);
  const reuse = results.filter((r) => r.status === 409 && r.body?.error?.code === 'idempotency_key_reuse');
  const replays = results.filter((r) => r.status === 200);
  const sameAsWinner = replays.every((r) => r.body.reservation_id === created201[0]?.body.reservation_id);
  const shown = await call('GET', `/shows/${showId}`);
  const booked = ['T2', 'T3'].filter((seat) => shown.body.seats[seat] === 'confirmed').length;
  report(
    `Part 2: one key, two different requests, ${COPIES} at once`,
    created201.length === 1 && sameAsWinner && created201.length + replays.length + reuse.length === COPIES && booked === 1,
    `${created201.length} got 201, ${replays.length} got 200 (same request), ${reuse.length} got 409 idempotency_key_reuse, ${booked} seat(s) booked`,
  );
}

// 3. keys are per user, so two users can use the same key text
{
  const key = `${runId}-shared-text`;
  const [a, b] = await Promise.all([reserve(alice, ['T4'], key), reserve(bob, ['T4'], key)]);
  const statuses = [a.status, b.status].sort();
  report(
    'Part 3: two people using the same key text',
    statuses[0] === 201 && statuses[1] === 409 && [a, b].some((r) => r.body?.error?.code === 'seat_taken'),
    `statuses ${statuses.join(' and ')}: one booked T4, the other was declined for the SEAT, not for the key`,
  );
}

console.log(failures === 0 ? '\nPASS: retries never booked anything twice.' : `\nFAIL: ${failures} part(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
