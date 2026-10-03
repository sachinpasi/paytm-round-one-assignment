import { randomUUID } from 'node:crypto';
import logger from '../logger.js';
import { httpDuration, httpRequests } from '../metrics.js';

const QUIET_ROUTES = new Set(['/healthz', '/metrics']);

export default function requestLogger(req, res, next) {
  req.id = (req.get('x-request-id') || randomUUID()).slice(0, 100);
  req.log = logger.child({ req_id: req.id });
  res.set('X-Request-Id', req.id);

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    // label by route pattern (/shows/:showId), never the raw url
    const route = req.route ? req.baseUrl + req.route.path : 'unmatched';

    httpRequests.inc({ method: req.method, route, status: res.statusCode });
    httpDuration.observe({ method: req.method, route }, seconds);

    if (QUIET_ROUTES.has(route)) return;
    req.log.info(
      {
        method: req.method,
        route,
        status: res.statusCode,
        ms: Math.round(seconds * 1000),
        user_id: req.user?.id,
        outcome: res.locals.outcome,
      },
      'request',
    );
  });

  next();
}
