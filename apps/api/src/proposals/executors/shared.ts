import type { CashAccountCode, ProposalExecute } from '@barakah/shared';
import { LEDGER_REF, type LedgerActor, type PostingInput } from '../../ledger/service';
import { badRequest } from '../../lib/errors';
import type { AuthUser } from '../../auth/service';
import type { ClientCtx } from '../service';

export type ExecutorSignature = (
  db: import('../../lib/tx').Db,
  proposal: import('../service').ProposalRow,
  input: ProposalExecute,
  actor: AuthUser,
  ctx: ClientCtx,
  deps: import('../service').ProposalDeps,
) => Promise<Record<string, unknown>>;

export function ledgerActor(actor: AuthUser, ctx: ClientCtx): LedgerActor {
  return { userId: actor.id, ip: ctx.ip, deviceId: actor.device_id };
}

export function sourceAccount(input: ProposalExecute, fallback: CashAccountCode = 'BANK'): CashAccountCode {
  return input.account ?? fallback;
}

export function requireAmount(input: ProposalExecute): bigint {
  if (input.actual_amount_paisa === undefined) {
    throw badRequest('proposal.amount_required', 'actual_amount_paisa is required to execute this proposal');
  }
  return input.actual_amount_paisa;
}

export function proposalPosting(
  proposalId: string,
  entryDate: string,
  debit: string,
  credit: string,
  amountPaisa: bigint,
  memo: string,
  memberId?: string | null,
): PostingInput {
  return {
    entry_date: entryDate,
    debit,
    credit,
    amount_paisa: amountPaisa,
    member_id: memberId ?? null,
    ref_type: LEDGER_REF.proposal,
    ref_id: proposalId,
    memo,
  };
}

export function serialised(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
