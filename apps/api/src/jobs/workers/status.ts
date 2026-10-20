import type { JobDeps } from '../index';
import { inTransaction } from '../../lib/tx';
import { ruleBool, ruleInt } from '../../lib/rules';
import {
  computeConsecutiveUnpaidMonths,
  issueFinalNotice,
  suspendMember,
  transitionMemberStatus,
  type StatusDeps,
} from '../../members/status';
import { audit } from '../../lib/audit';

export async function statusJob(deps: JobDeps): Promise<void> {
  const today = deps.clock.todayDhaka();
  const ruleAsOf = `${today.slice(0, 7)}-01`;
  const now = deps.clock.now();

  const warningAfter = await ruleInt(deps.pool, 'warning_after_months', ruleAsOf);
  const suspensionAfter = await ruleInt(deps.pool, 'suspension_after_consecutive_unpaid_months', ruleAsOf);
  const finalNoticeDays = await ruleInt(deps.pool, 'final_notice_days', ruleAsOf);
  const autoSuspend = await ruleBool(deps.pool, 'auto_suspend', ruleAsOf);

  const statusDeps: StatusDeps = {
    pool: deps.pool,
    clock: deps.clock,
    pushSender: deps.pushSender,
    smsProvider: deps.smsProvider,
    log: deps.log,
  };

  const auditor = await findAuditorId(deps.pool);

  await inTransaction(deps.pool, async (db) => {
    // Only active/warning members can enter this flow; suspended/exited are excluded.
    const members = (await db.query(
      `SELECT m.id, m.code, m.full_name, m.status, m.phone
       FROM members m
       WHERE m.status IN ('active', 'warning')
       ORDER BY m.code
       FOR UPDATE OF m`
    )).rows as Array<{
      id: string;
      code: string;
      full_name: string;
      status: string;
      phone: string;
    }>;

    for (const member of members) {
      const consecutive = await computeConsecutiveUnpaidMonths(db, member.id, today);

      // Active member crosses the courtesy warning threshold.
      if (member.status === 'active' && consecutive >= warningAfter) {
        await transitionMemberStatus(
          db,
          member.id,
          'active',
          'warning',
          `${consecutive} consecutive month(s) with outstanding dues or fines`,
          null,
          null,
        );
        await audit(db, {
          actor: null,
          action: 'member.status.warning',
          entityType: 'member',
          entityId: member.id,
          before: { status: 'active' },
          after: { status: 'warning', consecutive_unpaid_months: consecutive },
          ip: undefined,
          deviceId: null,
        });
      }

      // Warning member has hit the suspension threshold -> final notice on first occurrence.
      if (member.status === 'warning' && consecutive >= suspensionAfter) {
        const finalNotice = (await db.query(
          `SELECT scheduled_for FROM notifications
           WHERE member_id = $1 AND template = 'final_notice'
           ORDER BY scheduled_for ASC LIMIT 1`,
          [member.id],
        )).rows[0] as { scheduled_for: Date } | undefined;

        if (!finalNotice) {
          await issueFinalNotice(db, statusDeps, member.id);
        } else {
          const ageMs = now.getTime() - new Date(finalNotice.scheduled_for).getTime();
          if (autoSuspend && ageMs >= finalNoticeDays * 24 * 3600_000) {
            // Auto-suspend: create an executed proposal directly (no vote, see 18.5).
            const proposalRes = await db.query(
              `INSERT INTO proposals
                 (type, title, description, subject_member_id, payload, status,
                  created_by, opens_at, closes_at, basis, threshold_kind,
                  eligible_count, eligible_weight, threshold, threshold_weight,
                  yes_count, yes_weight, finalized_at, executed_at, executed_by,
                  clause_ref)
               VALUES (
                 'suspension', $2, $3, $1, $4, 'executed',
                 $5, now(), now(), 'member', 'majority', 0, 0, 0, 0, 0, 0,
                 now(), now(), $5, '2.4')
               RETURNING id`,
              [
                member.id,
                `Automated suspension of ${member.code}`,
                `Final notice issued ${finalNoticeDays} days ago; arrears remain unpaid. System created and executed under clause 2.4. Any member may open a review vote.`,
                JSON.stringify({
                  member_id: member.id,
                  reason: 'Unpaid arrears after final notice (clause 2.4)',
                }),
                auditor,
              ],
            );
            const proposalId = (proposalRes.rows[0] as { id: string }).id;
            await suspendMember(db, statusDeps, member.id, proposalId, auditor);
          }
        }
      }
    }

    await audit(db, {
      actor: null,
      action: 'job.member_status',
      entityType: 'system',
      entityId: 'member-status',
      after: {
        today,
        warning_after_months: warningAfter,
        suspension_after_consecutive_unpaid_months: suspensionAfter,
        final_notice_days: finalNoticeDays,
        auto_suspend: autoSuspend,
      },
      ip: undefined,
      deviceId: null,
    });
  });
}

async function findAuditorId(pool: JobDeps['pool']): Promise<string | undefined> {
  const res = await pool.query(
    `SELECT u.id FROM users u
     WHERE 'auditor' = ANY(u.roles) AND u.status <> 'disabled'
     ORDER BY u.id LIMIT 1`,
  );
  return (res.rows[0] as { id: string } | undefined)?.id;
}
