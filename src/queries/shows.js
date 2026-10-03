export async function insertShow(client, { id, name, pricePaise, totalSeats, perUserLimit }) {
  await client.query(
    'INSERT INTO shows (id, name, price_paise, total_seats, per_user_limit) VALUES ($1, $2, $3, $4, $5)',
    [id, name, pricePaise, totalSeats, perUserLimit],
  );
}

export async function insertSeats(client, showId, seatIds) {
  // all seats in one statement instead of one insert per seat
  await client.query('INSERT INTO seats (show_id, seat_id) SELECT $1, unnest($2::text[])', [showId, seatIds]);
}

export async function findShow(client, id) {
  const { rows } = await client.query('SELECT * FROM shows WHERE id = $1', [id]);
  return rows[0];
}

export async function listSeats(client, showId) {
  const { rows } = await client.query('SELECT seat_id, status FROM seats WHERE show_id = $1 ORDER BY seat_id', [
    showId,
  ]);
  return rows;
}
