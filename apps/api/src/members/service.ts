import type pg from 'pg';
import type { Clock, MemberContactUpdate, MemberListQuery, MemberPhoto, MemberUpdate } from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { paisaOut } from '../lib/money';
import { inTransaction, type Db } from '../lib/tx';

export interface MemberDeps {
  pool: pg.Pool;
  clock: Clock;
}

export interface ClientCtx {
  ip?: string | undefined;
}

/** Phone numbers are for the cashier and auditor, and for the member themselves (spec 19.1). */
export const canSeePhones = (viewer: AuthUser): boolean =>
  viewer.roles.includes('cashier') || viewer.roles.includes('auditor');

const canSeePhoneOf = (viewer: AuthUser, memberId: string): boolean =>
  canSeePhones(viewer) || viewer.member_id === memberId;

/** Payment detail (TrxID, note, rejection reason) is for the payer, cashier and auditor (spec 7). */
const canSeePaymentDetail = canSeePhoneOf;

const MEMBER_COLUMNS = `m.id, m.code, m.full_name, m.status, m.photo_file_id, m.phone,
  m.joined_on::text AS joined_on, m.suspended_on::text AS suspended_on, m.exited_on::text AS exited_on`;

interface MemberRow {
  id: string;
  code: string;
  full_name: string;
  status: string;
  photo_file_id: string | null;
  phone: string;
  joined_on: string;
  suspended_on: string | null;
  exited_on: string | null;
}

/** The profile fields every member may see; `phone` is null unless the viewer may see it. */
function publicMember(row: MemberRow, viewer: AuthUser) {
  return {
    id: row.id,
    code: row.code,
    full_name: row.full_name,
    status: row.status,
    photo_file_id: row.photo_file_id,
    phone: canSeePhoneOf(viewer, row.id) ? row.phone : null,
    joined_on: row.joined_on,
    suspended_on: row.suspended_on,
    exited_on: row.exited_on,
  };
}

// ---- reads --------------------------------------------------------------------------------

/**
 * Everyone's standing at a glance (spec 7: list with shares and payment-status summary).
 * `current_period_status` is the status of the member's monthly due for the current Asia/Dhaka period,
 * or null when they have none (not a member yet, suspended, ...).
 */
export async function listMembers(
  deps: MemberDeps,
  viewer: AuthUser,
  q: MemberListQuery,
): Promise<{ items: unknown[] }> {
  const today = deps.clock.todayDhaka();
  const res = await deps.pool.query(
    `SELECT ${MEMBER_COLUMNS},
            shares_on(m.id, $1::date) AS shares,
            COALESCE(b.capital_paisa, 0) AS capital_paisa,
            COALESCE(du.outstanding_principal_paisa, 0) AS outstanding_principal_paisa,
            COALESCE(du.overdue_paisa, 0) AS overdue_paisa,
            COALESCE(du.overdue_count, 0)::int AS overdue_count,
            COALESCE(fi.outstanding_fines_paisa, 0) AS outstanding_fines_paisa,
            cur.status AS current_period_status,
            EXISTS (SELECT 1 FROM payments p WHERE p.member_id = m.id AND p.status = 'pending')
              AS under_verification,
            -- A member stays in their status until the settlement is fully paid (members/settlement.ts),
            -- so screens use this to show them as leaving.
            (SELECT s.status FROM settlements s WHERE s.member_id = m.id AND s.status <> 'completed'
              ORDER BY s.created_at DESC LIMIT 1) AS settlement_status
     FROM members m
     LEFT JOIN v_member_balances b ON b.member_id = m.id
     LEFT JOIN LATERAL (
       SELECT SUM(GREATEST(outstanding_paisa, 0)) AS outstanding_principal_paisa,
              SUM(GREATEST(outstanding_paisa, 0)) FILTER (WHERE status = 'overdue') AS overdue_paisa,
              COUNT(*) FILTER (WHERE status = 'overdue') AS overdue_count
       FROM v_due_status WHERE member_id = m.id
     ) du ON true
     LEFT JOIN LATERAL (
       SELECT SUM(GREATEST(outstanding_paisa, 0)) AS outstanding_fines_paisa
       FROM v_fine_status WHERE member_id = m.id
     ) fi ON true
     LEFT JOIN LATERAL (
       SELECT status FROM v_due_status
       WHERE member_id = m.id AND kind = 'monthly' AND period = $2
     ) cur ON true
     WHERE ($3::text IS NULL OR m.status = $3)
     ORDER BY m.code`,
    [today, today.slice(0, 7), q.status ?? null],
  );

  type Row = MemberRow & Record<string, unknown>;
  return {
    items: (res.rows as Row[]).map((row) => ({
      ...publicMember(row, viewer),
      shares: row['shares'],
      capital_paisa: paisaOut(row['capital_paisa']),
      outstanding_principal_paisa: paisaOut(row['outstanding_principal_paisa']),
      // past the due date and unpaid: what the member is behind on now (outstanding_principal also
      // counts dues generated ahead of time that are not due yet)
      overdue_paisa: paisaOut(row['overdue_paisa']),
      outstanding_fines_paisa: paisaOut(row['outstanding_fines_paisa']),
      overdue_count: row['overdue_count'],
      current_period: today.slice(0, 7),
      current_period_status: row['current_period_status'],
      under_verification: row['under_verification'],
      settlement_status: row['settlement_status'] ?? null,
    })),
  };
}

