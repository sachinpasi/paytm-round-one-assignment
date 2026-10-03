import { Router } from 'express';
import { DECLINE_CODES, HttpError } from '../errors.js';
import * as metrics from '../metrics.js';
import { requireAuth } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { reserveRequest } from '../schemas.js';
import { cancelReservation, reserveSeats } from '../services/reservations.js';

const router = Router();

// header preferred, body field accepted
function getIdempotencyKey(req) {
  const fromHeader = req.get('idempotency-key');
  const fromBody = req.body.idempotency_key;

  if (fromHeader && fromBody && fromHeader !== fromBody) {
    throw new HttpError(
      400,
      'idempotency_key_mismatch',
      'The Idempotency-Key header and the idempotency_key field differ',
    );
  }

  const key = fromHeader || fromBody;
  if (!key || key.length > 200) {
    throw new HttpError(
      400,
      'idempotency_key_required',
      'Send an Idempotency-Key header (or idempotency_key field) of 1-200 characters',
    );
  }
  return key;
}

router.post('/shows/:showId/reserve', requireAuth, validate(reserveRequest), async (req, res) => {
  const key = getIdempotencyKey(req);

  try {
    const { reservation, replay } = await reserveSeats({
      showId: req.params.showId,
      userId: req.user.id,
      seats: req.body.seats,
      key,
    });

    // every request that gets here is counted exactly once: confirmed, or declined with a reason
    if (replay) {
      metrics.declined.inc({ reason: 'idempotent_replay' });
      res.locals.outcome = 'replay';
      res.set('Idempotent-Replay', 'true').status(200);
    } else {
      metrics.confirmed.inc();
      res.locals.outcome = 'confirmed';
      res.status(201);
    }
    res.json(reservation);
  } catch (err) {
    if (err instanceof HttpError && DECLINE_CODES.has(err.code)) {
      metrics.declined.inc({ reason: err.code });
      res.locals.outcome = `declined:${err.code}`;
    }
    throw err;
  }
});

router.post('/reservations/:reservationId/cancel', requireAuth, async (req, res) => {
  const { reservation, cancelled } = await cancelReservation({
    reservationId: req.params.reservationId,
    userId: req.user.id,
  });

  if (cancelled) metrics.cancelled.inc(); // a repeat cancel doesn't count again
  res.locals.outcome = cancelled ? 'cancelled' : 'already_cancelled';
  res.json(reservation);
});

export default router;
