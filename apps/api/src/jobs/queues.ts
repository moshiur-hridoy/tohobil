import type PgBoss from 'pg-boss';

/**
 * pg-boss's own queue: every cron schedule is first sent here and forwarded to the real queue. The
 * library tries to create it when it starts, but the app role may not attach its partition and the
 * library swallows that error, so without this queue no scheduled job ever runs (ASSUMPTIONS 136).
 */
export const CRON_QUEUE = '__pgboss__send-it';

/** Create every queue the scheduler needs; run as the role that owns the pg-boss tables. Idempotent. */
export async function createJobQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(CRON_QUEUE);
  for (const name of JOB_QUEUES) await boss.createQueue(name, { name, policy: 'singleton' });
}

/** Every pg-boss queue the scheduler works. `pnpm migrate` creates them as the owning role. */
export const JOB_QUEUES = [
  'send-notifications',
  'finalize-proposals',
  'member-status',
  'generate-dues',
  'apply-fines',
  'remind-dues',
  'notify-fines',
  'pending-payment-alert',
  'cleanup',
  'sms-fallback',
  'generate-rent-expected',
  'verify-ledger',
  'backup-watch',
  'zakat-notice',
  'meeting-draft',
  'meeting-reminders',
] as const;
