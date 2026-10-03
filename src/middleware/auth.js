import { HttpError } from '../errors.js';
import { verifyToken } from '../services/auth.js';

export function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'unauthorized', 'Missing bearer token');
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw new HttpError(401, 'unauthorized', 'Invalid or expired token');
  }

  // identity only ever comes from the token, never from ids in the body
  req.user = { id: payload.sub, role: payload.role };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'Admin only');
  }
  next();
}