/** Rows shown in a member's detail before "see all" (the full lists have their own endpoints). */
const DETAIL_LIMIT = 100;

/**
 * One member in full: profile, share holdings and register entries, dues, fines, payments and ledger
 * rows (spec 7). Raw SMS and proof images are never part of this response; TrxID, note and rejection
 * reason are shown to the payer, cashier and auditor only.
 */
export async function getMember(
  deps: MemberDeps,
  viewer: AuthUser,
  memberId: string,
): Promise<Record<string, unknown>> {
  const today = deps.clock.todayDhaka();
  const memberRes = await deps.pool.query(
    `SELECT ${MEMBER_COLUMNS}, shares_on(m.id, $2::date) AS shares,
            COALESCE(b.capital_paisa, 0) AS capital_paisa
     FROM members m LEFT JOIN v_member_balances b ON b.member_id = m.id
     WHERE m.id = $1`,
    [memberId, today],
  );
  const member = memberRes.rows[0] as (MemberRow & Record<string, unknown>) | undefined;
  if (!member) throw notFound('member.not_found', 'Member not found');

  const [holdings, register, dues, fines, payments, ledger] = await Promise.all([
    deps.pool.query(
      `SELECT id, shares, effective_from::text AS effective_from, effective_to::text AS effective_to, source
       FROM share_holdings WHERE member_id = $1 ORDER BY effective_from DESC, id`,
      [memberId],
    ),
    deps.pool.query(
      `SELECT share_no, registered_name, nominee_name, nominee_relation
       FROM share_register WHERE member_id = $1 ORDER BY share_no`,
      [memberId],
    ),
    deps.pool.query(
      `SELECT v.due_id AS id, v.period, v.kind, v.shares_snapshot, v.amount_paisa, v.allocated_paisa,
              v.outstanding_paisa, v.due_date::text AS due_date, v.status
       FROM v_due_status v WHERE v.member_id = $1 ORDER BY v.due_date DESC, v.due_id DESC`,
      [memberId],
    ),
    deps.pool.query(
      `SELECT f.id, f.due_id, f.kind, f.reason, s.amount_paisa, s.allocated_paisa, s.outstanding_paisa,
              f.waived_at, f.created_at
       FROM fines f JOIN v_fine_status s ON s.fine_id = f.id
       WHERE f.member_id = $1 ORDER BY f.created_at DESC, f.id DESC`,
      [memberId],
    ),
    deps.pool.query(
      `SELECT id, amount_paisa, method, purpose, status, source, paid_at, submitted_at, confirmed_at,
              trx_id, note, reject_reason
       FROM payments WHERE member_id = $1 ORDER BY paid_at DESC, id DESC LIMIT $2`,
      [memberId, DETAIL_LIMIT + 1],
    ),
    deps.pool.query(
      `SELECT seq, entry_date::text AS entry_date, debit_account, credit_account, amount_paisa,
              ref_type, ref_id, memo, hash
       FROM ledger_entries WHERE member_id = $1 ORDER BY seq DESC LIMIT $2`,
      [memberId, DETAIL_LIMIT + 1],
    ),
  ]);

  const showPaymentDetail = canSeePaymentDetail(viewer, memberId);
  const paymentRows = payments.rows as Array<Record<string, unknown>>;
  const ledgerRows = ledger.rows as Array<Record<string, unknown>>;

  return {
    ...publicMember(member, viewer),
    shares: member['shares'],
    capital_paisa: paisaOut(member['capital_paisa']),
    share_holdings: holdings.rows,
    share_register: register.rows,
    dues: (dues.rows as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      amount_paisa: paisaOut(r['amount_paisa']),
      allocated_paisa: paisaOut(r['allocated_paisa']),
      outstanding_paisa: paisaOut(r['outstanding_paisa']),
    })),
    fines: (fines.rows as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      amount_paisa: paisaOut(r['amount_paisa']),
      allocated_paisa: paisaOut(r['allocated_paisa']),
      outstanding_paisa: paisaOut(r['outstanding_paisa']),
    })),
    payments: {
      items: paymentRows.slice(0, DETAIL_LIMIT).map((r) => {
        const { trx_id, note, reject_reason, ...rest } = r;
        return {
          ...rest,
          amount_paisa: paisaOut(r['amount_paisa']),
          ...(showPaymentDetail ? { trx_id, note, reject_reason } : {}),
        };
      }),
      has_more: paymentRows.length > DETAIL_LIMIT,
    },
    ledger: {
      items: ledgerRows.slice(0, DETAIL_LIMIT).map((r) => ({
        ...r,
        amount_paisa: paisaOut(r['amount_paisa']),
        seq: String(r['seq']),
      })),
      has_more: ledgerRows.length > DETAIL_LIMIT,
    },
  };
}

