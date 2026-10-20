/**
 * Container healthcheck (docker-compose `api.healthcheck`): exits 0 when /api/v1/health answers
 * 200, otherwise 1. Deliberately independent of the full environment validation.
 */
export {}; // makes this file a module so top-level await is allowed

const port = process.env.PORT ?? '3000';

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
