import { z } from 'zod';
import { DEVICE_PLATFORMS } from '../enums';
import { memberRefSchema } from './common';

/**
 * PIN deny list: common weak PINs (spec 19.1). Beyond this list, all-same digits and simple
 * ascending/descending sequences are rejected by isValidPin.
 */
export const PIN_DENY_LIST = [
  '000000',
  '111111',
  '222222',
  '333333',
  '444444',
  '555555',
  '666666',
  '777777',
  '888888',
  '999999',
  '123456',
  '654321',
  '123123',
  '456456',
  '789789',
  '112233',
  '121212',
  '123321',
];

export function isValidPin(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return false;
  if (PIN_DENY_LIST.includes(pin)) return false;
  if (new Set(pin).size === 1) return false;

  // Simple sequences, including ones that wrap past 9 (890123, 321098).
  const digits = pin.split('').map(Number);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i++) {
    const prev = digits[i - 1] as number;
    const cur = digits[i] as number;
    if (cur !== (prev + 1) % 10) ascending = false;
    if (cur !== (prev + 9) % 10) descending = false;
  }
  return !(ascending || descending);
}

/**
 * Activation codes are 8 characters of Crockford base32 (spec 19.1). People read them aloud and
 * type them on phones, so normalise the usual confusions before validating: case, spaces/hyphens,
 * I and L -> 1, O -> 0.
 */
export function normalizeActivationCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

export const activationCodeSchema = z
  .string()
  .max(32)
  .transform(normalizeActivationCode)
  .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/, 'Invalid activation code'));

/** A PIN being chosen: must also pass the weak-PIN rules. */
export const newPinSchema = z
  .string()
  .regex(/^\d{6}$/, 'PIN must be 6 digits')
  .refine(isValidPin, 'PIN is too easy to guess');

/** A PIN being entered at login: format only, so the deny list is never revealed to attackers. */
export const loginPinSchema = z.string().regex(/^\d{6}$/, 'PIN must be 6 digits');

export const deviceSchema = z.object({
  label: z.string().max(100).optional(),
  platform: z.enum(DEVICE_PLATFORMS),
  install_id: z.string().min(1).max(200),
});

export const activateSchema = z.object({
  member_ref: memberRefSchema,
  code: activationCodeSchema,
  device: deviceSchema,
  pin: newPinSchema,
});

export type Activate = z.infer<typeof activateSchema>;

export const loginSchema = z.object({
  member_ref: memberRefSchema,
  pin: loginPinSchema,
  device_id: z.string().uuid(),
});

export type Login = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refresh_token: z.string().min(1).max(500),
  device_id: z.string().uuid(),
});

export type Refresh = z.infer<typeof refreshSchema>;

export const totpVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});

export type TotpVerify = z.infer<typeof totpVerifySchema>;
