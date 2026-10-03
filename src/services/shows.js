import { randomBytes } from 'node:crypto';
import { db, transaction } from '../db.js';
import { HttpError } from '../errors.js';
import * as queries from '../queries/shows.js';

export async function createShow({ name, seats, pricePaise, perUserLimit }) {
  const id = `show_${randomBytes(6).toString('hex')}`;

  await transaction(async (tx) => {
    await queries.insertShow(tx, { id, name, pricePaise, totalSeats: seats.length, perUserLimit });
    await queries.insertSeats(tx, id, seats);
  });

  return getShow(id);
}

export async function getShow(id) {
  const show = await queries.findShow(db, id);
  if (!show) throw new HttpError(404, 'show_not_found', `No such show: ${id}`);

  // counts and the seat map come from the same rows, so they always add up to total_seats
  const counts = { available: 0, held: 0, confirmed: 0 };
  const seats = {};
  for (const { seat_id: seatId, status } of await queries.listSeats(db, id)) {
    counts[status]++;
    seats[seatId] = status;
  }

  return {
    show_id: show.id,
    name: show.name,
    price_paise: show.price_paise,
    total_seats: show.total_seats,
    per_user_limit: show.per_user_limit,
    counts,
    seats,
  };
}
