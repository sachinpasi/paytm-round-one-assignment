import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { createShowRequest } from '../schemas.js';
import { createShow, getShow } from '../services/shows.js';

const router = Router();

// auth and role are checked before the body, so callers without access learn nothing about it
router.post('/shows', requireAuth, requireAdmin, validate(createShowRequest), async (req, res) => {
  const { name, seats, price_paise: pricePaise, per_user_limit: perUserLimit } = req.body;
  const show = await createShow({ name, seats, pricePaise, perUserLimit });
  res.status(201).json(show);
});

router.get('/shows/:showId', async (req, res) => {
  res.json(await getShow(req.params.showId));
});

export default router;
