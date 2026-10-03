#!/usr/bin/env node
// Multi-seat requests in different orders: all-or-nothing, no seat sold twice, no deadlocks or 5xx.
// usage: node scripts/multi.mjs [BASE_URL] [--people 40]
import { cli, createClient } from './lib/client.mjs';

const { positional, flag } = cli(process.argv.slice(2));
const PEOPLE = flag('people', 40);
const { base, call, tokenFor } = createClient(positional[0] ?? process.env.BASE_URL ?? 'http://localhost:3000', {
  maxSockets: PEOPLE,
});
const runId = Date.now().toString(36);

console.log(`Multi-seat test against ${base.origin}: ${PEOPLE} people per part\n`);

const admin = await tokenFor('multi-admin', process.env.ADMIN_KEY ?? 'demo-admin-key');
const createShow = async (name, seats) => {
  const r = await call('POST', '/shows', { token: admin, body: { name: `${name}-${runId}`, seats, price_paise: 100 } });
  if (r.status !== 201) {
    console.error('Could not create a show:', r.status, r.body);
    process.exit(2);
  }
  return r.body.show_id;
};
const confirmedSeats = async (showId) => {
  const r = await call('GET', `/shows/${showId}`);
  return Object.entries(r.body.seats).filter(([, status]) => status === 'confirmed').map(([seat]) => seat);
};

let failures = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}\n      ${detail}`);
  if (!ok) failures++;
};

const people = await Promise.all(Array.from({ length: PEOPLE }, (_, i) => tokenFor(`multi-${runId}-${i}`)));
const book = (showId, token, seats, i) =>
  call('POST', `/shows/${showId}/reserve`, { token, body: { seats }, headers: { 'idempotency-key': `${runId}-${showId}-${i}` } });

// 1. everyone wants the same four seats; half list them in reverse order
{
  const showId = await createShow('same-four', ['A', 'B', 'C', 'D']);
  const results = await Promise.all(
    people.map((token, i) => book(showId, token, i % 2 ? ['A', 'B', 'C', 'D'] : ['D', 'C', 'B', 'A'], i)),
  );
  const winners = results.filter((r) => r.status === 201);
  const declined = results.filter((r) => r.status === 409 && r.body.error.code === 'seat_taken').length;
  const owned = await confirmedSeats(showId);
  report(
    'Part 1: the same four seats, asked for in opposite orders',
    winners.length === 1 && winners[0].body.seats.length === 4 && declined === PEOPLE - 1 && owned.length === 4,
    `${winners.length} winner with ${winners[0]?.body.seats.length ?? 0} seats, ${declined} declined seat_taken, ${owned.length} seats confirmed`,
  );
}

// 2. a ring of overlapping pairs: neighbours share a seat, so only some pairs can win
{
  const ring = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];
  const pairs = ring.map((seat, i) => [seat, ring[(i + 1) % ring.length]]);
  const showId = await createShow('ring', ring);
  const results = await Promise.all(
    people.map((token, i) => {
      const pair = pairs[i % pairs.length];
      return book(showId, token, i % 2 ? pair : [...pair].reverse(), i);
    }),
  );
  const winners = results.filter((r) => r.status === 201);
  const winningSeats = winners.flatMap((r) => r.body.seats);
  const noSeatTwice = new Set(winningSeats).size === winningSeats.length;
  const declined = results.filter((r) => r.status === 409 && r.body.error.code === 'seat_taken').length;
  const owned = await confirmedSeats(showId);
  report(
    'Part 2: a ring of overlapping pairs',
    noSeatTwice && owned.length === winningSeats.length && winners.length + declined === PEOPLE,
    `${winners.length} pairs won (${winningSeats.join(', ')}), ${declined} declined, ${owned.length} seats confirmed, no seat given twice: ${noSeatTwice}`,
  );
}

console.log(failures === 0 ? '\nPASS: all-or-nothing held, no seat was given twice, nothing failed.' : `\nFAIL: ${failures} part(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
