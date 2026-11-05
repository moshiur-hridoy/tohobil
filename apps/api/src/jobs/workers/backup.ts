import type { JobDeps } from '../index';
import { runBackupWatch } from '../../system/status';

/** Daily 09:15: no fresh backup alerts the cashier and auditor; on Fridays a healthy one sends a report. */
export async function backupWatchJob(deps: Pick<JobDeps, 'pool' | 'clock' | 'env'>) {
  return runBackupWatch({
    pool: deps.pool,
    clock: deps.clock,
    statusDir: deps.env.STATUS_DIR,
    production: deps.env.NODE_ENV === 'production',
  });
}
