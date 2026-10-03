import { createHash, randomUUID } from 'node:crypto';
import { db, transaction } from '../db.js';
import { HttpError } from '../errors.js';
import { findShow } from '../queries/shows.js';
import * as queries from '../queries/reservations.js';

const seatTaken = (seats) =>
  new HttpError(409, 'seat_taken', 'One or more requested seats are already taken', { seats });

const overLimit = (limit) => new HttpError(409, 'per_user_limit', `At most ${limit} seats per person for this show`);

const formatReservation = (row) => ({
  reservation_id: row.id,
  show_id: row.show_id,
  user_id: row.user_id,
  seats: row.seats,
  amount_paise: row.amount_paise,
  status: row.status,
});

// [A1, A2] and [A2, A1] are the same request
const fingerprint = (showId, seats) =>
  createHash('sha256').update(JSON.stringify([showId, [...seats].sort()])).digest('hex');

export async function reserveSeats({ showId, userId, seats, key }) {
  const requestHash = fingerprint(showId, seats);
  const id = `res_${randomUUID()}`;

  // Once a seat has sold, most of the traffic for it is people who are already too late.
  // Turn them away with one cheap read instead of a transaction that waits for the lock and
  // rolls back. This can only refuse, never book. Skipped for a used key: a retry should get
  // its original answer, not "taken".
  const pre = await queries.precheck(db, { showId, userId, key, seatIds: seats });
  if (!pre.key_used && pre.taken.length > 0) throw seatTaken(pre.taken);

  return transaction(async (tx) => {
    const isNewKey = await queries.insertIdempotencyKey(tx, { userId, key, requestHash, reservationId: id });
    if (!isNewKey) return replay(tx, { userId, key, requestHash });

    const show = await findShow(tx, showId);
    if (!show) throw new HttpError(404, 'show_not_found', `No such show: ${showId}`);

    const limit = show.per_user_limit;
    // the upsert in addHeldSeats skips its WHERE when it creates the row, so catch this case first
    if (seats.length > limit) throw overLimit(limit);
    const withinLimit = await queries.addHeldSeats(tx, { showId, userId, count: seats.length, limit });
    if (!withinLimit) throw overLimit(limit);

    const locked = await queries.lockSeats(tx, showId, seats);
    if (locked.length !== seats.length) {
      const found = new Set(locked.map((s) => s.seat_id));
      throw new HttpError(404, 'seat_not_found', 'Unknown seat(s)', { seats: seats.filter((s) => !found.has(s)) });
    }
    const taken = locked.filter((s) => s.status !== 'available').map((s) => s.seat_id);
    if (taken.length > 0) throw seatTaken(taken);

    const row = await queries.insertReservation(tx, {
      id,
      showId,
      userId,
      seats,
      amountPaise: show.price_paise * seats.length,
    });
    await queries.confirmSeats(tx, showId, seats, id);

    return { reservation: formatReservation(row), replay: false };
  });
}

async function replay(tx, { userId, key, requestHash }) {
  const previous = await queries.findIdempotencyKey(tx, { userId, key });
  if (previous.request_hash !== requestHash) {
    throw new HttpError(409, 'idempotency_key_reuse', 'This idempotency key was already used for a different request');
  }
  const row = await queries.findReservation(tx, previous.reservation_id);
  return { reservation: formatReservation(row), replay: true };
}

export async function cancelReservation({ reservationId, userId }) {
  return transaction(async (tx) => {
    // locking the reservation makes repeated cancels take turns, so the seats are given back once
    const existing = await queries.lockReservation(tx, reservationId);
    if (!existing) throw new HttpError(404, 'reservation_not_found', 'No such reservation');
    if (existing.user_id !== userId) throw new HttpError(403, 'forbidden', 'This is not your reservation');
    if (existing.status === 'cancelled') return { reservation: formatReservation(existing), cancelled: false };

    // same order as booking: the user's count first, then the seats
    const showId = existing.show_id;
    await queries.removeHeldSeats(tx, { showId, userId, count: existing.seats.length });
    await queries.lockReservationSeats(tx, showId, reservationId);
    await queries.releaseSeats(tx, showId, reservationId);

    const updated = await queries.markCancelled(tx, reservationId);
    return { reservation: formatReservation(updated), cancelled: true };
  });
}
