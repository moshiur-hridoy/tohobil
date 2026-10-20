import type pg from 'pg';
import type { Logger } from 'pino';
import { formatBDT, type Clock } from '@barakah/shared';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import { notifyMember } from '../notifications/service';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { computeNav, entryPriceForShares, hasStaleValuations } from '../lib/nav';
import { paisaOut, toBigInt } from '../lib/money';
import { ruleInt } from '../lib/rules';
import type { Db } from '../lib/tx';

export interface EntryDeps {
  pool: pg.Pool;
  clock: Clock;
  log: Logger;
  pushSender: PushSender;
  smsProvider: SmsProvider;
}

interface ProposalRow {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
}

/** The parts of a member needed to create one if it does not exist yet. */
interface NewMemberPayload {
  name: string;
  phone: string;
  shares: number;
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00+06:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseNewMemberPayload(payload: Record<string, unknown>): NewMemberPayload {
  const name = payload.name ?? payload.full_name;
  const phone = payload.phone;
  const shares = payload.shares;
  if (typeof name !== 'string' || !name.trim()) {
    throw badRequest('entry.name_required', 'New member name is required');
  }
  if (typeof phone !== 'string' || !phone.match(/^\+8801[3-9]\d{8}$/)) {
    throw badRequest('entry.phone_invalid', 'Valid Bangladeshi phone number is required');
  }
  if (typeof shares !== 'number' || !Number.isInteger(shares) || shares <= 0) {
    throw badRequest('entry.shares_invalid', 'Shares must be a positive integer');
  }
  return { name: name.trim(), phone, shares };
}

/**
 * Allocate the next member code (M01, M02, ...). Existing fixture members already use these codes.
 */
async function nextMemberCode(db: Db): Promise<string> {
  const res = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 2) AS int)), 0) + 1 AS n FROM members`,
  );
  const n = (res.rows[0] as { n: number }).n;
  return `M${String(n).padStart(2, '0')}`;
}

/**
 * Create the prospective member for a `new_member` proposal when the proposal payload does not yet
 * carry a `member_id`. This is a fallback that lets tests and the executor create the quote in one
 * step; the canonical flow is to create the member during proposal execution and then call this
 * function.
 */
async function ensureProspectiveMember(
  db: Db,
  proposal: ProposalRow,
  asOf: string,
): Promise<string> {
  const payloadMemberId = proposal.payload.member_id;
  if (typeof payloadMemberId === 'string') {
    const check = await db.query(`SELECT id FROM members WHERE id = $1 AND status = 'prospective'`, [
      payloadMemberId,
    ]);
    if ((check.rowCount ?? 0) > 0) return payloadMemberId;
    throw badRequest('entry.member_not_prospective', 'Member is not in prospective status');
  }

  const { name, phone, shares: _shares } = parseNewMemberPayload(proposal.payload);
  const code = await nextMemberCode(db);
  const member = await db.query(
    `INSERT INTO members (code, full_name, phone, status, joined_on)
     VALUES ($1, $2, $3, 'prospective', $4::date) RETURNING id`,
    [code, name, phone, asOf],
  );
  const memberId = (member.rows[0] as { id: string }).id;

  // Record who triggered the creation through the proposal result_ref in the same transaction.
  await db.query(
    `UPDATE proposals SET result_ref = jsonb_build_object('member_id', $2::text)
     WHERE id = $1`,
    [proposal.id, memberId],
  );

  return memberId;
}

interface EntryQuoteResult {
  quote_id: string;
  member_id: string;
  shares: number;
  net_assets_paisa: bigint;
  shares_outstanding: number;
  price_paisa: bigint;
  expires_at: Date;
}

/**
 * Create an entry quote for a `new_member` proposal (spec 5.9 step 1).
 *
 * - Reads the proposal payload for the member id (creating the prospective member if absent).
 * - Computes current NAV and shares outstanding.
 * - price = divRound(net_assets * shares, shares_outstanding)
 * - expires_at = now + 7 days
 * - Inserts the quote and a matching `entry` due so the normal payment flow can pay it.
 *
 * Fails with `nav.stale_valuation` if any held asset valuation is older than
 * `valuation_max_age_days`.
 */
export async function createEntryQuoteFromProposal(
  db: Db,
  deps: EntryDeps,
  proposalId: string,
): Promise<EntryQuoteResult> {
  const proposalRes = await db.query<ProposalRow>(
    `SELECT id, type, status, payload FROM proposals WHERE id = $1 FOR UPDATE`,
    [proposalId],
  );
  const proposal = proposalRes.rows[0];
  if (!proposal) throw notFound('proposal.not_found', 'Proposal not found');
  if (proposal.type !== 'new_member') {
    throw badRequest('entry.not_new_member', 'This is not a new_member proposal');
  }

  const today = deps.clock.todayDhaka();
  const memberId = await ensureProspectiveMember(db, proposal, today);
  const parsedShares = parseNewMemberPayload(proposal.payload).shares;

  const nav = await computeNav(db, today);
  const maxAgeDays = await ruleInt(db, 'valuation_max_age_days', today);
  if (hasStaleValuations(nav, maxAgeDays, today)) {
    throw badRequest('nav.stale_valuation', 'A held asset valuation is stale; update it first');
  }

  const price = entryPriceForShares(nav, parsedShares);
  const expiresAt = new Date(deps.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);
  const quoteExpiryDate = addDays(today, 7);

  const quote = await db.query(
    `INSERT INTO entry_quotes (member_id, shares, net_assets_paisa, shares_outstanding, price_paisa,
                               expires_at, proposal_id)
     VALUES ($1, $2, $3::bigint, $4, $5::bigint, $6, $7)
     RETURNING id`,
    [memberId, parsedShares, nav.net_assets_paisa.toString(), nav.shares_outstanding, price.toString(), expiresAt, proposalId],
  );
  const quoteId = (quote.rows[0] as { id: string }).id;

  // Create the entry due so the payment flow has something to allocate to.
  await db.query(
    `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
     VALUES ($1, $2::text, 'entry', $3, $4::bigint, $5::date)
     ON CONFLICT (member_id, period, kind) DO NOTHING`,
    [memberId, today.slice(0, 7), parsedShares, price.toString(), quoteExpiryDate],
  );

  await notifyMember(
    { pool: deps.pool, clock: deps.clock, log: deps.log, pushSender: deps.pushSender, smsProvider: deps.smsProvider },
    db,
    {
      memberId,
      template: 'entry_quote',
      vars: {
        name: proposal.payload.name as string,
        shares: String(parsedShares),
        price: formatBDT(price, { digits: 'bn' }),
        expires: quoteExpiryDate,
      },
      dedupeLabel: quoteId,
    },
  );

  await audit(db, {
    actor: null,
    action: 'entry.quote_created',
    entityType: 'entry_quote',
    entityId: quoteId,
    after: {
      member_id: memberId,
      shares: parsedShares,
      net_assets_paisa: nav.net_assets_paisa.toString(),
      shares_outstanding: nav.shares_outstanding,
      price_paisa: price.toString(),
      expires_at: expiresAt.toISOString(),
    },
  });

  return {
    quote_id: quoteId,
    member_id: memberId,
    shares: parsedShares,
    net_assets_paisa: nav.net_assets_paisa,
    shares_outstanding: nav.shares_outstanding,
    price_paisa: price,
    expires_at: expiresAt,
  };
}

/**
 * Activate a prospective member after the entry due has been fully paid (spec 5.9 step 3):
 * - status -> active
 - insert share_holdings effective_from tomorrow
 * - create a user row if missing
 * - notify the new member and all existing members.
 *
 * Idempotent: if the member is already active, returns the current user id.
 */
export async function activateProspectiveMember(
  db: Db,
  deps: EntryDeps,
  memberId: string,
): Promise<{ user_id: string }> {
  const memberRes = await db.query(
    `SELECT id, code, full_name, status FROM members WHERE id = $1 FOR UPDATE`,
    [memberId],
  );
  const member = memberRes.rows[0] as
    | { id: string; code: string; full_name: string; status: string }
    | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');
  if (member.status === 'active') {
    const existing = await db.query(`SELECT id FROM users WHERE member_id = $1`, [memberId]);
    const userId = (existing.rows[0] as { id: string } | undefined)?.id;
    if (!userId) throw conflict('entry.active_without_user', 'Active member has no user row');
    return { user_id: userId };
  }
  if (member.status !== 'prospective') {
    throw conflict('entry.not_prospective', `Member status is ${member.status}, expected prospective`);
  }

  const tomorrow = addDays(deps.clock.todayDhaka(), 1);
  const quoteRow = await db.query(
    `SELECT proposal_id, shares
     FROM entry_quotes WHERE member_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [memberId],
  );
  const shares = (quoteRow.rows[0] as { shares: number; proposal_id: string } | undefined)?.shares ?? 0;
  const entryProposalId = (quoteRow.rows[0] as { shares: number; proposal_id: string } | undefined)?.proposal_id;

  const entryDue = await db.query(
    `SELECT d.id, d.amount_paisa, v.status, v.outstanding_paisa
     FROM dues d JOIN v_due_status v ON v.due_id = d.id
     WHERE d.member_id = $1 AND d.kind = 'entry'
     ORDER BY d.created_at DESC LIMIT 1`,
    [memberId],
  );
  const due = entryDue.rows[0] as
    | { id: string; amount_paisa: unknown; status: string; outstanding_paisa: unknown }
    | undefined;
  if (!due) {
    throw badRequest('entry.no_entry_due', 'No entry due exists for this member');
  }
  if (toBigInt(due.outstanding_paisa) !== 0n) {
    throw badRequest('entry.due_unpaid', 'The entry due is not fully paid');
  }

  await db.query(
    `UPDATE members SET status = 'active' WHERE id = $1`,
    [memberId],
  );
  await db.query(
    `INSERT INTO member_status_events (member_id, from_status, to_status, reason)
     VALUES ($1, 'prospective', 'active', 'Entry payment fully paid')`,
    [memberId],
  );

  // Share holdings start tomorrow so the NAV/share calculation for the quote is not distorted today.
  await db.query(
    `INSERT INTO share_holdings (member_id, shares, effective_from, source, proposal_id)
     VALUES ($1, $2, $3::date, 'entry', $4)`,
    [memberId, shares, tomorrow, entryProposalId ?? null],
  );

  const userRes = await db.query<{ id: string }>(
    `INSERT INTO users (member_id, roles, status)
     VALUES ($1, ARRAY['member'], 'active')
     ON CONFLICT (member_id) DO UPDATE SET status = 'active'
     RETURNING id`,
    [memberId],
  );
  const userId = userRes.rows[0]!.id;

  const existingMembers = await db.query<{ id: string; code: string; full_name: string }>(
    `SELECT id, code, full_name FROM members WHERE id <> $1`,
    [memberId],
  );

  const ndeps = { pool: deps.pool, clock: deps.clock, log: deps.log, pushSender: deps.pushSender, smsProvider: deps.smsProvider };
  await notifyMember(ndeps, db, {
    memberId,
    template: 'member_onboarded',
    vars: {
      name: member.full_name,
      shares: String(shares),
      code: member.code,
    },
    dedupeLabel: memberId,
  });

  for (const other of existingMembers.rows) {
    await notifyMember(ndeps, db, {
      memberId: other.id,
      template: 'member_onboarded',
      vars: {
        name: member.full_name,
        shares: String(shares),
        code: member.code,
      },
      dedupeLabel: `${memberId}:${other.id}`,
    });
  }

  await audit(db, {
    actor: null,
    action: 'entry.activated',
    entityType: 'member',
    entityId: memberId,
    after: {
      user_id: userId,
      shares,
      effective_from: tomorrow,
      entry_due_id: due.id,
      entry_due_amount_paisa: paisaOut(due.amount_paisa),
    },
  });

  return { user_id: userId };
}
