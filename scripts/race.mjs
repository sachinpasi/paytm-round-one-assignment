#!/usr/bin/env node
// Many users go for the same seat at the same moment. Each seat must be sold exactly once.
// usage: node scripts/race.mjs [BASE_URL] [--people 100] [--rounds 5]   (ADMIN_KEY if not the default)
import { cli, createClient } from './lib/client.mjs';

const { positional, flag } = cli(process.argv.slice(2));
const PEOPLE = flag('people', 100);
const ROUNDS = flag('rounds', 5);
const { base, call, tokenFor } = createClient(positional[0] ?? process.env.BASE_URL ?? 'http://localhost:3000', {
  maxSockets: Math.min(PEOPLE, 100),
});
const runId = Date.now().toString(36); // makes every idempotency key new on each run

console.log(`Race test against ${base.origin}: ${PEOPLE} people per seat, ${ROUNDS} seats\n`);

// one seat per round, plus a warm-up seat
const admin = await tokenFor('race-admin', process.env.ADMIN_KEY ?? 'demo-admin-key');
const seats = Array.from({ length: ROUNDS }, (_, i) => `R${i + 1}`);
const created = await call('POST', '/shows', {
  token: admin,
  body: { name: `race-${runId}`, seats: ['WARMUP', ...seats], price_paise: 25000 },
});
if (created.status !== 201) {
  console.error('Could not create a show:', created.status, created.body);
  process.exit(2);
}
const showId = created.body.show_id;

const people = Array.from({ length: PEOPLE }, (_, i) => `racer-${i}`);
const tokens = await Promise.all(people.map((person) => tokenFor(person)));

const stampede = (seat) =>
  Promise.all(
    tokens.map((token, i) =>
      call('POST', `/shows/${showId}/reserve`, {
        token,
        body: { seats: [seat] },
        headers: { 'idempotency-key': `${runId}-${seat}-${i}` },
      }).then((r) => ({ ...r, user: people[i] })),
    ),
  );

await stampede('WARMUP'); // not counted: lets the server open its database connections first

let wrong = 0;
for (const [i, seat] of seats.entries()) {
  const results = await stampede(seat);
  const winners = results.filter((r) => r.status === 201);
  const declined = results.filter((r) => r.status === 409).length;
  const other = results.length - winners.length - declined;

  let verdict = 'ok, sold once';
  if (winners.length === 0) verdict = 'NOBODY got it (something failed)';
  if (winners.length > 1) verdict = `SOLD ${winners.length} TIMES`;
  if (winners.length !== 1) wrong++;

  const extra = other ? `, ${other} got something else` : '';
  console.log(`Round ${i + 1}, seat ${seat}: ${winners.length} got 201 Created, ${declined} got 409 seat_taken${extra}  ->  ${verdict}`);
}

if (wrong === 0) {
  console.log(`\nPASS: every seat was sold exactly once.`);
  process.exit(0);
}

const shown = await call('GET', `/shows/${showId}`);
const statuses = Object.entries(shown.body?.seats ?? {})
  .filter(([seat]) => seat !== 'WARMUP')
  .map(([seat, status]) => `${seat}=${status}`)
  .join(', ');
console.log(`\nFAIL: ${wrong} of ${ROUNDS} seats were not sold exactly once.`);
console.log(`Yet GET /shows/${showId} calmly says: ${statuses}`);
console.log(`\nThe evidence is in the database. Run this in DBeaver:`);
console.log(`  SELECT seats[1] AS seat, count(*) AS reservations FROM reservations WHERE show_id = '${showId}' GROUP BY 1 ORDER BY 1;`);
process.exit(1);
