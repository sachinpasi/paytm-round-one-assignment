import { Router } from 'express';
import { HttpError } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { tokenRequest } from '../schemas.js';
import { isAdminKey, issueToken } from '../services/auth.js';

const router = Router();

// Not a real login: anyone can get a token for any user id. Sending admin_key gets an admin token.
router.post('/auth/token', validate(tokenRequest), (req, res) => {
  const { user_id: userId, admin_key: adminKey } = req.body;

  let role = 'user';
  if (adminKey !== undefined) {
    if (!isAdminKey(adminKey)) throw new HttpError(403, 'forbidden', 'Bad admin key');
    role = 'admin';
  }

  res.json({ token: issueToken(userId, role), user_id: userId, role });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user_id: req.user.id, role: req.user.role });
});

export default router;
