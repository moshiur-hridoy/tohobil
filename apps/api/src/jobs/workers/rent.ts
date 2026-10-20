import { generateExpectedRent } from '../../rent/service';
import { currentPeriod } from '@barakah/shared';
import type { JobDeps } from '../index';

export async function generateRentExpectedJob(deps: JobDeps): Promise<{ created: number; period: string }> {
  const period = currentPeriod(deps.clock);
  const { created } = await generateExpectedRent(deps.pool, period);
  return { created, period };
}
