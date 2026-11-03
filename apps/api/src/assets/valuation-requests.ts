import { randomUUID } from 'node:crypto';
import {
  bn,
  formatBDT,
  splitByCost,
  validateProposalPayload,
  valuationVoteReason,
  type Clock,
  type ValuationRequestInput,
} from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { inTransaction, type Db } from '../lib/tx';
import type pg from 'pg';
import { queueMembersAlert, queueRoleAlert } from '../notifications/role-alert';
import { openProposalTx } from '../proposals/service';

export interface ValuationDeps {
  pool: pg.Pool;
  clock: Clock;
}

interface ClientCtx {
  ip?: string | undefined;
}

/** How long the members' vote on a fall (or a large rise) stays open (owner decision, ASSUMPTIONS 115). */
const VOTE_DAYS = 3;

const money = (paisa: bigint): string => `৳${formatBDT(paisa, { digits: 'bn' })}`;

/**
 * What the shop is worth now, the way its page and NAV count it: every purchase not sold at its
 * latest valuation, or at cost if never valued. Ordered like the page, so the split is reproducible.
 */
export async function partnerValue(db: Db, partnerId: string): Promise<{ assets: Array<{ id: string; cost_paisa: string }>; value: bigint }> {
  const res = await db.query(
    `SELECT a.id, a.cost_paisa::text AS cost_paisa,
            COALESCE((SELECT v.value_paisa FROM asset_valuations v WHERE v.asset_id = a.id
                      ORDER BY v.as_of DESC, v.created_at DESC LIMIT 1), a.cost_paisa)::text AS value_paisa
     FROM assets a
     WHERE a.partner_id = $1 AND a.status <> 'sold'
     ORDER BY a.acquired_on NULLS LAST, a.created_at`,
    [partnerId],
  );
  const rows = res.rows as Array<{ id: string; cost_paisa: string; value_paisa: string }>;
  return { assets: rows, value: rows.reduce((s, r) => s + BigInt(r.value_paisa), 0n) };
}

async function auditorMemberIds(db: Db): Promise<string[]> {
  const res = await db.query(`SELECT member_id FROM users WHERE 'auditor' = ANY (roles) AND status <> 'disabled'`);
  return (res.rows as Array<{ member_id: string }>).map((r) => r.member_id);
}

