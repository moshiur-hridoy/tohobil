import type { JobDeps } from '../index';

export async function cleanupJob(deps: JobDeps): Promise<{
  idempotencyKeys: number;
  activationCodes: number;
}> {
  const dayAgo = new Date(deps.clock.now().getTime() - 24 * 3600_000);
  const ik = await deps.pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < $1`,
    [dayAgo],
  );
  const ac = await deps.pool.query(
    `DELETE FROM activation_codes WHERE consumed_at IS NOT NULL AND consumed_at < $1`,
    [dayAgo],
  );
  return {
    idempotencyKeys: ik.rowCount ?? 0,
    activationCodes: ac.rowCount ?? 0,
  };
}
