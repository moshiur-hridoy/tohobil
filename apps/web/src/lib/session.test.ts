import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { isTransientError, retryTransient } from './session';

const err = (status: number, code = 'x') => new ApiError(status, code, 'msg');

describe('isTransientError', () => {
  it('keeps the session for no network, timeouts, rate limits and server errors', () => {
    expect(isTransientError(err(0, 'network'))).toBe(true);
    expect(isTransientError(err(408))).toBe(true);
    expect(isTransientError(err(429, 'rate_limit.exceeded'))).toBe(true);
    expect(isTransientError(err(500))).toBe(true);
    expect(isTransientError(err(502, 'server.unreachable'))).toBe(true);
    expect(isTransientError(err(503))).toBe(true);
  });

  it('drops the session only when the server rejects it', () => {
    expect(isTransientError(err(401, 'auth.refresh_reuse'))).toBe(false);
    expect(isTransientError(err(401, 'auth.device_reset_needed'))).toBe(false);
    expect(isTransientError(err(403, 'auth.forbidden'))).toBe(false);
    expect(isTransientError(err(400, 'validation.error'))).toBe(false);
  });

  it('never logs out because of an unexpected error', () => {
    expect(isTransientError(new Error('boom'))).toBe(true);
    expect(isTransientError(new SyntaxError('bad json'))).toBe(true);
  });
});

describe('retryTransient', () => {
  const noSleep = async () => undefined;

  it('returns the first success', async () => {
    let calls = 0;
    const result = await retryTransient(async () => {
      calls++;
      if (calls < 3) throw err(429);
      return 'ok';
    }, [1, 1, 1], noSleep);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws a rejection at once, without retrying', async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls++;
        throw err(401, 'auth.refresh_reuse');
      }, [1, 1, 1], noSleep),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it('gives up with the last transient error after the delays run out', async () => {
    const slept: number[] = [];
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw err(503);
        },
        [10, 20],
        async (ms) => {
          slept.push(ms);
        },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
    expect(slept).toEqual([10, 20]);
  });
});
