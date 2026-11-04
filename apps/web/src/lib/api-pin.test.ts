import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setPinAsker } from './api';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  setPinAsker(null);
  vi.unstubAllGlobals();
});

describe('auditor PIN step-up (ASSUMPTIONS.md 117)', () => {
  it('asks for the PIN and sends the same request again with it', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const pin = (init.headers as Record<string, string>)['x-step-up-pin'];
      if (!pin) return json(403, { code: 'auth.pin_required' });
      return pin === '483917' ? json(200, { ok: true }) : json(401, { code: 'auth.invalid_credentials', attempts_left: 4 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tried: number[] = [];
    setPinAsker(async (attempt) => {
      const wrong = await attempt('111222');
      tried.push(wrong.status);
      return attempt('483917');
    });

    await expect(api('/periods/2026-12/lock', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true });
    expect(tried).toEqual([401]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const last = fetchMock.mock.calls[2]!;
    expect(last[0]).toBe('/api/v1/periods/2026-12/lock');
    expect(last[1].method).toBe('POST');
    expect(last[1].body).toBe(JSON.stringify({ a: 1 }));
  });

  it('cancel gives the original error back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, { code: 'auth.pin_required' })));
    setPinAsker(async () => null);
    await expect(api('/periods/2026-12/lock', { method: 'POST' })).rejects.toMatchObject({ code: 'auth.pin_required' });
  });
});