// ---- share register and holdings ------------------------------------------------------------

/** The informational register: one row per share with its registered name and nominee. */
export async function listShareRegister(db: Db): Promise<{ items: unknown[]; total: number }> {
  const res = await db.query(
    `SELECT r.share_no, r.member_id, m.code AS member_code, m.full_name AS member_name,
            r.registered_name, r.nominee_name, r.nominee_relation
     FROM share_register r JOIN members m ON m.id = r.member_id
     ORDER BY r.share_no`,
  );
  return { items: res.rows, total: res.rows.length };
}

/**
 * Share holdings. By default the holdings in force on `as_of` (today if omitted) with the total;
 * with `history` every holding row, including ended ones (the total is then null).
 * A holding is in force from `effective_from` up to, not including, `effective_to`.
 */
export async function listShareHoldings(
  deps: MemberDeps,
  q: { member_id?: string | undefined; as_of?: string | undefined; history?: boolean | undefined },
): Promise<{ as_of: string | null; items: unknown[]; total_shares: number | null }> {
  const asOf = q.as_of ?? deps.clock.todayDhaka();
  const history = q.history === true;
  const res = await deps.pool.query(
    `SELECT h.id, h.member_id, m.code AS member_code, m.full_name AS member_name, h.shares,
            h.effective_from::text AS effective_from, h.effective_to::text AS effective_to, h.source
     FROM share_holdings h JOIN members m ON m.id = h.member_id
     WHERE ($1::uuid IS NULL OR h.member_id = $1)
       AND ($2::boolean OR (h.effective_from <= $3::date AND (h.effective_to IS NULL OR h.effective_to > $3::date)))
     ORDER BY m.code, h.effective_from, h.id`,
    [q.member_id ?? null, history, asOf],
  );
  const rows = res.rows as Array<{ shares: number }>;
  return {
    as_of: history ? null : asOf,
    items: rows,
    total_shares: history ? null : rows.reduce((sum, r) => sum + r.shares, 0),
  };
}

// ---- writes ---------------------------------------------------------------------------------

type NotifyPrefs = { push?: boolean; sms?: boolean; digits?: 'bn' | 'en' };

/**
 * A photo must be an image the caller uploaded. A file they did not upload is the same as a missing
 * one, or they could publish someone else's payment proof by guessing its id.
 */
async function assertOwnImage(tx: Db, fileId: string, userId: string): Promise<void> {
  const file = await tx.query(`SELECT mime, created_by FROM files WHERE id = $1`, [fileId]);
  const row = file.rows[0] as { mime: string; created_by: string | null } | undefined;
  if (!row || row.created_by !== userId) throw notFound('file.not_found', 'File not found');
  if (!row.mime.startsWith('image/')) {
    throw badRequest('member.photo_not_image', 'The photo must be an image');
  }
}

/**
 * `PATCH /members/me`: photo and notification preferences. Preferences are merged key by key, so
 * sending `{digits:'en'}` leaves push and sms alone. Open to every logged-in member, including
 * read-only (suspended) ones: it changes how the app talks to them, not any fund record.
 */
