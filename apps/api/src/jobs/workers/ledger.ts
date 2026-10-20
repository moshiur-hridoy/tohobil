import type { JobDeps } from '../index';
import { runLedgerVerify } from '../../system/status';

/** Daily: recompute the ledger hash chain; a break alerts the cashier and auditor (spec 5.6). */
export async function verifyLedgerJob(deps: Pick<JobDeps, 'pool' | 'clock'>): Promise<{ ok: boolean }> {
  return runLedgerVerify(deps.pool, deps.clock);
}
