// No transaction, no locks. Used to turn people away from seats that are already gone.
export async function precheck(client, { showId, userId, key, seatIds }) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM idempotency WHERE user_id = $2 AND key = $4) AS key_used,
            ARRAY(SELECT seat_id FROM seats
                   WHERE show_id = $1 AND seat_id = ANY($3::text[]) AND status <> 'available'
                   ORDER BY seat_id) AS taken`,
    [showId, userId, seatIds, key],
  );
  return rows[0];
}

// false if the key was already there. If another transaction is inserting the same key right now,
// this waits for it to commit or roll back first.
export async function insertIdempotencyKey(client, { userId, key, requestHash, reservationId }) {
  const { rowCount } = await client.query(
    `INSERT INTO idempotency (user_id, key, request_hash, reservation_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [userId, key, requestHash, reservationId],
  );
  return rowCount === 1;
}

export async function findIdempotencyKey(client, { userId, key }) {
  const { rows } = await client.query(
    'SELECT request_hash, reservation_id FROM idempotency WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  return rows[0];
}

export async function findReservation(client, id) {
  const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1', [id]);
  return rows[0];
}

// Adds to the user's seat count for the show unless that would go over the limit.
// One statement, so parallel requests from the same user queue up on this row.
export async function addHeldSeats(client, { showId, userId, count, limit }) {
  const { rowCount } = await client.query(
    `INSERT INTO user_holds (show_id, user_id, seat_count) VALUES ($1, $2, $3)
     ON CONFLICT (show_id, user_id)
     DO UPDATE SET seat_count = user_holds.seat_count + EXCLUDED.seat_count
     WHERE user_holds.seat_count + EXCLUDED.seat_count <= $4`,
    [showId, userId, count, limit],
  );
  return rowCount === 1;
}

export async function removeHeldSeats(client, { showId, userId, count }) {
  await client.query('UPDATE user_holds SET seat_count = seat_count - $3 WHERE show_id = $1 AND user_id = $2', [
    showId,
    userId,
    count,
  ]);
}

// This lock is what decides who gets a seat: anyone else after the same seat waits here until we
// commit. Locking in seat_id order means two multi-seat requests can never deadlock each other.
export async function lockSeats(client, showId, seatIds) {
  const { rows } = await client.query(
    `SELECT seat_id, status FROM seats
      WHERE show_id = $1 AND seat_id = ANY($2::text[])
      ORDER BY seat_id
      FOR UPDATE`,
    [showId, seatIds],
  );
  return rows;
}

export async function insertReservation(client, { id, showId, userId, seats, amountPaise }) {
  const { rows } = await client.query(
    `INSERT INTO reservations (id, show_id, user_id, seats, amount_paise, status)
     VALUES ($1, $2, $3, $4, $5, 'confirmed')
     RETURNING *`,
    [id, showId, userId, seats, amountPaise],
  );
  return rows[0];
}

export async function confirmSeats(client, showId, seatIds, reservationId) {
  await client.query(
    `UPDATE seats SET status = 'confirmed', reservation_id = $3
      WHERE show_id = $1 AND seat_id = ANY($2::text[])`,
    [showId, seatIds, reservationId],
  );
}

export async function lockReservation(client, id) {
  const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}

export async function lockReservationSeats(client, showId, reservationId) {
  await client.query('SELECT 1 FROM seats WHERE show_id = $1 AND reservation_id = $2 ORDER BY seat_id FOR UPDATE', [
    showId,
    reservationId,
  ]);
}

// only frees seats this reservation still owns, never ones sold on to someone else
export async function releaseSeats(client, showId, reservationId) {
  await client.query(
    `UPDATE seats SET status = 'available', reservation_id = NULL
      WHERE show_id = $1 AND reservation_id = $2`,
    [showId, reservationId],
  );
}

export async function markCancelled(client, id) {
  const { rows } = await client.query(
    `UPDATE reservations SET status = 'cancelled', cancelled_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0];
}
