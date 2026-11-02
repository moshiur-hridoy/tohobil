import { ApiError } from './api';

/**
 * Whether a failed auth call is worth retrying with the same refresh token.
 *
 * Only an explicit rejection (a 4xx such as a revoked device or a replayed token) means the stored
 * session is dead. No network, a timeout, a rate limit (429) or a server error (5xx, including a
 * proxy answering while the API restarts) says nothing about the token, so it must be kept:
 * discarding it would make the member type their PIN again after every hiccup. Errors that are not
 * ApiErrors (a bug, a malformed body) are treated the same way, because logging out is the costly
 * mistake here.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.status === 0 || err.status === 408 || err.status === 429) return true;
  return err.status >= 500;
}

/** Waits between boot attempts: about 12 s in all, inside the API's one-minute rate-limit window. */
export const BOOT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

/**
 * Run `fn`, retrying after each delay while it fails with a transient error. A non-transient error
 * is thrown at once; when the delays run out, the last transient error is thrown.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  delays: readonly number[] = BOOT_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[attempt];
      if (!isTransientError(err) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}
