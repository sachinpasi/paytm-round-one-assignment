import { Router } from 'express';
import { pool } from '../db.js';
import { metricsText, registry } from '../metrics.js';
import { state } from '../state.js';

const router = Router();

// liveness: the process is up. Stays green when the database is down, so we don't get restarted for it.
router.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

// readiness: started, not shutting down, and the database answers
router.get('/readyz', async (req, res) => {
  if (!state.ready || state.stopping) {
    return res.status(503).json({ status: 'unavailable', reason: state.stopping ? 'shutting_down' : 'starting_up' });
  }

  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', db: 'ok' });
  } catch (err) {
    req.log.warn({ code: err.code, err: err.message }, 'readiness check failed');
    res.status(503).json({ status: 'unavailable', db: 'down' });
  }
});

router.get('/metrics', async (req, res) => {
  res.set('Content-Type', registry.contentType).send(await metricsText());
});

export default router;
