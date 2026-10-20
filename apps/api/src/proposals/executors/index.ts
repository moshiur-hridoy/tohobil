import type { ProposalType } from '@barakah/shared';
import {
  assetCostLevyExecutor,
  contributionChangeExecutor,
  dissolutionExecutor,
  financingArrangementExecutor,
  generalExecutor,
  landSelectionExecutor,
  memberQardExecutor,
  projectClosureExecutor,
  windUpExecutor,
} from './general';
import {
  assetSaleExecutor,
  charityDonationExecutor,
  distributionExecutor,
  expenseExecutor,
  fineWaiverExecutor,
  investmentPurchaseExecutor,
} from './financial';
import {
  constitutionAmendmentExecutor,
  roleChangeExecutor,
  ruleChangeExecutor,
  valuationUpdateExecutor,
} from './governance';
import {
  memberDeceasedExecutor,
  newMemberExecutor,
  reinstatementExecutor,
  settlementExecutor,
  suspensionExecutor,
} from './membership';
import type { ExecutorSignature } from './shared';

export const EXECUTORS: Record<ProposalType, ExecutorSignature> = {
  general: generalExecutor,
  contribution_change: contributionChangeExecutor,
  asset_cost_levy: assetCostLevyExecutor,
  member_qard: memberQardExecutor,
  financing_arrangement: financingArrangementExecutor,
  dissolution: dissolutionExecutor,
  wind_up: windUpExecutor,
  land_selection: landSelectionExecutor,
  project_closure: projectClosureExecutor,

  fine_waiver: fineWaiverExecutor,
  expense: expenseExecutor,
  charity_donation: charityDonationExecutor,
  investment_purchase: investmentPurchaseExecutor,
  asset_sale: assetSaleExecutor,
  distribution: distributionExecutor,

  valuation_update: valuationUpdateExecutor,
  rule_change: ruleChangeExecutor,
  constitution_amendment: constitutionAmendmentExecutor,
  role_change: roleChangeExecutor,

  new_member: newMemberExecutor,
  suspension: suspensionExecutor,
  reinstatement: reinstatementExecutor,
  settlement: settlementExecutor,
  member_deceased: memberDeceasedExecutor,
};

export type { ExecutorSignature };
