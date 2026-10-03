import { state } from '../state.js';

// Until the database is migrated only the health routes answer.
export default function readiness(req, res, next) {
  if (state.ready) return next();

  res
    .set('Retry-After', '2')
    .status(503)
    .json({ error: { code: 'starting_up', message: 'The server is starting up' } });
}
