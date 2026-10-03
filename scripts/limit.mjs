#!/usr/bin/env node
// Per-user seat limit, including when one user fires many requests at once.
// usage: node scripts/limit.mjs [BASE_URL] [--people 5] [--attempts 10]
import { cli, createClient } from './lib/client.mjs';

const { positional, flag } = cli(process.argv.slice(2));
const PEOPLE = flag('people', 5);
const ATTEMPTS = flag('attempts', 10);
const LIMIT = 4;
const { base, call, tokenFor } = createClient(positional[0] ?? process.env.BASE_URL ?? 'http://localhost:3000', {
  maxSockets: PEOPLE * ATTEMPTS,
});
const runId = Date.now().toString(36);

console.log(`Limit test against ${base.origin}: at most ${LIMIT} seats per person\n`);

// a distinct seat per request in part 1, plus spares for parts 2 and 3
const seats = [
  ...Array.from({ length: PEOPLE * ATTEMPTS }, (_, i) => `P${i}`),
  ...Array.from({ length: 6 }, (_, i) => `Q${i}`),
  ...Array.from({ length: 6 }, (_, i) => `S${i}`),
];
const admin = await tokenFor('limit-admin', process.env.ADMIN_KEY ?? 'demo-admin-key');
const created = await call('POST', '/shows', {
  token: admin,
  body: { name: `limit-${runId}`, seats, price_paise: 100, per_user_limit: LIMIT },
});
if (created.status !== 201) {
  console.error('Could not create a show:', created.status, created.body);
  process.exit(2);
}
const showId = created.body.show_id;

let keyNumber = 0;
const reserve = (token, seatList, key = `${runId}-${keyNumber++}`) =>
  call('POST', `/shows/${showId}/reserve`, { token, body: { seats: seatList }, headers: { 'idempotency-key': key } });
const code = (r) => r.body?.error?.code;

let failures = 0;
const verdict = (ok) => {
  if (!ok) failures++;
  return ok ? 'ok' : 'WRONG';
};

// 1. each user fires all their requests at once, each for a different seat
console.log(`Part 1: ${PEOPLE} people, each sending ${ATTEMPTS} requests at once (all for different seats)`);
const tokens = await Promise.all(Array.from({ length: PEOPLE }, (_, p) => tokenFor(`limit-${runId}-${p}`)));
const results = await Promise.all(
  tokens.flatMap((token, p) =>
    Array.from({ length: ATTEMPTS }, (_, a) => reserve(token, [`P${p * ATTEMPTS + a}`]).then((r) => ({ ...r, p }))),
  ),
);
for (let p = 0; p < PEOPLE; p++) {
  const mine = results.filter((r) => r.p === p);
  const booked = mine.filter((r) => r.status === 201).length;
  const declined = mine.filter((r) => r.status === 409 && code(r) === 'per_user_limit').length;
  const ok = booked === LIMIT && declined === ATTEMPTS - LIMIT;
  const note = booked > LIMIT ? `HOLDS ${booked} SEATS (the limit is ${LIMIT})` : '';
  console.log(`  person ${p}: ${booked} booked, ${declined} declined per_user_limit  ${verdict(ok)} ${note}`);
}

// 2. the limit counts seats, not requests, and a request is all-or-nothing
console.log('\nPart 2: one person, one request at a time');
const carol = await tokenFor(`limit-${runId}-carol`);
const steps = [
  [['Q0', 'Q1', 'Q2'], 201, 'asks for 3 seats (3 held)'],
  [['Q3', 'Q4'], 409, 'asks for 2 more: that would make 5, so nothing is booked'],
  [['Q3'], 201, 'asks for 1 more (4 held)'],
  [['Q5'], 409, 'asks for a 5th seat'],
];
for (const [seatList, expected, text] of steps) {
  const r = await reserve(carol, seatList);
  console.log(`  ${text}: got ${r.status}  ${verdict(r.status === expected)}`);
}

// 3. failed requests and retries must not use up the allowance
console.log('\nPart 3: failures and retries do not use up the allowance');
const dave = await tokenFor(`limit-${runId}-dave`);
const erin = await tokenFor(`limit-${runId}-erin`);
await reserve(erin, ['S0']); // erin takes S0
let seatTaken = 0;
for (let i = 0; i < 6; i++) if (code(await reserve(dave, ['S0'])) === 'seat_taken') seatTaken++;
const retryKey = `${runId}-retry`;
const first = await reserve(dave, ['S1'], retryKey);
let replays = 0;
for (let i = 0; i < 5; i++) if ((await reserve(dave, ['S1'], retryKey)).status === 200) replays++;
const more = [await reserve(dave, ['S2']), await reserve(dave, ['S3']), await reserve(dave, ['S4'])];
const fifth = await reserve(dave, ['S5']);
console.log(`  6 requests for a seat someone else owns: ${seatTaken} got seat_taken  ${verdict(seatTaken === 6)}`);
console.log(`  1 booking, then the same request 5 more times: ${first.status} then ${replays} replays  ${verdict(first.status === 201 && replays === 5)}`);
console.log(`  3 more bookings still succeed (4 held in total): ${more.map((r) => r.status).join(', ')}  ${verdict(more.every((r) => r.status === 201))}`);
console.log(`  and the next one is refused: ${fifth.status} ${code(fifth)}  ${verdict(fifth.status === 409 && code(fifth) === 'per_user_limit')}`);

console.log(failures === 0 ? `\nPASS: nobody holds more than ${LIMIT} seats.` : `\nFAIL: ${failures} check(s) went wrong.`);
process.exit(failures === 0 ? 0 : 1);
