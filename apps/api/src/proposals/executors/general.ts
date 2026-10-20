import { serialised } from './shared';
import type { ExecutorSignature } from './shared';

/**
 * General and deferred decision executors (spec 5.8 group 1).
 *
 * These proposal types record a decision but do not affect the ledger in this slice:
 *   general, contribution_change, asset_cost_levy, member_qard, financing_arrangement,
 *   dissolution, wind_up, land_selection, project_closure.
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

export const assetCostLevyExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as {
    total_paisa: string;
    asset_id?: string;
    due_date: string;
    reason: string;
  };
  return serialised({
    total_paisa: payload.total_paisa,
    asset_id: payload.asset_id ?? null,
    due_date: payload.due_date,
    reason: payload.reason,
    note: 'Levy authority recorded; levy dues will be created in the next phase.',
  });
};

export const memberQardExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as {
    direction: 'receive' | 'repay';
    lender_member_id: string;
    amount_paisa: string;
    account: string;
  };
  return serialised({
    direction: payload.direction,
    lender_member_id: payload.lender_member_id,
    amount_paisa: payload.amount_paisa,
    account: payload.account,
    note: 'Qard authority recorded; ledger posting will be added in the next phase.',
  });
};

export const financingArrangementExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as {
    counterparty: string;
    description: string;
    total_paisa: string;
    instalments: Array<{ due_on: string; amount_paisa: string }>;
  };
  return serialised({
    counterparty: payload.counterparty,
    total_paisa: payload.total_paisa,
    instalments: payload.instalments,
    note: 'Financing arrangement recorded; instalments will post when paid.',
  });
};

export const dissolutionExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({ decision: payload.text, note: 'Dissolution recorded.' });
};

export const windUpExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as {
    asset_ids_to_sell: string[];
    distribution_plan: string;
  };
  return serialised({
    asset_ids_to_sell: payload.asset_ids_to_sell,
    distribution_plan: payload.distribution_plan,
    note: 'Wind-up plan recorded; sales and final distribution are separate proposals.',
  });
};

export const landSelectionExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({ decision: payload.text, note: 'Land selection recorded.' });
};

export const projectClosureExecutor: ExecutorSignature = async (_db, proposal) => {
  const payload = proposal.payload as { text: string };
  return serialised({ decision: payload.text, note: 'Project closure recorded.' });
};
