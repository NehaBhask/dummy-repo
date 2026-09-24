import { z } from 'zod';
import { AppError } from './errors.js';

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const details = {};
  for (const issue of r.error.issues) details[issue.path.join('.') || '_'] = issue.message;
  throw new AppError('validation_error', { details });
}

const id = z.string().min(1).max(64);
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real date');
const currency = z.string().regex(/^[A-Z]{3}$/, 'expected ISO-4217 code, e.g. INR');
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const int = (min, max, dflt) => {
  const s = z.coerce.number().int().min(min).max(max);
  return dflt === undefined ? s.optional() : s.default(dflt);
};

// Idempotency keys are stored in a UNIQUE column and used to derive per-row keys ("<key>#<i>").
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/, '8–128 chars of A-Z a-z 0-9 _ . : -');

const stayOrRow = z.union([
  z.object({ inventory_id: id, units: z.number().int().min(1).max(20).default(1) }).strict(),
  z
    .object({
      entity_type: z.enum(['room_type', 'flight_fare']),
      entity_id: id,
      for_date: dateStr,
      nights: z.number().int().min(1).max(30).default(1),
      units: z.number().int().min(1).max(20).default(1),
    })
    .strict(),
]);

export const holdBody = z.object({
  user_id: id.optional(),
  idempotency_key: idempotencyKey.optional(),
  ttl_seconds: z.number().int().min(5).max(1800).optional(),
  items: z.array(stayOrRow).min(1).max(60),
});

export const bookingBody = z
  .object({
    user_id: id.optional(),
    idempotency_key: idempotencyKey.optional(),
    hold_ids: z.array(id).min(1).max(60).optional(),
    items: z.array(z.object({ hold_id: id, rate_plan_id: id.optional() }).strict()).min(1).max(60).optional(),
    currency: currency.optional(),
    payment: z.object({ method: z.enum(['card', 'upi', 'netbanking', 'wallet', 'mock']).default('mock') }).optional(),
    channel: z.enum(['web', 'mobile_app', 'partner', 'call_centre', 'agent']).optional(),
    simulate_failure: z.enum(['flight', 'hotel', 'payment']).optional(),
  })
  .refine((b) => b.hold_ids || b.items, { message: 'provide hold_ids or items' });

export const cancelBody = z.object({ user_id: id.optional(), reason: z.string().max(200).optional() });

export const hotelQuery = z.object({
  city: z.string().min(1).max(80),
  check_in: dateStr,
  nights: int(1, 30, 1),
  rooms: int(1, 10, 1),
  adults: int(1, 20, 1),
  children: int(0, 20, 0),
  max_price: z.coerce.number().positive().optional(),
  min_stars: int(1, 5),
  breakfast: bool.optional(),
  refundable: bool.optional(),
  currency: currency.optional(),
  include_sold_out: bool.optional(), // hotel page: list fully booked room types too (available_units 0)
  budget_currency: currency.optional(), // currency max_price is expressed in (default: display currency)
  sort: z.enum(['price', 'rating', 'score']).optional(),
  limit: int(1, 50, 20),
});

export const flightQuery = z.object({
  origin: z.string().min(2).max(80),
  destination: z.string().min(2).max(80),
  date: dateStr,
  seats: int(1, 9, 1),
  cabin: z.enum(['economy', 'premium_economy', 'business', 'first']).optional(),
  max_price: z.coerce.number().positive().optional(),
  currency: currency.optional(),
  limit: int(1, 50, 20),
});

export const aiSearchBody = z.object({
  query: z.string().min(3).max(500),
  currency: currency.optional(),
  kind: z.enum(['hotels', 'flights']).default('hotels'),
});

export const loadTestBody = z.object({
  inventory_id: id.optional(),
  concurrent_requests: z.number().int().min(1).max(1000).optional(),
  units_per_request: z.number().int().min(1).max(5).optional(),
  duplicate_factor: z.number().int().min(1).max(5).optional(),
  mode: z.enum(['api', 'direct']).optional(),
  cleanup: z.boolean().optional(),
  bypass_shield: z.boolean().optional(),
  wait: z.boolean().optional(),
});
