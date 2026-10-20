import type { Clock } from '@barakah/shared';
import type pg from 'pg';

export interface FinesJobDeps {
  pool: pg.Pool;
  clock: Clock;
}

export async function applyFinesJob(deps: FinesJobDeps): Promise<{ applied: number }> {
  const today = deps.clock.now();
  const { ruleInt, isDay } = await import('./util');
  const fineDay = await ruleInt(deps.pool, deps.clock, 'fine_day', 21);
  if (!isDay(today, fineDay)) {
    return { applied: 0 };
  }
  const { applyFines } = await import('../../fines/service');
  const fines = await applyFines({ pool: deps.pool, clock: deps.clock });
  return { applied: fines.length };
}
