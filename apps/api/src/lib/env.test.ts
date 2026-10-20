import { describe, it, expect } from 'vitest';
import { EnvError, parseEnv, parseTrustProxy } from './env';

const valid = {
  DATABASE_URL: 'postgres://barakah_app:pw@localhost:5432/barakah',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  APP_ENCRYPTION_KEY: 'ab'.repeat(32),
  JWT_SECRET: 'j'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(20),
  INTERNAL_ALERT_SECRET: 'a'.repeat(20),
};

describe('parseEnv', () => {
  it('accepts a valid environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SMS_PROVIDER).toBe('console'); // SMS defaults off (19.1)
  });

  it('names the failing variables but never echoes their values', () => {
    const secretValue = 'super-secret-value-that-is-too-short';
    try {
      parseEnv({
        ...valid,
        APP_ENCRYPTION_KEY: 'nothex',
        JWT_SECRET: 'short',
        DATABASE_URL: secretValue,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const message = (err as EnvError).message;
      expect(message).toContain('APP_ENCRYPTION_KEY');
      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain(secretValue);
      expect(message).not.toContain('nothex');
    }
  });

  it('rejects placeholder secrets, the dev key and http origins in production', () => {
    const prod = { ...valid, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://fund.example' };
    expect(() => parseEnv(prod)).not.toThrow();
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'change-me-jwt-secret-change-me-jwt' })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => parseEnv({ ...prod, TOKEN_PEPPER: 'dev-only-pepper-value' })).toThrow(
      /TOKEN_PEPPER/,
    );
    expect(() => parseEnv({ ...prod, APP_ENCRYPTION_KEY: '0'.repeat(64) })).toThrow(
      /APP_ENCRYPTION_KEY/,
    );
    expect(() => parseEnv({ ...prod, PUBLIC_ORIGIN: 'http://fund.example' })).toThrow(
      /PUBLIC_ORIGIN/,
    );
  });

  it('allows the dev placeholders outside production', () => {
    expect(() =>
      parseEnv({ ...valid, JWT_SECRET: 'dev-only-jwt-secret-do-not-use-in-production' }),
    ).not.toThrow();
  });
});

describe('parseTrustProxy', () => {
  it('maps the setting to the Fastify option', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('172.18.0.0/16, 10.0.0.1')).toEqual(['172.18.0.0/16', '10.0.0.1']);
  });
});
