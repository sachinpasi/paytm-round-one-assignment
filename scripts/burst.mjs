#!/usr/bin/env node
// On-sale stampede: ~20k reserve requests against a fresh show (hot seats, retries, one user firing
// many requests at once, spoofed identities), then checks the invariants against the API and /metrics.
// usage: ./burst.sh <BASE_URL>
//        node scripts/burst.mjs <BASE_URL> [--hot 10] [--per-hot 500] [--wide 12000] [--concurrency 200]
//        (ADMIN_KEY if the server doesn't use the default)
import { cli, createClient } from './lib/client.mjs';

const { positional, flag } = cli(process.argv.slice(2));
const HOT = flag('hot', 10); //            seats that everyone fights over
const PER_HOT = flag('per-hot', 500); //   people fighting over each hot seat
const WIDE = flag('wide', 12000); //       requests spread over many ordinary seats
const CONCURRENCY = flag('concurrency', 200);
const WIDE_USERS = 3000;
const WARM_SEATS = 3000;
const LIMIT = 4;

const { base, call, tokenFor } = createClient(positional[0] ?? process.env.BASE_URL ?? 'http://localhost:3000', {
  maxSockets: CONCURRENCY,
});
const runId = Date.now().toString(36); // keeps idempotency keys new on every run
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const randomBelow = (n) => Math.floor(Math.random() * n);

// run tasks with at most `limit` in flight
async function runAll(tasks, limit) {
  let next = 0;
  await Promise.all(
    range(limit, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
}

// /metrics text -> { 'name{labels}': value }
async function scrape() {
  const text = (await fetchText('/metrics')) ?? '';
  const values = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_]+)(\{[^}]*\})?\s+(\S+)$/);
    if (m) values[m[1] + (m[2] ?? '')] = Number(m[3]);
  }
  return values;
}
async function fetchText(path) {
  try {
    return await (await fetch(base.origin + path)).text();
  } catch {
    return null;
  }
}

console.log(`Burst against ${base.origin}\n`);

// setup: one show, a token per user
const hotSeats = range(HOT, (i) => `HOT${i + 1}`);
const warmSeats = range(WARM_SEATS, (i) => `W${i + 1}`);
const limitSeats = range(50, (i) => `L${i + 1}`);
const scenarioSeats = ['X1', 'X2', 'X3', 'X4'];
const spoofSeats = range(6, (i) => `S${i + 1}`);
const allSeats = [...hotSeats, ...warmSeats, ...limitSeats, ...scenarioSeats, ...spoofSeats];

const admin = await tokenFor('burst-admin', process.env.ADMIN_KEY ?? 'demo-admin-key');
if (!admin) {
  console.error('Could not get an admin token. Is the server up, and is ADMIN_KEY right?');
  process.exit(2);
}
const created = await call('POST', '/shows', {
  token: admin,
  body: { name: `burst-${runId}`, seats: allSeats, price_paise: 25000, per_user_limit: LIMIT },
});
if (created.status !== 201) {
  console.error('Could not create the show:', created.status, created.body);
  process.exit(2);
}
const showId = created.body.show_id;
console.log(`Show ${showId}: ${allSeats.length} seats, at most ${LIMIT} per person`);

const hotUsers = hotSeats.flatMap((seat) => range(PER_HOT, (i) => `hot-${seat}-${i}`));
const wideUsers = range(WIDE_USERS, (i) => `wide-${i}`);
const limitUsers = range(5, (i) => `limit-${i}`);
const spoofUsers = range(20, (i) => `spoof-${i}`);
const tokens = new Map();
const everybody = [...hotUsers, ...wideUsers, ...limitUsers, ...spoofUsers, 'alice', 'bob', 'victim'];
await runAll(
  everybody.map((user) => async () => tokens.set(user, await tokenFor(user))),
  CONCURRENCY,
);

// requests
const log = []; // one record per booking request, in the order they finished

