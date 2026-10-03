import { isConnectionError } from '../db.js';
import { HttpError } from '../errors.js';

const errorBody = (code, message, details) => ({ error: { code, message, details } });

export function notFound(req, res, next) {
  next(new HttpError(404, 'not_found', 'Route not found'));
}

// four arguments is how express recognises an error handler
export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    if (err.status === 429) res.set('Retry-After', '1');
    return res.status(err.status).json(errorBody(err.code, err.message, err.details));
  }

  // thrown by express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json(errorBody('bad_request', 'Request body is not valid JSON'));
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json(errorBody('payload_too_large', 'Request body is too large'));
  }

  if (isConnectionError(err)) {
    req.log.error({ err: err.code ?? err.message }, 'database unavailable');
    return res.status(503).set('Retry-After', '2').json(errorBody('dependency_unavailable', 'Database unavailable'));
  }

  req.log.error({ err }, 'unhandled error');
  res.status(500).json(errorBody('internal_error', 'Internal error'));
}
