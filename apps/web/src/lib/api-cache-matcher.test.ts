import { describe, expect, it } from 'vitest';
import { isOfflineReadableApiRequest } from './api-cache-matcher';

const req = (path: string, method = 'GET') =>
  ({ url: new URL(`https://fund.example${path}`), request: { method } }) as unknown as Parameters<
    typeof isOfflineReadableApiRequest
  >[0];

describe('service worker API cache matcher', () => {
  it('is self-contained: it still works when serialised with toString(), as Workbox does', () => {
    // Evaluate in a scope that has none of this module's variables. A closure over an outer
    // constant would throw ReferenceError here (and inside the real service worker).
    const standalone = new Function(`return (${isOfflineReadableApiRequest.toString()})`)() as (
      a: unknown,
    ) => boolean;
    expect(standalone(req('/api/v1/ledger'))).toBe(true);
    expect(standalone(req('/api/v1/auth/login'))).toBe(false);
  });

  it('matches the read-only data the app shows offline', () => {
    for (const path of [
      '/api/v1/matrix',
      '/api/v1/ledger?from=2026-01-01',
      '/api/v1/assets/abc',
      '/api/v1/members',
      '/api/v1/nav',
    ]) {
      expect(isOfflineReadableApiRequest(req(path)), path).toBe(true);
    }
  });

  it('never caches credentials, proofs, devices, payments, reports or health', () => {
    for (const path of [
      '/api/v1/auth/refresh',
      '/api/v1/files/123',
      '/api/v1/me/devices',
      '/api/v1/payments',
      '/api/v1/notifications',
      '/api/v1/reports/statement',
      '/api/v1/health',
      '/api/v1/membersX',
      '/other/api/v1/ledger',
    ]) {
      expect(isOfflineReadableApiRequest(req(path)), path).toBe(false);
    }
  });

  it('never caches writes', () => {
    expect(isOfflineReadableApiRequest(req('/api/v1/ledger', 'POST'))).toBe(false);
    expect(isOfflineReadableApiRequest(req('/api/v1/members/me', 'PATCH'))).toBe(false);
  });
});