async function book(phase, user, seats, key, extraBody = {}) {
  const fullKey = `${runId}-${key}`;
  const started = performance.now();
  const r = await call('POST', `/shows/${showId}/reserve`, {
    token: tokens.get(user),
    body: { seats, ...extraBody },
    headers: { 'idempotency-key': fullKey },
  });
  const record = {
    phase,
    user,
    seats,
    key: fullKey,
    status: r.status,
    code: r.body?.error?.code,
    reservation: r.body?.reservation_id ? r.body : null,
    ms: performance.now() - started,
  };
  log.push(record);
  return record;
}
const cancel = (user, reservationId) => call('POST', `/reservations/${reservationId}/cancel`, { token: tokens.get(user) });

const metricsBefore = await scrape();
const startedAt = performance.now();

// phase 1: each hot seat gets PER_HOT users at once; 1 in 5 also sends a same-key retry
const hotTasks = hotSeats.flatMap((seat) =>
  range(PER_HOT, (i) => {
    const user = `hot-${seat}-${i}`;
    const tasks = [() => book('hot', user, [seat], `k-${user}`)];
    if (i % 5 === 0) tasks.push(() => book('hot-retry', user, [seat], `k-${user}`));
    return tasks;
  }).flat(),
);
console.log(`\nPhase 1: hot-seat storm, ${hotTasks.length} requests, up to ${CONCURRENCY} at once`);
await runAll(hotTasks, CONCURRENCY);

// phase 2: ordinary traffic (some retried), 5 users x 10 parallel requests, 20 spoofed user_ids, shuffled
const mixedTasks = [];
for (let i = 0; i < WIDE; i++) {
  const user = `wide-${randomBelow(WIDE_USERS)}`;
  const seats = [...new Set(range(1 + randomBelow(2), () => warmSeats[randomBelow(WARM_SEATS)]))];
  mixedTasks.push(() => book('wide', user, seats, `w-${i}`));
  if (i % 7 === 0) mixedTasks.push(() => book('wide-retry', user, seats, `w-${i}`));
}
limitUsers.forEach((user, p) =>
  range(10, (j) => mixedTasks.push(() => book('limit', user, [limitSeats[p * 10 + j]], `lim-${user}-${j}`))),
);
spoofUsers.forEach((user, i) =>
  mixedTasks.push(() => book('spoof', user, [spoofSeats[i % spoofSeats.length]], `sp-${user}`, { user_id: 'victim' })),
);
mixedTasks.sort(() => Math.random() - 0.5);
console.log(`Phase 2: ordinary traffic, limit hammering and spoofing, ${mixedTasks.length} requests`);
await runAll(mixedTasks, CONCURRENCY);
const stormSeconds = (performance.now() - startedAt) / 1000;
const stormRequests = log.length;

// phase 3: sequential scenarios
const scenario = {};
const a1 = await book('scenario', 'alice', ['X1'], 'a-1');
const a2 = await book('scenario', 'alice', ['X2'], 'a-1'); //     same key, different request
const a3 = await book('scenario', 'alice', ['X1'], 'a-1'); //     same key, same request
scenario.keyReuseRefused = a2.status === 409 && a2.code === 'idempotency_key_reuse';
scenario.retryReturnsOriginal = a3.status === 200 && a3.reservation?.reservation_id === a1.reservation?.reservation_id;
const firstId = a1.reservation.reservation_id;
scenario.strangerCannotCancel = (await cancel('bob', firstId)).status === 403;
scenario.seatHeldUntilCancelled = (await book('scenario', 'bob', ['X1'], 'b-1')).code === 'seat_taken';
const cancelled = await cancel('alice', firstId);
scenario.ownerCanCancel = cancelled.status === 200 && cancelled.body?.status === 'cancelled';
scenario.freedSeatCanBeRebooked = (await book('scenario', 'bob', ['X1'], 'b-2')).status === 201;
scenario.oldCancelHarmless = (await cancel('alice', firstId)).status === 200;
const effectiveCancels = 1;
const mp1 = await book('scenario', 'alice', ['X3', 'X4'], 'a-multi');
const mp2 = await book('scenario', 'bob', ['X4', 'X3'], 'b-multi');
scenario.multiSeatAllOrNothing = mp1.status === 201 && mp2.status === 409;

