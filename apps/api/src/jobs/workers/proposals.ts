import type { JobDeps, Scheduler } from '../index';
import { finalizeDueProposals } from '../../proposals/service';

export async function proposalJobs(deps: JobDeps, scheduler: Scheduler): Promise<void> {
  await scheduler.send('finalize-proposals');
}

export async function finalizeProposalsJob(deps: JobDeps): Promise<void> {
  await finalizeDueProposals({ pool: deps.pool, clock: deps.clock });
}