async function activeMemberIds(db: Db): Promise<string[]> {
  const res = await db.query(`SELECT id FROM members WHERE status IN ('active', 'warning')`);
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

/** Which way an update goes: the auditor, or the members' vote (see `valuationVoteReason`). */
export function valuationRoute(input: { base: bigint; next: bigint; concernsAuditor: boolean; hasAuditor: boolean }): 'auditor' | 'vote' {
  return valuationVoteReason(input) === null ? 'auditor' : 'vote';
}

/**
 * `POST /partners/:id/valuation-requests`: the member who looks after the shop, or the cashier, sends
 * its new total value with the shop's statement. Nothing changes in NAV here: a rise waits for the
 * auditor (an `approvals` row), anything else opens a `valuation_update` vote for three days. One
 * update per shop can be waiting at a time.
 */
export async function submitValuationRequest(
  deps: ValuationDeps,
  actor: AuthUser,
  partnerId: string,
  input: ValuationRequestInput,
  ctx: ClientCtx,
): Promise<{ id: string; route: 'auditor' | 'vote'; approval_id: string | null; proposal_id: string | null }> {
  return inTransaction(deps.pool, async (db) => {
    const pres = await db.query(`SELECT id, name, custodian_member_id FROM investment_partners WHERE id = $1 FOR UPDATE`, [partnerId]);
    const partner = pres.rows[0] as { id: string; name: string; custodian_member_id: string | null } | undefined;
    if (!partner) throw notFound('partner.not_found', 'Investment partner not found');

    const isCashier = actor.roles.includes('cashier');
    if (!isCashier && partner.custodian_member_id !== actor.member_id) {
      throw forbidden('valuation.not_responsible', 'Only the member who looks after this investment, or the cashier, can send its value');
    }
    if (input.as_of > deps.clock.todayDhaka()) throw badRequest('valuation.future_date', 'The value date cannot be in the future');

    const file = await db.query(`SELECT created_by FROM files WHERE id = $1`, [input.proof_file_id]);
    const uploadedBy = (file.rows[0] as { created_by: string | null } | undefined)?.created_by;
    if (file.rowCount === 0) throw badRequest('valuation.proof_missing', 'Attach the shop statement');
    if (uploadedBy !== actor.id && !isCashier) throw forbidden('valuation.proof_not_yours', 'Attach a statement you uploaded');

    const waiting = await db.query(
      `SELECT 1 FROM valuation_requests r
       LEFT JOIN approvals a ON r.route = 'auditor' AND a.kind = 'valuation_update' AND a.ref_id = r.id::text
       LEFT JOIN proposals p ON p.id = r.proposal_id
       WHERE r.partner_id = $1 AND (a.status = 'pending' OR p.status IN ('draft', 'open', 'approved'))`,
      [partnerId],
    );
    if ((waiting.rowCount ?? 0) > 0) throw conflict('valuation.already_pending', 'An update for this investment is already waiting');

    const { assets, value: base } = await partnerValue(db, partnerId);
    const items = splitByCost(input.new_value_paisa, assets);
    if (items.length === 0) throw badRequest('valuation.nothing_to_value', 'This investment has no purchase to value');

    const auditors = await auditorMemberIds(db);
    const concernsAuditor =
      actor.roles.includes('auditor') || (partner.custodian_member_id !== null && auditors.includes(partner.custodian_member_id));
    const route = valuationRoute({ base, next: input.new_value_paisa, concernsAuditor, hasAuditor: auditors.length > 0 });

    const id = randomUUID();
    const itemRows = items.map((i) => ({ asset_id: i.asset_id, value_paisa: i.value_paisa.toString() }));
    let approvalId: string | null = null;
    let proposalId: string | null = null;
    const vars = { partner: partner.name, old_value: money(base), new_value: money(input.new_value_paisa), by: actor.member_code };

    if (route === 'auditor') {
      const ins = await db.query(
        `INSERT INTO approvals (kind, ref_id, requested_by, reason) VALUES ('valuation_update', $1, $2, $3) RETURNING id`,
        [id, actor.id, input.note ?? null],
      );
      approvalId = (ins.rows[0] as { id: string }).id;
      await queueRoleAlert(db, deps.clock, ['auditor'], 'valuation_review', vars, id);
    } else {
      // The same proposal the value button used to create, opened at once for three days.
      const payload = {
        items: itemRows.map((i) => ({ ...i, as_of: input.as_of, ...(input.note ? { basis: input.note } : {}) })),
        request_id: id,
      };
      if (!validateProposalPayload('valuation_update', payload).success) throw badRequest('proposal.invalid_payload', 'Invalid value update');
      const title = (bn as unknown as { holding: { valueProposalTitle: string } }).holding.valueProposalTitle.replace('{{name}}', partner.name);
      const ins = await db.query(
        `INSERT INTO proposals (type, title, description, payload, created_by) VALUES ('valuation_update', $1, $2, $3, $4) RETURNING id`,
        [title, input.note ?? null, JSON.stringify(payload), actor.id],
      );
      proposalId = (ins.rows[0] as { id: string }).id;
      await audit(db, { actor: actor.id, action: 'proposal.create', entityType: 'proposal', entityId: proposalId, after: { type: 'valuation_update', title, payload }, ip: ctx.ip, deviceId: actor.device_id });
      await openProposalTx(db, deps.clock, actor, proposalId, new Date(deps.clock.now().getTime() + VOTE_DAYS * 86_400_000), { ...ctx, user: actor });
    }

    await db.query(
      `INSERT INTO valuation_requests (id, partner_id, base_value_paisa, new_value_paisa, as_of, note, proof_file_id, items, route, proposal_id, requested_by)
       VALUES ($1, $2, $3::bigint, $4::bigint, $5::date, $6, $7, $8, $9, $10, $11)`,
      [id, partnerId, base.toString(), input.new_value_paisa.toString(), input.as_of, input.note ?? null, input.proof_file_id, JSON.stringify(itemRows), route, proposalId, actor.id],
    );
    await audit(db, {
      actor: actor.id,
      action: 'valuation.request',
      entityType: 'partner',
      entityId: partnerId,
      after: { request_id: id, base_value_paisa: base.toString(), new_value_paisa: input.new_value_paisa.toString(), as_of: input.as_of, route, approval_id: approvalId, proposal_id: proposalId },
      ip: ctx.ip,
      deviceId: actor.device_id,
    });
    return { id, route, approval_id: approvalId, proposal_id: proposalId };
  });
}

interface RequestRow {
  id: string;
  partner_id: string;
  partner_name: string;
  base_value_paisa: string;
  new_value_paisa: string;
  as_of: string;
  note: string | null;
  items: Array<{ asset_id: string; value_paisa: string }>;
  requested_by_member_id: string | null;
}

async function loadRequest(db: Db, id: string): Promise<RequestRow> {
  const res = await db.query(
    `SELECT r.id, r.partner_id, ip.name AS partner_name, r.base_value_paisa::text AS base_value_paisa,
            r.new_value_paisa::text AS new_value_paisa, r.as_of::text AS as_of, r.note, r.items,
            u.member_id AS requested_by_member_id
     FROM valuation_requests r
     JOIN investment_partners ip ON ip.id = r.partner_id
     LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.id = $1`,
    [id],
  );
  const row = res.rows[0] as RequestRow | undefined;
  if (!row) throw notFound('valuation.not_found', 'Value update not found');
  return row;
}

/**
 * The auditor approves a rise (called from `approveApproval`, inside its transaction, after the
 * approval row is locked and the self-decision check). The shop's value must still be what it was
 * when the update was sent; otherwise the auditor declines it and the member sends a fresh one.
 */
export async function applyApprovedValuation(
  db: Db,
  clock: Clock,
  actor: AuthUser,
  approval: { id: string; ref_id: string },
  note: string | undefined,
  ctx: ClientCtx,
): Promise<{ valuation_ids: string[] }> {
  const r = await loadRequest(db, approval.ref_id);
  await db.query(`SELECT 1 FROM investment_partners WHERE id = $1 FOR UPDATE`, [r.partner_id]);
  const { value } = await partnerValue(db, r.partner_id);
  if (value !== BigInt(r.base_value_paisa)) {
    throw conflict('valuation.base_changed', 'The value of this investment changed after the update was sent; decline it and send a new one');
  }
  const ids: string[] = [];
  for (const item of r.items) {
    const ins = await db.query(
      `INSERT INTO asset_valuations (asset_id, value_paisa, as_of, basis, approval_id) VALUES ($1, $2::bigint, $3::date, $4, $5) RETURNING id`,
      [item.asset_id, item.value_paisa, r.as_of, r.note, approval.id],
    );
    ids.push((ins.rows[0] as { id: string }).id);
  }
  await db.query(`UPDATE approvals SET status = 'approved', decided_by = $2, decided_at = $3, decision_note = $4 WHERE id = $1`, [approval.id, actor.id, clock.now(), note ?? null]);
  await audit(db, {
    actor: actor.id,
    action: 'valuation.approve',
    entityType: 'partner',
    entityId: r.partner_id,
    after: { request_id: r.id, approval_id: approval.id, new_value_paisa: r.new_value_paisa, valuation_ids: ids, note: note ?? null },
    ip: ctx.ip,
    deviceId: actor.device_id,
  });
  await queueMembersAlert(db, clock, await activeMemberIds(db), 'valuation_updated', {
    partner: r.partner_name,
    old_value: money(BigInt(r.base_value_paisa)),
    new_value: money(BigInt(r.new_value_paisa)),
  }, r.id);
  return { valuation_ids: ids };
}

/** The auditor declines: the reason is required and the sender is told it. */
export async function notifyValuationRejected(db: Db, clock: Clock, requestId: string, reason: string): Promise<void> {
  const r = await loadRequest(db, requestId);
  if (r.requested_by_member_id) {
    await queueMembersAlert(db, clock, [r.requested_by_member_id], 'valuation_rejected', { partner: r.partner_name, reason }, r.id);
  }
}
