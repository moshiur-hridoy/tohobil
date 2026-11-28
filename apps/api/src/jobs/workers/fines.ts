import type { Clock } from '@barakah/shared';
import type pg from 'pg';

export interface FinesJobDeps {
  pool: pg.Pool;
  clock: Clock;
  /** `AUTO_FINES_FROM`: dues dated before this are never fined by the job. */
  finesFrom?: string | undefined;
}

/**
 * Daily: the fines of the last `fine_day`. Running every day (idempotent) means a server that was off
 * on that day catches up the next time, not a month later (ASSUMPTIONS 136).
 */
export async function applyFinesJob(deps: FinesJobDeps): Promise<{ applied: number }> {
  const { ruleInt } = await import('./util');
  const fineDay = await ruleInt(deps.pool, deps.clock, 'fine_day', 21);
  const { applyFines, lastFineRun } = await import('../../fines/service');
  const cutoff = lastFineRun(deps.clock.todayDhaka(), fineDay);
  const fines = await applyFines({ pool: deps.pool, clock: deps.clock }, cutoff, deps.finesFrom);
  return { applied: fines.length };
}