// results
const outcomeOf = (r) => {
  if (r.status === 201) return 'confirmed';
  if (r.status === 200) return 'idempotent_replay';
  if (r.status === 0 || r.status >= 500) return '5xx';
  return r.code ?? `http_${r.status}`;
};
const counts = {};
for (const r of log) counts[outcomeOf(r)] = (counts[outcomeOf(r)] ?? 0) + 1;
const n = (value) => String(value ?? 0).padStart(7);

console.log(`\nOUTCOMES: ${log.length} requests`);
console.log(`${n(counts.confirmed)}  confirmed (201 Created)`);
console.log('         declined, by reason:');
for (const [reason, count] of Object.entries(counts).filter(([k]) => k !== 'confirmed' && k !== '5xx').sort((a, b) => b[1] - a[1])) {
  console.log(`${n(count)}    ${reason}`);
}
console.log(`${n(counts['5xx'])}  5xx or failed requests`);
if (counts.overloaded) console.log(`\nNOTE: ${counts.overloaded} requests were turned away with 429 because the server was overloaded.\n      That is allowed (they can retry); the safety checks below still apply.`);

const times = log.map((r) => r.ms).sort((a, b) => a - b);
const at = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
console.log(
  `\nSpeed: ${Math.round(stormRequests / stormSeconds)} requests/second over ${stormSeconds.toFixed(1)} s. ` +
    `Latency ms: p50 ${at(0.5)}, p95 ${at(0.95)}, p99 ${at(0.99)}, max ${Math.round(times.at(-1))}`,
);

// checks
console.log('\nCHECKS');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const created201 = log.filter((r) => r.status === 201);
const byUserKey = new Map(created201.map((r) => [`${r.user}|${r.key}`, r]));

// nothing sold twice
const owners = new Map();
for (const r of created201) for (const seat of r.reservation.seats) owners.set(seat, (owners.get(seat) ?? new Set()).add(r.reservation.reservation_id));
const soldTwice = [...owners].filter(([seat, ids]) => ids.size > 1 && seat !== 'X1'); // X1 is cancelled and re-sold on purpose
check('no seat was confirmed to two reservations', soldTwice.length === 0, `${soldTwice.length} seats sold twice`);
const hotLog = log.filter((r) => r.phase.startsWith('hot'));
const shed = counts.overloaded ?? 0; // requests the server turned away with 429 because it was overloaded
const winnersPerHotSeat = hotSeats.map((seat) => hotLog.filter((r) => r.seats[0] === seat && r.status === 201).length);
check(
  shed ? `each hot seat has at most one 201 (${shed} requests were shed, so one may be unsold)` : `each of the ${HOT} hot seats has exactly one 201`,
  winnersPerHotSeat.every((w) => (shed ? w <= 1 : w === 1)),
  winnersPerHotSeat.join(','),
);
check(
  'every other hot-seat request got 409 seat_taken, or a replay of the winner' + (shed ? ', or 429 busy' : ''),
  hotLog.every(
    (r) =>
      r.status === 201 ||
      (r.status === 409 && r.code === 'seat_taken') ||
      (r.status === 429 && r.code === 'overloaded') ||
      (r.status === 200 && byUserKey.get(`${r.user}|${r.key}`)?.reservation.reservation_id === r.reservation?.reservation_id),
  ),
);

// no server errors
const broken = log.filter((r) => r.status === 0 || r.status >= 500);
check('zero 5xx and zero failed requests', broken.length === 0, `${broken.length} bad`);

// idempotency
const replays = log.filter((r) => r.status === 200);
check(
  'every retry returned the original reservation, never a second one',
  replays.every((r) => byUserKey.get(`${r.user}|${r.key}`)?.reservation.reservation_id === r.reservation?.reservation_id),
  `${replays.length} retries`,
);
check('same key with a different request is refused (409)', scenario.keyReuseRefused);
check('a retry of a finished booking returns the original (200)', scenario.retryReturnsOriginal);

