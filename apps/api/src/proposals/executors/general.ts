import { serialised } from './shared';
import type { ExecutorSignature } from './shared';

/**
 * General and deferred decision executors (spec 5.8 group 1).
 *
 * These proposal types record a decision but do not affect the ledger in this slice:
 *   general, contribution_change, dissolution, land_selection, project_closure.
 * The money obligations (levy, qard, financing, wind-up) live in obligations.ts.
 */
export const generalExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({
    decision: payload.text,
  });
};

export const contributionChangeExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { new_amount_paisa: string; reason: string; effective_from: string };
  return serialised({
    new_amount_paisa: payload.new_amount_paisa,
    reason: payload.reason,
    effective_from: payload.effective_from,
    note: 'Contribution change recorded; rule update is a separate step before this takes effect.',
  });
};

export const dissolutionExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({ decision: payload.text, note: 'Dissolution recorded.' });
};

export const landSelectionExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({ decision: payload.text, note: 'Land selection recorded.' });
};

export const projectClosureExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({ decision: payload.text, note: 'Project closure recorded.' });
};
