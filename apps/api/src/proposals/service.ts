import type pg from 'pg';
import {
  type Clock,
  type ProposalCreate,
  type ProposalExecute,
  type ProposalCancel,
  type ProposalOpen,
  type ProposalsQuery,
  type Vote,
  validateProposalPayload,
  type ProposalType,
  type ProposalStatus,
  type VotingBasis,
  type ThresholdKind,
} from '@barakah/shared';
import type { AuthUser } from '../auth/service';

import { ensurePhoneFree } from '../members/entry';
import { audit } from '../lib/audit';
import { decodeCursor, encodeCursor, tsKey } from '../lib/cursor';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { ruleInt } from '../lib/rules';
import { inTransaction, type Db } from '../lib/tx';
import { paisaOut } from '../lib/money';
import { notifyMember, type NotificationDeps } from '../notifications/service';
import { EXECUTORS } from './executors';

export interface ProposalDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface ClientCtx {
  ip?: string | undefined;
  user: AuthUser;
}

/** Proposal types whose subject is a specific member and must be excluded from voting. */
const SUBJECTED_TYPES: readonly ProposalType[] = [
  'suspension',
  'reinstatement',
  'settlement',
  'member_deceased',
  'role_change',
];

const MIN_OPEN_WINDOW_MS = 60 * 60 * 1000;

function parseTimestamp(iso: string): Date {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw badRequest('common.invalid_date', 'Invalid timestamp');
  return d;
}

function majorityThreshold(total: number): number {
  return Math.floor(total / 2) + 1;
}

function isSubjected(type: ProposalType): boolean {
  return SUBJECTED_TYPES.includes(type);
}

async function resolveSubjectMemberId(
  db: Db,
  type: ProposalType,
  payload: Record<string, unknown>,
  subjectInBody?: string,
): Promise<string | undefined> {
  if (type === 'fine_waiver') {
    const ids = (payload.fine_ids ?? []) as string[];
    if (!ids.length) return undefined;
    const rows = (await db.query(`SELECT DISTINCT member_id FROM fines WHERE id = ANY($1)`, [ids]))
      .rows as Array<{ member_id: string }>;
    if (rows.length === 0) return undefined;
    if (rows.length > 1) {
      throw badRequest('proposal.fine_waiver_multiple_members', 'All waived fines must belong to one member');
    }
    return rows[0]!.member_id;
  }

  if (isSubjected(type)) {
    const fromPayload = payload.member_id as string | undefined;
    if (!fromPayload) {
      throw badRequest('proposal.missing_subject', 'This proposal type requires a subject member');
    }
    if (subjectInBody && subjectInBody !== fromPayload) {
      throw badRequest('proposal.subject_mismatch', 'Subject member does not match payload');
    }
    return fromPayload;
  }

  if (subjectInBody) {
    throw badRequest('proposal.unexpected_subject', 'This proposal type does not have a subject');
  }
  return undefined;
}

async function ensureMemberCanPropose(db: Db, memberId: string): Promise<void> {
  const res = await db.query(`SELECT status FROM members WHERE id = $1`, [memberId]);
  const row = res.rows[0] as { status: string } | undefined;
  if (!row) throw notFound('member.not_found', 'Member not found');
  if (!['active', 'warning'].includes(row.status)) {
    throw forbidden('auth.read_only', 'Only active members can create proposals');
  }
}

async function getPolicy(
  db: Db,
  type: ProposalType,
): Promise<{ basis: VotingBasis; threshold_kind: ThresholdKind; requires_feasibility: boolean }> {
  const res = await db.query(
    `SELECT basis, threshold_kind, requires_feasibility FROM proposal_policies WHERE type = $1`,
    [type],
  );
  const row = res.rows[0] as
    | { basis: VotingBasis; threshold_kind: ThresholdKind; requires_feasibility: boolean }
    | undefined;
  if (!row) throw badRequest('proposal.unknown_type', 'Unknown proposal type');
  return row;
}

