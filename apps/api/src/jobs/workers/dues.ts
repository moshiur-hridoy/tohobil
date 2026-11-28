import type { Clock } from '@barakah/shared';
import type pg from 'pg';

export interface DuesJobDeps {
  pool: pg.Pool;
  clock: Clock;
}

export async function generateDuesJob(deps: DuesJobDeps): Promise<{ created: number; period: string }> {
  const today = deps.clock.now();
  const { generateDues } = await import('../../dues/service');
  const { periodFromDate, ruleInt, isWindow } = await import('./util');
  const generationDay = await ruleInt(deps.pool, deps.clock, 'dues_generation_day', 1);
  const currentPeriod = periodFromDate(today);
  const dueDay = await ruleInt(deps.pool, deps.clock, 'due_day', 20);
  // Every day from the generation day while members can still pay on time, so a server that was off
  // on that day catches up. A due is never created on or after its due date: it would be late at birth.
  if (!isWindow(today, generationDay, Math.max(generationDay, dueDay - 1))) {
    return { created: 0, period: currentPeriod };
  }
  const result = await generateDues(
    { pool: deps.pool, clock: deps.clock },
    { period: currentPeriod, actor: null },
  );
  return { created: result.created.length, period: currentPeriod };
}
