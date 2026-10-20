import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Crockford base32 without I, L, O, U: what people can read aloud and type (spec 19.1). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8 random Crockford characters (40 bits). */
export function generateActivationCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += CROCKFORD[b & 31];
  return out;
}

/** Opaque 256-bit refresh token. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Keyed hash for tokens and activation codes. They are high-entropy or short-lived and attempt
 * limited, so a peppered HMAC is enough (no slow hash needed) and allows lookup by hash.
 */
export function hashToken(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** AES-256-GCM for TOTP secrets at rest. Output: base64(iv | tag | ciphertext). */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(payload: string, keyHex: string): string {
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