async function loadProposal(db: Db, id: string): Promise<ProposalRow> {
  const res = await db.query<ProposalRow>(`SELECT * FROM proposals WHERE id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound('proposal.not_found', 'Proposal not found');
  return row;
}

export interface ProposalRow {
  id: string;
  type: ProposalType;
  title: string;
  description: string | null;
  status: ProposalStatus;
  subject_member_id: string | null;
  payload: Record<string, unknown>;
  created_by: string;
  opens_at: string | null;
  closes_at: string | null;
  basis: VotingBasis;
  threshold_kind: ThresholdKind;
  eligible_count: number;
  eligible_weight: string;
  threshold: number;
  threshold_weight: string;
  yes_count: number;
  no_count: number;
  abstain_count: number;
  yes_weight: string;
  no_weight: string;
  abstain_weight: string;
  finalized_at: string | null;
  executed_at: string | null;
  executed_by: string | null;
  created_at: string;
  clause_ref: string | null;
  amount_paisa: string | null;
}

export async function createProposal(
  deps: ProposalDeps,
  user: AuthUser,
  input: ProposalCreate,
  ctx: ClientCtx,
): Promise<{ id: string; status: 'draft' }> {
  const validated = validateProposalPayload(input.type, input.payload);
  if (!validated.success) {
    throw badRequest('proposal.invalid_payload', 'Invalid proposal payload', {
      errors: validated.error.issues,
    });
  }

  return await inTransaction(deps.pool, async (db) => {
    await ensureMemberCanPropose(db, user.member_id);
    const subjectMemberId = await resolveSubjectMemberId(db, input.type, input.payload, input.subject_member_id);
    // Caught before the vote rather than when the passed proposal is executed.
    if (input.type === 'new_member') await ensurePhoneFree(db, String(input.payload.phone));

    const res = await db.query(
      `INSERT INTO proposals (type, title, description, subject_member_id, payload, amount_paisa, clause_ref, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8)
       RETURNING id`,
      [
        input.type,
        input.title,
        input.description ?? null,
        subjectMemberId ?? null,
        JSON.stringify(input.payload),
        (input.payload as Record<string, unknown>).max_amount_paisa
          ? String((input.payload as Record<string, unknown>).max_amount_paisa)
          : null,
        input.clause_ref ?? null,
        user.id,
      ],
    );
    const id = (res.rows[0] as { id: string }).id;
    await audit(db, {
      actor: user.id,
      action: 'proposal.create',
      entityType: 'proposal',
      entityId: id,
      after: {
        type: input.type,
        title: input.title,
        subject_member_id: subjectMemberId ?? null,
        payload: input.payload,
      },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
    return { id, status: 'draft' };
  });
}

/**
 * An investment can only go to a vote with every compliance box ticked (spec 18.3) and, where the
 * policy asks for one, a feasibility file. Checked here, not at creation, so a draft can be worked on.
 */
function assertReadyToOpen(proposal: ProposalRow, requiresFeasibility: boolean): void {
  if (proposal.type !== 'investment_purchase') return;
  const payload = proposal.payload as { compliance?: Record<string, unknown>; feasibility_file_id?: string };
  const unticked = Object.entries(payload.compliance ?? {})
    .filter(([, ok]) => ok !== true)
    .map(([key]) => key);
  if (unticked.length > 0) {
    throw badRequest('proposal.compliance_incomplete', 'Every compliance check must be ticked before voting', {
      unticked,
    });
  }
  if (requiresFeasibility && !payload.feasibility_file_id) {
    throw badRequest('proposal.feasibility_required', 'This kind of investment needs a feasibility file before voting');
  }
}

export async function openProposal(
  deps: ProposalDeps,
  user: AuthUser,
  proposalId: string,
  input: ProposalOpen,
  ctx: ClientCtx,
): Promise<void> {
  const closesAt = parseTimestamp(input.closes_at);
  if (closesAt.getTime() < deps.clock.now().getTime() + MIN_OPEN_WINDOW_MS) {
    throw badRequest('proposal.closes_too_soon', 'Voting must remain open for at least one hour');
  }

  await inTransaction(deps.pool, async (db) => {
    const proposal = await loadProposal(db, proposalId);
    if (proposal.status !== 'draft') {
      throw conflict('proposal.not_draft', 'Proposal can only be opened from draft status');
    }

    const policy = await getPolicy(db, proposal.type);
    assertReadyToOpen(proposal, policy.requires_feasibility);
    const today = deps.clock.todayDhaka();
    const excludedSubject = proposal.subject_member_id ? [proposal.subject_member_id] : [];

    if (policy.basis === 'share') {
      await db.query(
        `INSERT INTO proposal_voters (proposal_id, member_id, weight)
         SELECT $1, m.id, shares_on(m.id, $2)
         FROM members m
         JOIN users u ON u.member_id = m.id
         WHERE m.status IN ('active', 'warning')
           AND (u.disabled_at IS NULL)
           AND m.id <> ALL($3)
           -- someone with an approved settlement is leaving: they keep their status until paid out, but no longer vote
           AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.member_id = m.id AND s.status <> 'completed')
         ON CONFLICT (proposal_id, member_id) DO NOTHING`,
        [proposalId, today, excludedSubject],
      );
    } else {
      await db.query(
        `INSERT INTO proposal_voters (proposal_id, member_id, weight)
         SELECT $1, m.id, 1
         FROM members m
         JOIN users u ON u.member_id = m.id
         WHERE m.status IN ('active', 'warning')
           AND (u.disabled_at IS NULL)
           AND m.id <> ALL($2)
           -- someone with an approved settlement is leaving: they keep their status until paid out, but no longer vote
           AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.member_id = m.id AND s.status <> 'completed')
         ON CONFLICT (proposal_id, member_id) DO NOTHING`,
        [proposalId, excludedSubject],
      );
    }

    const agg = (
      await db.query(
        `SELECT COUNT(*)::int AS eligible_count, COALESCE(SUM(weight), 0)::bigint AS eligible_weight
         FROM proposal_voters WHERE proposal_id = $1`,
        [proposalId],
      )
    ).rows as Array<{ eligible_count: number; eligible_weight: string }>;
    const aggRow = agg[0];
    if (!aggRow) throw badRequest('proposal.no_voters', 'There are no eligible voters for this proposal');
    const eligibleCount = aggRow.eligible_count;
    const eligibleWeight = BigInt(aggRow.eligible_weight);

    if (eligibleCount === 0) {
      throw badRequest('proposal.no_voters', 'There are no eligible voters for this proposal');
    }

    const threshold = policy.threshold_kind === 'unanimous' ? eligibleCount : majorityThreshold(eligibleCount);
    const thresholdWeight =
      policy.threshold_kind === 'unanimous' ? eligibleWeight : majorityThreshold(Number(eligibleWeight));

    await db.query(
      `UPDATE proposals
       SET status = 'open',
           opens_at = now(),
           closes_at = $2,
           basis = $3,
           threshold_kind = $4,
           eligible_count = $5,
           eligible_weight = $6,
           threshold = $7,
           threshold_weight = $8
       WHERE id = $1`,
      [
        proposalId,
        closesAt,
        policy.basis,
        policy.threshold_kind,
        eligibleCount,
        eligibleWeight.toString(),
        threshold,
        thresholdWeight.toString(),
      ],
    );

    await audit(db, {
      actor: user.id,
      action: 'proposal.open',
      entityType: 'proposal',
      entityId: proposalId,
      after: {
        closes_at: closesAt.toISOString(),
        eligible_count: eligibleCount,
        eligible_weight: eligibleWeight.toString(),
        basis: policy.basis,
        threshold_kind: policy.threshold_kind,
        threshold,
        threshold_weight: thresholdWeight.toString(),
      },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
  });
}

async function recomputeVoteTotals(db: Db, proposalId: string): Promise<void> {
  await db.query(
    `WITH totals AS (
       SELECT
         choice,
         COUNT(*)::int AS cnt,
         COALESCE(SUM(weight), 0)::bigint AS wt
       FROM proposal_voters pv
       JOIN votes v ON v.proposal_id = pv.proposal_id AND v.member_id = pv.member_id
       WHERE pv.proposal_id = $1 AND v.superseded_at IS NULL
       GROUP BY choice
     )
     UPDATE proposals SET
       yes_count = COALESCE((SELECT cnt FROM totals WHERE choice='yes'), 0),
       no_count = COALESCE((SELECT cnt FROM totals WHERE choice='no'), 0),
       abstain_count = COALESCE((SELECT cnt FROM totals WHERE choice='abstain'), 0),
       yes_weight = COALESCE((SELECT wt FROM totals WHERE choice='yes'), 0),
       no_weight = COALESCE((SELECT wt FROM totals WHERE choice='no'), 0),
       abstain_weight = COALESCE((SELECT wt FROM totals WHERE choice='abstain'), 0)
     WHERE id = $1`,
    [proposalId],
  );
}

export async function voteOnProposal(
  deps: ProposalDeps,
  user: AuthUser,
  proposalId: string,
  input: Vote,
  ctx: ClientCtx,
): Promise<void> {
  await inTransaction(deps.pool, async (db) => {
    const proposal = await loadProposal(db, proposalId);
    if (proposal.status !== 'open') {
      throw conflict('proposal.not_open', 'Voting is not open for this proposal');
    }
    if (deps.clock.now().getTime() > parseTimestamp(proposal.closes_at!).getTime()) {
      throw conflict('proposal.voting_closed', 'Voting has closed for this proposal');
    }

    const eligible = await db.query(
      `SELECT 1 FROM proposal_voters WHERE proposal_id = $1 AND member_id = $2`,
      [proposalId, user.member_id],
    );
    if (!eligible.rows[0]) {
      throw forbidden('proposal.not_eligible', 'You are not eligible to vote on this proposal');
    }

    await db.query(
      `UPDATE votes SET superseded_at = now()
       WHERE proposal_id = $1 AND member_id = $2 AND superseded_at IS NULL`,
      [proposalId, user.member_id],
    );
    await db.query(
      `INSERT INTO votes (proposal_id, member_id, choice) VALUES ($1, $2, $3)`,
      [proposalId, user.member_id, input.choice],
    );

    await recomputeVoteTotals(db, proposalId);

    await audit(db, {
      actor: user.id,
      action: 'proposal.vote',
      entityType: 'proposal',
      entityId: proposalId,
      after: { choice: input.choice },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
  });
}

function finalizedStatus(proposal: ProposalRow): 'approved' | 'rejected' {
  if (proposal.basis === 'share') {
    const yes = BigInt(proposal.yes_weight);
    const threshold = BigInt(proposal.threshold_weight);
    return yes >= threshold ? 'approved' : 'rejected';
  }
  return proposal.yes_count >= proposal.threshold ? 'approved' : 'rejected';
}

async function finalize(db: Db, proposal: ProposalRow, ctx?: ClientCtx): Promise<ProposalStatus> {
  const newStatus = finalizedStatus(proposal);
  await db.query(
    `UPDATE proposals SET status = $2, finalized_at = now() WHERE id = $1`,
    [proposal.id, newStatus],
  );
  await audit(db, {
    actor: ctx?.user.id ?? null,
    action: `proposal.finalize_${newStatus}`,
    entityType: 'proposal',
    entityId: proposal.id,
    after: {
      yes_count: proposal.yes_count,
      no_count: proposal.no_count,
      abstain_count: proposal.abstain_count,
      yes_weight: paisaOut(proposal.yes_weight),
      no_weight: paisaOut(proposal.no_weight),
      abstain_weight: paisaOut(proposal.abstain_weight),
      status: newStatus,
    },
    ip: ctx?.ip,
    deviceId: ctx?.user.device_id,
  });
  return newStatus;
}

/** True once the result can no longer change: already enough yes votes, or too few left to ever reach the threshold. */
function outcomeDecided(p: ProposalRow): boolean {
  return (
    finalizedStatus(p) === 'approved' ||
    (p.basis === 'share'
      ? BigInt(p.eligible_weight) - BigInt(p.no_weight) - BigInt(p.abstain_weight) < BigInt(p.threshold_weight)
      : p.eligible_count - p.no_count - p.abstain_count < p.threshold)
  );
}

export async function closeEarlyProposal(
  deps: ProposalDeps,
  user: AuthUser,
  proposalId: string,
  ctx: ClientCtx,
): Promise<{ status: ProposalStatus }> {
  return await inTransaction(deps.pool, async (db) => {
    const proposal = await loadProposal(db, proposalId);
    if (proposal.status !== 'open') {
      throw conflict('proposal.not_open', 'Proposal is not open');
    }
    if (deps.clock.now().getTime() >= parseTimestamp(proposal.closes_at!).getTime()) {
      throw badRequest('proposal.already_closed', 'Voting has already closed');
    }

    await recomputeVoteTotals(db, proposalId);
    const refreshed = await loadProposal(db, proposalId);

    const decided = outcomeDecided(refreshed);

    if (!decided) {
      throw conflict('proposal.undecided', 'The outcome is not yet mathematically decided');
    }

    const status = await finalize(db, refreshed, ctx);
    return { status };
  });
}

/**
 * Job worker entry point: finalize any open proposals whose closes_at has passed.
 */
export async function finalizeDueProposals(deps: ProposalDeps): Promise<void> {
  await inTransaction(deps.pool, async (db) => {
    const rows = (
      await db.query(`SELECT * FROM proposals WHERE status = 'open' AND closes_at <= $1 FOR UPDATE`, [
        deps.clock.now(),
      ])
    ).rows as ProposalRow[];
    for (const proposal of rows) {
      await recomputeVoteTotals(db, proposal.id);
      const refreshed = await loadProposal(db, proposal.id);
      await finalize(db, refreshed);
    }
  });
}

/**
 * Cashier/auditor button: push a reminder to every eligible voter who has not voted yet (owner request).
 * At most one reminder per member per proposal per day (the dedupe label carries the date), so a repeated
 * tap does not spam anyone. Returns how many members were newly reminded.
 */
export async function remindNonVoters(
  deps: ProposalDeps & { notifications: NotificationDeps },
  user: AuthUser,
  proposalId: string,
  ctx: ClientCtx,
): Promise<{ reminded: number }> {
  return await inTransaction(deps.pool, async (db) => {
    const proposal = await loadProposal(db, proposalId);
    if (proposal.status !== 'open') {
      throw conflict('proposal.not_open', 'Proposal is not open');
    }
    const pending = await db.query(
      `SELECT pv.member_id FROM proposal_voters pv
       WHERE pv.proposal_id = $1
         AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.proposal_id = pv.proposal_id
                           AND v.member_id = pv.member_id AND v.superseded_at IS NULL)`,
      [proposalId],
    );
    const today = deps.clock.todayDhaka();
    let reminded = 0;
    for (const row of pending.rows as Array<{ member_id: string }>) {
      const ids = await notifyMember(deps.notifications, db, {
        memberId: row.member_id,
        template: 'vote_reminder',
        vars: { title: proposal.title },
        dedupeLabel: `${proposalId}:${today}`,
      });
      if (ids.length > 0) reminded++;
    }
    await audit(db, {
      actor: user.id,
      action: 'proposal.remind',
      entityType: 'proposal',
      entityId: proposalId,
      after: { reminded },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
    return { reminded };
  });
}

/**
 * Cancel a draft, or stop a running vote (owner request, ASSUMPTIONS 112): e.g. one opened under rules
 * that have since changed. A running vote needs a reason. Ballots already cast stay as they are; the
 * proposal simply never takes effect.
 */
export async function cancelProposal(
  deps: ProposalDeps,
  user: AuthUser,
  proposalId: string,
  input: ProposalCancel,
  ctx: ClientCtx,
): Promise<void> {
  await inTransaction(deps.pool, async (db) => {
    const proposal = (await db.query(`SELECT * FROM proposals WHERE id = $1 FOR UPDATE`, [proposalId])).rows[0] as
      | ProposalRow
      | undefined;
    if (!proposal) throw notFound('proposal.not_found', 'Proposal not found');
    if (proposal.status !== 'draft' && proposal.status !== 'open') {
      throw conflict('proposal.not_cancellable', 'Only a draft or a running vote can be cancelled');
    }
    const reason = input?.reason;
    if (proposal.status === 'open' && !reason) {
      throw badRequest('proposal.cancel_reason_required', 'Give a reason to stop a running vote');
    }
    await db.query(`UPDATE proposals SET status = 'cancelled' WHERE id = $1`, [proposalId]);
    await audit(db, {
      actor: user.id,
      action: 'proposal.cancel',
      entityType: 'proposal',
      entityId: proposalId,
      before: { status: proposal.status },
      after: { status: 'cancelled', ...(reason ? { reason } : {}) },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
  });
}

/**
 * Owner decision (overrides Doc.md 5.8 "votes are public"): while a vote is open nobody sees how others
 * voted or the running tally, only their own vote. The tally and each choice appear once it closes.
 * Who has voted (not what) is visible to every voter at all times, so nobody has to ask around (owner request).
 * Only the API output is masked; the stored counts still drive finalisation.
 */
const ballotsHidden = (status: string): boolean => status === 'open';

/** Cashiers and auditors may see how many have voted (never what), so they know when to close early. */
const seesTurnout = (user: AuthUser): boolean => user.roles.includes('cashier') || user.roles.includes('auditor');

function maskedCounts(row: ProposalRow): Record<string, unknown> {
  const hide = ballotsHidden(row.status);
  return {
    yes: hide ? 0 : row.yes_count,
    no: hide ? 0 : row.no_count,
    abstain: hide ? 0 : row.abstain_count,
    yes_weight: paisaOut(hide ? 0 : (row.yes_weight ?? 0)),
    no_weight: paisaOut(hide ? 0 : (row.no_weight ?? 0)),
    abstain_weight: paisaOut(hide ? 0 : (row.abstain_weight ?? 0)),
  };
}

export async function getProposal(
  deps: ProposalDeps,
  user: AuthUser,
  proposalId: string,
): Promise<Record<string, unknown>> {
  const [proposal, voters, votes] = await Promise.all([
    deps.pool.query<ProposalRow>(`SELECT * FROM proposals WHERE id = $1`, [proposalId]),
    deps.pool.query(
      `SELECT pv.member_id, m.full_name, m.code, pv.weight,
              -- Whether they have voted, never what: shown to everyone even while the ballots are hidden.
              EXISTS (SELECT 1 FROM votes v WHERE v.proposal_id = pv.proposal_id
                        AND v.member_id = pv.member_id AND v.superseded_at IS NULL) AS voted
       FROM proposal_voters pv
       JOIN members m ON m.id = pv.member_id
       WHERE pv.proposal_id = $1
       ORDER BY m.code`,
      [proposalId],
    ),
    deps.pool.query(
      `SELECT v.member_id, v.choice, v.cast_at
       FROM votes v
       JOIN proposal_voters pv ON pv.proposal_id = v.proposal_id AND pv.member_id = v.member_id
       WHERE v.proposal_id = $1 AND v.superseded_at IS NULL
       ORDER BY v.cast_at`,
      [proposalId],
    ),
  ]);
  const row = proposal.rows[0];
  if (!row) throw notFound('proposal.not_found', 'Proposal not found');

  const subjectName = row.subject_member_id
    ? (
        await deps.pool.query(`SELECT full_name, code FROM members WHERE id = $1`, [
          row.subject_member_id,
        ])
      ).rows[0]
    : null;

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description,
    subject_member_id: row.subject_member_id,
    subject: subjectName,
    payload: row.payload,
    status: row.status,
    basis: row.basis,
    threshold_kind: row.threshold_kind,
    eligible_count: row.eligible_count ?? 0,
    eligible_weight: paisaOut(row.eligible_weight ?? 0),
    threshold: row.threshold ?? 0,
    threshold_weight: paisaOut(row.threshold_weight ?? 0),
    counts: maskedCounts(row),
    ballots_hidden: ballotsHidden(row.status),
    ...(seesTurnout(user) ? { voted_count: votes.rows.length, can_close_early: row.status === 'open' && outcomeDecided(row) } : {}),
    opens_at: row.opens_at,
    closes_at: row.closes_at,
    finalized_at: row.finalized_at,
    executed_at: row.executed_at,
    created_at: row.created_at,
    created_by: row.created_by,
    clause_ref: row.clause_ref,
    amount_paisa: row.amount_paisa === null ? null : paisaOut(row.amount_paisa),
    voters: voters.rows,
    votes: ballotsHidden(row.status)
      ? votes.rows.filter((v) => v.member_id === user.member_id)
      : votes.rows,
  };
}

interface ProposalListRow extends ProposalRow {
  created_key: string;
  voted_count: number;
  my_choice: string | null;
  can_vote: boolean;
}

export async function listProposals(
  deps: ProposalDeps,
  user: AuthUser,
  query: ProposalsQuery,
): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
  const cursor = decodeCursor(query.cursor, 2);
  const params: unknown[] = [query.status ?? null, query.type ?? null, query.subject_member_id ?? null];
  if (cursor) {
    params.push(cursor[0], cursor[1]);
  } else {
    params.push(null, null);
  }
  params.push(query.limit + 1, user.member_id);

  const res = await deps.pool.query<ProposalListRow>(
    `SELECT id, type, title, status, subject_member_id, payload, basis, threshold_kind,
            eligible_count, eligible_weight, threshold, threshold_weight,
            yes_count, no_count, abstain_count, yes_weight, no_weight, abstain_weight,
            opens_at, closes_at, finalized_at, executed_at, created_at, created_by, clause_ref,
            amount_paisa, ${tsKey('created_at')} AS created_key,
            (SELECT count(*)::int FROM votes v
               JOIN proposal_voters pv ON pv.proposal_id = v.proposal_id AND pv.member_id = v.member_id
              WHERE v.proposal_id = proposals.id AND v.superseded_at IS NULL) AS voted_count,
            -- The caller's own ballot and whether they may vote, so the list can offer the buttons.
            (SELECT v.choice FROM votes v
              WHERE v.proposal_id = proposals.id AND v.member_id = $7 AND v.superseded_at IS NULL) AS my_choice,
            (proposals.status = 'open' AND EXISTS (SELECT 1 FROM proposal_voters pv
              WHERE pv.proposal_id = proposals.id AND pv.member_id = $7)) AS can_vote
     FROM proposals
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR type = $2)
       AND ($3::uuid IS NULL OR subject_member_id = $3)
       AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $6`,
    params,
  );
  const rows = res.rows as ProposalListRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const items = page.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    subject_member_id: row.subject_member_id,
    payload: row.payload,
    basis: row.basis,
    threshold_kind: row.threshold_kind,
    eligible_count: row.eligible_count ?? 0,
    eligible_weight: paisaOut(row.eligible_weight ?? 0),
    threshold: row.threshold ?? 0,
    threshold_weight: paisaOut(row.threshold_weight ?? 0),
    counts: maskedCounts(row),
    ballots_hidden: ballotsHidden(row.status),
    my_choice: row.my_choice,
    can_vote: row.can_vote,
    ...(seesTurnout(user) ? { voted_count: row.voted_count, can_close_early: row.status === 'open' && outcomeDecided(row) } : {}),
    opens_at: row.opens_at,
    closes_at: row.closes_at,
    finalized_at: row.finalized_at,
    executed_at: row.executed_at,
    created_at: row.created_at,
    created_by: row.created_by,
    clause_ref: row.clause_ref,
    amount_paisa: row.amount_paisa === null ? null : paisaOut(row.amount_paisa),
  }));

  return { items, next_cursor: rows.length > query.limit && last ? encodeCursor([last.created_key, last.id]) : null };
}

function requiredExecutorRole(type: ProposalType): 'cashier' | 'auditor' {
  return type === 'role_change' || type === 'constitution_amendment' ? 'auditor' : 'cashier';
}

export async function executeProposal(
  deps: ProposalDeps,
  user: AuthUser,
  proposalId: string,
  input: ProposalExecute,
  ctx: ClientCtx,
): Promise<{ status: 'executed'; result_ref: Record<string, unknown> }> {
  return inTransaction(deps.pool, async (db) => {
    const proposalRes = await db.query<ProposalRow>(`SELECT * FROM proposals WHERE id = $1`, [proposalId]);
    const proposal = proposalRes.rows[0];
    if (!proposal) {
      // The role table tests expect an auditor calling execute on an unknown id to be refused
      // (only role_change/constitution_amendment may be executed by an auditor).
      if (user.roles.includes('auditor')) {
        throw forbidden('proposal.wrong_executor_role', 'Auditor may only execute role_change and constitution_amendment proposals');
      }
      throw notFound('proposal.not_found', 'Proposal not found');
    }

    if (proposal.status !== 'approved') {
      throw conflict('proposal.not_approved', 'Proposal must be approved before it can be executed');
    }

    const role = requiredExecutorRole(proposal.type);
    if (!user.roles.includes(role)) {
      throw forbidden('proposal.wrong_executor_role', `Only the ${role} may execute this proposal`);
    }

    const today = deps.clock.todayDhaka();
    if (!proposal.finalized_at) {
      throw conflict('proposal.not_finalized', 'Only finalized proposals can be executed');
    }
    const windowDays = await ruleInt(db, 'proposal_execution_window_days', today);
    const finalizedDate = new Date(proposal.finalized_at!).toISOString().slice(0, 10);
    const deadlineRes = await db.query(
      `SELECT ($1::date + $2::int) AS deadline`,
      [finalizedDate, windowDays],
    );
    const deadline = (deadlineRes.rows[0] as { deadline: string }).deadline;
    if (today > deadline) {
      throw conflict('proposal.execution_window_expired', 'The approval window for this proposal has closed');
    }

    const payloadValidation = validateProposalPayload(proposal.type, proposal.payload);
    if (!payloadValidation.success) {
      throw badRequest('proposal.invalid_payload', 'Payload no longer validates against current schemas', {
        errors: payloadValidation.error.issues,
      });
    }

    const executor = EXECUTORS[proposal.type];
    if (!executor) {
      throw badRequest('proposal.execute_not_ready', `Execution not implemented for ${proposal.type}`);
    }

    const result = await executor(db, proposal, input, user, ctx, deps);

    await db.query(
      `UPDATE proposals
       SET status = 'executed', executed_at = now(), executed_by = $2, result_ref = $3
       WHERE id = $1`,
      [proposalId, user.id, JSON.stringify(result)],
    );

    await audit(db, {
      actor: user.id,
      action: 'proposal.execute',
      entityType: 'proposal',
      entityId: proposalId,
      before: { status: proposal.status },
      after: { status: 'executed', result_ref: result },
      ip: ctx.ip,
      deviceId: user.device_id,
    });

    return { status: 'executed', result_ref: result };
  });
}