export async function updateOwnProfile(
  deps: MemberDeps,
  user: AuthUser,
  input: MemberUpdate,
  ctx: ClientCtx,
): Promise<{ id: string; photo_file_id: string | null; notify_prefs: NotifyPrefs }> {
  const prefs = Object.fromEntries(
    Object.entries(input.notify_prefs ?? {}).filter(([, v]) => v !== undefined),
  ) as NotifyPrefs;
  if (input.photo_file_id === undefined && Object.keys(prefs).length === 0) {
    throw badRequest('member.nothing_to_update', 'Nothing to update');
  }

  return inTransaction(deps.pool, async (tx) => {
    const cur = await tx.query(
      `SELECT photo_file_id, notify_prefs FROM members WHERE id = $1 FOR UPDATE`,
      [user.member_id],
    );
    const before = cur.rows[0] as { photo_file_id: string | null; notify_prefs: NotifyPrefs };

    if (input.photo_file_id) await assertOwnImage(tx, input.photo_file_id, user.id);

    const photo = input.photo_file_id === undefined ? before.photo_file_id : input.photo_file_id;
    const notify = { ...before.notify_prefs, ...prefs };
    await tx.query(`UPDATE members SET photo_file_id = $2, notify_prefs = $3 WHERE id = $1`, [
      user.member_id,
      photo,
      JSON.stringify(notify),
    ]);

    await audit(tx, {
      actor: user.id,
      action: 'member.update_profile',
      entityType: 'member',
      entityId: user.member_id,
      before: { photo_file_id: before.photo_file_id, notify_prefs: before.notify_prefs },
      after: { photo_file_id: photo, notify_prefs: notify },
      ip: ctx.ip,
      deviceId: user.device_id,
    });

    return { id: user.member_id, photo_file_id: photo, notify_prefs: notify };
  });
}

/**
 * `PUT /members/:id/photo` (cashier): add a photo for a member who cannot do it themselves, or take
 * down one that should not be there. The image must be one the cashier uploaded; the audit row keeps
 * the old and new file, so a member can always see who changed their photo.
 */
export async function setMemberPhoto(
  deps: MemberDeps,
  actor: AuthUser,
  memberId: string,
  input: MemberPhoto,
  ctx: ClientCtx,
): Promise<{ id: string; photo_file_id: string | null }> {
  return inTransaction(deps.pool, async (tx) => {
    const cur = await tx.query(`SELECT photo_file_id FROM members WHERE id = $1 FOR UPDATE`, [memberId]);
    const before = cur.rows[0] as { photo_file_id: string | null } | undefined;
    if (!before) throw notFound('member.not_found', 'Member not found');
    if (input.photo_file_id) await assertOwnImage(tx, input.photo_file_id, actor.id);

    await tx.query(`UPDATE members SET photo_file_id = $2 WHERE id = $1`, [memberId, input.photo_file_id]);
    await audit(tx, {
      actor: actor.id,
      action: 'member.set_photo',
      entityType: 'member',
      entityId: memberId,
      before: { photo_file_id: before.photo_file_id },
      after: { photo_file_id: input.photo_file_id },
      ip: ctx.ip,
      deviceId: actor.device_id,
    });

    return { id: memberId, photo_file_id: input.photo_file_id };
  });
}

/**
 * `PATCH /members/:id/contact` (cashier): correct a member's name or phone. The audit row keeps the
 * old and new values, which is the control against quietly redirecting someone's contact details.
 */
export async function updateMemberContact(
  deps: MemberDeps,
  actor: AuthUser,
  memberId: string,
  input: MemberContactUpdate,
  ctx: ClientCtx,
): Promise<{ id: string; code: string; full_name: string; phone: string }> {
  if (input.phone === undefined && input.full_name === undefined) {
    throw badRequest('member.nothing_to_update', 'Nothing to update');
  }

  return inTransaction(deps.pool, async (tx) => {
    const cur = await tx.query(
      `SELECT id, code, full_name, phone FROM members WHERE id = $1 FOR UPDATE`,
      [memberId],
    );
    const before = cur.rows[0] as
      { id: string; code: string; full_name: string; phone: string } | undefined;
    if (!before) throw notFound('member.not_found', 'Member not found');

    const next = {
      full_name: input.full_name ?? before.full_name,
      phone: input.phone ?? before.phone,
    };
    try {
      await tx.query(`UPDATE members SET full_name = $2, phone = $3 WHERE id = $1`, [
        memberId,
        next.full_name,
        next.phone,
      ]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('member.phone_taken', 'Another member already has this phone number');
      }
      throw err;
    }

    await audit(tx, {
      actor: actor.id,
      action: 'member.update_contact',
      entityType: 'member',
      entityId: memberId,
      before: { full_name: before.full_name, phone: before.phone },
      after: next,
      ip: ctx.ip,
      deviceId: actor.device_id,
    });

    return { id: before.id, code: before.code, ...next };
  });
}