// per-user limit
const seatsPerUser = new Map();
for (const r of created201) seatsPerUser.set(r.user, (seatsPerUser.get(r.user) ?? 0) + r.reservation.seats.length);
const mostHeld = Math.max(...[...seatsPerUser].filter(([user]) => user !== 'alice' && user !== 'bob').map(([, seats]) => seats));
check(`nobody holds more than ${LIMIT} seats`, mostHeld <= LIMIT, `most held by one person: ${mostHeld}`);
check(
  `5 people firing 10 requests at once each end with ${shed ? 'at most' : 'exactly'} ${LIMIT}`,
  limitUsers.every((user) => {
    const held = log.filter((r) => r.user === user && r.status === 201).length;
    return shed ? held <= LIMIT : held === LIMIT;
  }),
);

// identity comes from the token
const spoofed = log.filter((r) => r.phase === 'spoof' && r.reservation);
check('a spoofed user_id in the body is ignored', spoofed.length > 0 && spoofed.every((r) => r.reservation.user_id === r.user), `${spoofed.length} bookings checked`);
check('only the owner can cancel', scenario.strangerCannotCancel && scenario.ownerCanCancel && scenario.oldCancelHarmless);
check('a cancelled seat can be re-booked, and the old cancel cannot touch it', scenario.seatHeldUntilCancelled && scenario.freedSeatCanBeRebooked);
check('a multi-seat request is all-or-nothing', scenario.multiSeatAllOrNothing);

// reconcile against the show itself
const shown = (await call('GET', `/shows/${showId}`)).body;
const c = shown.counts;
check('available + held + confirmed == total_seats', c.available + c.held + c.confirmed === shown.total_seats, `${c.available} + ${c.held} + ${c.confirmed} = ${shown.total_seats}`);
const expectedConfirmed = new Set(created201.flatMap((r) => r.reservation.seats));
const actualConfirmed = new Set(Object.entries(shown.seats).filter(([, status]) => status === 'confirmed').map(([seat]) => seat));
check(
  'the show shows exactly the seats the clients were told they got',
  expectedConfirmed.size === actualConfirmed.size && [...expectedConfirmed].every((seat) => actualConfirmed.has(seat)),
  `${actualConfirmed.size} seats`,
);

// reconcile against /metrics (assumes nobody else is hitting the server meanwhile)
const metricsAfter = await scrape();
const delta = (name) => (metricsAfter[name] ?? 0) - (metricsBefore[name] ?? 0);
const reasons = ['seat_taken', 'per_user_limit', 'idempotent_replay', 'idempotency_key_reuse', 'seat_not_found', 'show_not_found', 'overloaded'];
const observed = (reason) => log.filter((r) => outcomeOf(r) === reason).length;
check('metrics: reservations_confirmed_total went up by the number of 201s', delta('reservations_confirmed_total') === counts.confirmed, `${delta('reservations_confirmed_total')} vs ${counts.confirmed}`);
check(
  'metrics: reservations_declined_total{reason} went up by the declines we saw, reason by reason',
  reasons.every((reason) => delta(`reservations_declined_total{reason="${reason}"}`) === observed(reason)),
  reasons.map((reason) => `${reason}=${delta(`reservations_declined_total{reason="${reason}"}`)}`).join(' '),
);
check('metrics: reservations_cancelled_total went up by the cancels that did work', delta('reservations_cancelled_total') === effectiveCancels);
const gauge = (status) => metricsAfter[`seats_${status}{show_id="${showId}"}`];
check('metrics: the seats_available / seats_confirmed gauges match the API', gauge('available') === c.available && gauge('confirmed') === c.confirmed, `gauge ${gauge('available')}/${gauge('confirmed')}, API ${c.available}/${c.confirmed}`);

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
