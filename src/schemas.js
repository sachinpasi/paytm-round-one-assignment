import { z } from 'zod';

const seatId = z.string().trim().min(1).max(32);

const seatList = (max) =>
  z
    .array(seatId)
    .min(1)
    .max(max)
    .refine((seats) => new Set(seats).size === seats.length, 'seats must be unique');

export const tokenRequest = z.object({
  user_id: z.string().regex(/^[A-Za-z0-9_.@:-]{1,64}$/, 'must be 1-64 characters: letters, digits, _ . @ : -'),
  admin_key: z.string().optional(),
});

export const createShowRequest = z.object({
  name: z.string().trim().min(1).max(200),
  seats: seatList(100_000),
  price_paise: z.number().int().nonnegative(), // whole paise, never fractions
  per_user_limit: z.number().int().min(1).max(50).default(4),
});

export const reserveRequest = z.object({
  seats: seatList(20),
  idempotency_key: z.string().min(1).max(200).optional(), // or the Idempotency-Key header
});
