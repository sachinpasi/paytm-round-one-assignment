import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config.js';

export function issueToken(userId, role = 'user') {
  return jwt.sign({ sub: userId, role }, config.jwtSecret, { algorithm: 'HS256', expiresIn: config.tokenTtl });
}

// throws if the signature is wrong or the token has expired
export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

// constant time, so response timing doesn't give away how much of the key was right
export function isAdminKey(candidate) {
  const given = Buffer.from(String(candidate));
  const expected = Buffer.from(config.adminKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
