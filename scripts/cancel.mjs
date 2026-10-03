#!/usr/bin/env node
// Cancelling frees the seat and the user's allowance, and never touches a seat someone else now owns,
// including when cancels and new bookings race each other.
// usage: node scripts/cancel.mjs [BASE_URL]
import { cli, createClient } from './lib/client.mjs';

const { positional } = cli(process.argv.slice(2));
const { base, call, tokenFor } = createClient(positional[0] ?? process.env.BASE_URL ?? 'http://localhost:3000', {
  maxSockets: 60,
});
const runId = Date.now().toString(36);
const LIMIT = 4;

console.log(`Cancel test against ${base.origin}\n`);

const seats = ['C1', 'C2', ...Array.from({ length: 6 }, (_, i) => `D${i}`), ...Array.from({ length: 5 }, (_, i) => `E${i}`)];
const admin = await tokenFor('cancel-admin', process.env.ADMIN_KEY ?? 'demo-admin-key');
const created = await call('POST', '/shows', {
  token: admin,
  body: { name: `cancel-${runId}`, seats, price_paise: 100, per_user_limit: LIMIT },
});
if (created.status !== 201) {
  console.error('Could not create a show:', created.status, created.body);
  process.exit(2);
}
const showId = created.body.show_id;

let keyNumber = 0;
const book = (token, seatList) =>
  call('POST', `/shows/${showId}/reserve`, {
    token,
    body: { seats: seatList },
    headers: { 'idempotency-key': `${runId}-${keyNumber++}` },
  });
const cancel = (token, reservationId) => call('POST', `/reservations/${reservationId}/cancel`, { token });
const seatStatus = async (seat) => (await call('GET', `/shows/${showId}`)).body.seats[seat];

let failures = 0;
const check = (text, ok) => {
  console.log(`  ${text}  ${ok ? 'ok' : 'WRONG'}`);
  if (!ok) failures++;
};

// 1. sequential walk-through
console.log('Part 1: a cancelled seat is free again, and an old cancel cannot touch the new owner');
const alice = await tokenFor(`cancel-${runId}-alice`);
const bob = await tokenFor(`cancel-${runId}-bob`);
const first = await book(alice, ['C1']);
check(`alice books C1: ${first.status}`, first.status === 201);
const notMine = await cancel(bob, first.body.reservation_id);
check(`bob tries to cancel alice's booking: ${notMine.status}`, notMine.status === 403);
const missing = await cancel(bob, 'res_does-not-exist');
check(`cancelling a booking that does not exist: ${missing.status}`, missing.status === 404);
const done = await cancel(alice, first.body.reservation_id);
check(`alice cancels: ${done.status} ${done.body?.status}`, done.status === 200 && done.body.status === 'cancelled');
check(`C1 is available again: ${await seatStatus('C1')}`, (await seatStatus('C1')) === 'available');
const rebook = await book(bob, ['C1']);
check(`bob books C1: ${rebook.status}`, rebook.status === 201);
const again = await cancel(alice, first.body.reservation_id);
check(`alice cancels the OLD booking again: ${again.status}`, again.status === 200);
check(`C1 still belongs to bob: ${await seatStatus('C1')}`, (await seatStatus('C1')) === 'confirmed');

// 2. the same cancel sent many times at once returns the allowance only once
console.log('\nPart 2: 20 cancels of the same booking at the same moment');
const carol = await tokenFor(`cancel-${runId}-carol`);
const carolsBooking = await book(carol, ['C2']);
const storm = await Promise.all(Array.from({ length: 20 }, () => cancel(carol, carolsBooking.body.reservation_id)));
check(
  `all 20 answered 200 and cancelled: ${storm.filter((r) => r.status === 200 && r.body.status === 'cancelled').length} of 20`,
  storm.every((r) => r.status === 200 && r.body.status === 'cancelled'),
);
const refill = [];
for (let i = 0; i < LIMIT; i++) refill.push(await book(carol, [`D${i}`]));
const over = await book(carol, ['D4']);
check(
  `carol can book exactly ${LIMIT} seats afterwards, not more: ${refill.map((r) => r.status).join(', ')} then ${over.status}`,
  refill.every((r) => r.status === 201) && over.status === 409 && over.body.error.code === 'per_user_limit',
);

// 3. a cancel racing a crowd trying to book the same seat
console.log('\nPart 3: someone cancels while 30 people try to book that very seat');
for (let round = 0; round < 5; round++) {
  const seat = `E${round}`;
  const owner = await tokenFor(`cancel-${runId}-owner${round}`);
  const original = await book(owner, [seat]);
  const crowd = await Promise.all(Array.from({ length: 30 }, (_, i) => tokenFor(`cancel-${runId}-crowd${round}-${i}`)));
  const results = await Promise.all([
    cancel(owner, original.body.reservation_id),
    ...crowd.map((token) => book(token, [seat])),
  ]);
  const wins = results.slice(1).filter((r) => r.status === 201).length;
  const failed = results.filter((r) => r.status >= 500 || r.status === 0).length;
  const status = await seatStatus(seat);
  check(
    `seat ${seat}: cancel ${results[0].status}, ${wins} new booking(s) won, seat ends ${status}`,
    results[0].status === 200 && failed === 0 && wins <= 1 && (wins === 1) === (status === 'confirmed'),
  );
}

console.log(failures === 0 ? '\nPASS: cancelling is safe.' : `\nFAIL: ${failures} check(s) went wrong.`);
process.exit(failures === 0 ? 0 : 1);
