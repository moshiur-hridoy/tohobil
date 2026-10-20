import { badRequest, conflict, notFound } from '../../lib/errors';
import { toBigInt } from '../../lib/money';
import type { ExecutorSignature } from './shared';
import { serialised } from './shared';

export const valuationUpdateExecutor: ExecutorSignature = async (db, proposal) => {
  const payload = proposal.payload as {
    items: Array<{ asset_id: string; value_paisa: string; basis?: string; as_of: string }>;
  };
  const ids: string[] = [];
  for (const item of payload.items) {
    const res = await db.query(
      `INSERT INTO asset_valuations (asset_id, value_paisa, as_of, basis, proposal_id)
       VALUES ($1, $2::bigint, $3::date, $4, $5)
       RETURNING id`,
      [item.asset_id, toBigInt(item.value_paisa).toString(), item.as_of, item.basis ?? null, proposal.id],
    );
    ids.push((res.rows[0] as { id: string }).id);
  }
  return serialised({ valuation_ids: ids });
};

export const ruleChangeExecutor: ExecutorSignature = async (db, proposal) => {
  const payload = proposal.payload as {
    key: string;
    value: unknown;
    valid_from: string;
    clause_ref?: string;
  };
  const res = await db.query(
    `INSERT INTO rules (key, value, valid_from, clause_ref, proposal_id)
     VALUES ($1, $2, $3::date, $4, $5)
     RETURNING id`,
    [payload.key, JSON.stringify(payload.value), payload.valid_from, payload.clause_ref ?? null, proposal.id],
  );
  return serialised({ rule_id: (res.rows[0] as { id: string }).id });
};

export const constitutionAmendmentExecutor: ExecutorSignature = async (db, proposal, _input, _actor, _ctx, _deps) => {
  const payload = proposal.payload as {
    version: string;
    file_id: string;
    effective_from: string;
    summary: string;
  };

  const existing = await db.query(`SELECT 1 FROM constitution_versions WHERE version = $1`, [payload.version]);
  if ((existing.rowCount ?? 0) > 0) {
    throw conflict('constitution.version_exists', `Version ${payload.version} already exists`);
  }

  const versionRes = await db.query(
    `INSERT INTO constitution_versions (version, file_id, effective_from, proposal_id)
     VALUES ($1, $2, $3::date, $4)
     RETURNING id`,
    [payload.version, payload.file_id, payload.effective_from, proposal.id],
  );
  const versionId = (versionRes.rows[0] as { id: string }).id;

  // Notify every active/warning member of a new constitution version.
  const members = (await db.query(
    `SELECT m.id FROM members m
     JOIN users u ON u.member_id = m.id
     WHERE m.status IN ('active','warning') AND u.status = 'active'`,
  )).rows as Array<{ id: string }>;
  for (const member of members) {
    await db.query(
      `INSERT INTO notifications (member_id, template, channel, payload, dedupe_key)
       VALUES ($1, 'constitution_published', 'push', $2, $3)`,
      [
        member.id,
        JSON.stringify({ version_id: versionId, version: payload.version, effective_from: payload.effective_from, summary: payload.summary }),
        `constitution:${versionId}:${member.id}`,
      ],
    );
  }

  return serialised({
    version_id: versionId,
    version: payload.version,
    effective_from: payload.effective_from,
    notified_members: members.length,
  });
};

export const roleChangeExecutor: ExecutorSignature = async (db, proposal, _input, actor) => {
  const payload = proposal.payload as { role: 'cashier' | 'auditor'; member_id: string };
  const role = payload.role;

  const targetRes = await db.query(
    `SELECT u.id, u.status FROM users u JOIN members m ON m.id = u.member_id WHERE m.id = $1`,
    [payload.member_id],
  );
  const target = targetRes.rows[0] as { id: string; status: string } | undefined;
  if (!target) throw notFound('member.not_found', `Member ${payload.member_id} not found`);
  if (target.status !== 'active') {
    throw badRequest('role_change.target_inactive', 'The new role holder must have an active user account');
  }

  // Find the current privileged holder. The unique partial index ensures at most one row matches.
  const currentRes = await db.query(
    `SELECT id FROM users WHERE $1 = ANY(roles) AND status <> 'disabled'`,
    [role],
  );
  const current = currentRes.rows[0] as { id: string } | undefined;

  if (!current || current.id !== target.id) {
    if (current) {
      await db.query(`UPDATE users SET roles = array_remove(roles, $1) WHERE id = $2`, [role, current.id]);
    }
    await db.query(
      `UPDATE users SET roles = (
        SELECT array_agg(DISTINCT x)
        FROM unnest(roles || ARRAY[$1::text]) AS x
       ) WHERE id = $2`,
      [role, target.id],
    );
  }

  return serialised({
    role,
    previous_holder_user_id: current?.id ?? null,
    new_holder_user_id: target.id,
    executed_by_user_id: actor.id,
  });
};
