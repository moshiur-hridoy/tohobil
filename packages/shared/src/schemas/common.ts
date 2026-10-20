import { z } from 'zod';
import { isValidIsoDate } from '../date';

/**
 * Common schemas shared across the application.
 *
 * MONEY ON THE WIRE: JSON has no bigint and `JSON.stringify(10n)` throws, so paisa travels (and is
 * stored inside jsonb payloads) as a decimal STRING of digits, e.g. "500000".
 *   - request bodies: use the *Wire schemas, which parse the string into a bigint for handlers;
 *   - jsonb payloads: use paisaStringSchema, which validates but keeps the string;
 *   - responses: use paisaOutSchema, which serialises a bigint to its decimal string.
 * Clients therefore always send/receive strings and never touch floating point.
 */

export const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Invalid period format (expected YYYY-MM)');

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (expected YYYY-MM-DD)')
  .refine(isValidIsoDate, 'Not a real calendar date');

/** ISO timestamp; offsets such as +06:00 are accepted (a bare `.datetime()` only allows Z). */
export const timestampSchema = z.string().datetime({ offset: true });

/** Non-negative paisa from a digit string; yields a bigint. */
export const paisaSchema = z
  .string()
  .regex(/^\d{1,18}$/, 'Amount must be a whole number of paisa')
  .transform((s) => BigInt(s));

/** Strictly positive paisa from a digit string; yields a bigint. */
export const positivePaisaSchema = paisaSchema.refine((v) => v > 0n, 'Amount must be positive');

/** Positive paisa kept as a digit string (for jsonb payloads, where bigint cannot be stored). */
export const paisaStringSchema = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, 'Amount must be a positive whole number of paisa');

/** Response-side: serialise a bigint paisa value to its decimal string. */
export const paisaOutSchema = z.bigint().transform((v) => v.toString());

export const uuidSchema = z.string().uuid();

export const PHONE_PATTERN = /^\+8801[3-9]\d{8}$/;
export const phoneSchema = z.string().regex(PHONE_PATTERN, 'Invalid Bangladeshi phone number');

export const memberRefSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^M\d{2}$/, 'Invalid member reference');

export const cashAccountSchema = z.enum(['CASH', 'BANK', 'BKASH', 'NAGAD']);

export const paginationSchema = z.object({
  cursor: z.string().max(200).optional(),
  // Query strings are strings: coerce.
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Boolean in a query string. `z.coerce.boolean()` would turn the text "false" into true, so spell
 * the two accepted values out.
 */
export const boolQuerySchema = z.enum(['true', 'false']).transform((v) => v === 'true');

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  request_id: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type Problem = z.infer<typeof problemSchema>;
