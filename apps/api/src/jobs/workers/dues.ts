import type { Clock } from '@barakah/shared';
import type pg from 'pg';

export interface DuesJobDeps {
  pool: pg.Pool;
  clock: Clock;
}

export async function generateDuesJob(deps: DuesJobDeps): Promise<{ created: number; period: string }> {
  const today = deps.clock.now();
  const { generateDues } = await import('../../dues/service');
  const { periodFromDate, ruleInt, isDay } = await import('./util');
  const generationDay = await ruleInt(deps.pool, deps.clock, 'dues_generation_day', 1);
  const currentPeriod = periodFromDate(today);
  if (!isDay(today, generationDay)) {
    return { created: 0, period: currentPeriod };
  }
  const result = await generateDues(
    { pool: deps.pool, clock: deps.clock },
    { period: currentPeriod, actor: null },
  );
  return { created: result.created.length, period: currentPeriod };
}
