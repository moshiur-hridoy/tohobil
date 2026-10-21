import PgBoss from 'pg-boss';
import { JOB_QUEUES } from './queues';
import type pg from 'pg';
import type { Clock } from '@barakah/shared';
import type { Logger } from 'pino';
import type { PushSender } from '../notifications/providers/push';
import type { SmsProvider } from '../notifications/providers/sms';
import type { Env } from '../lib/env';

export interface JobDeps {
  env: Env;
  pool: pg.Pool;
  clock: Clock;
  pushSender: PushSender;
  smsProvider: SmsProvider;
  log: Logger;
}

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(name: string, data?: Record<string, unknown>): Promise<void>;
}

/**
 * Start the background job scheduler backed by pg-boss (spec 2, 9).
 * All schedules are expressed in Asia/Dhaka. Date-dependent handlers check the
 * rule values and the clock date themselves, so a rule change never needs a reschedule.
 */
export function createScheduler(poolUrl: string, deps: JobDeps): Scheduler {
  const boss = new PgBoss({ connectionString: poolUrl, max: 3 });

  async function start(): Promise<void> {
    await boss.start();

    // Worker: send queued push/SMS every minute.
    await boss.work(
      'send-notifications',
      { batchSize: 1 },
      async () => {
        const { sendQueuedNotifications } = await import('./workers/send');
        await sendQueuedNotifications(deps);
      },
    );

    // Date-dependent jobs run daily and inspect the clock/rules inside the handler.
    await boss.work('generate-dues', async () => {
      const { generateDuesJob } = await import('./workers/dues');
      await generateDuesJob(deps);
    });
    await boss.work('apply-fines', async () => {
      const { applyFinesJob } = await import('./workers/fines');
      await applyFinesJob(deps);
    });
    await boss.work('remind-dues', async () => {
      const { remindDuesJob } = await import('./workers/reminders');
      await remindDuesJob(deps);
    });
    await boss.work('notify-fines', async () => {
      const { notifyFinesJob } = await import('./workers/reminders');
      await notifyFinesJob(deps);
    });
    await boss.work('pending-payment-alert', async () => {
      const { pendingPaymentAlertJob } = await import('./workers/alerts');
      await pendingPaymentAlertJob(deps);
    });
    await boss.work('cleanup', async () => {
      const { cleanupJob } = await import('./workers/cleanup');
      await cleanupJob(deps);
    });
    await boss.work('sms-fallback', async () => {
      const { runSmsFallback } = await import('./workers/send');
      await runSmsFallback(deps);
    });
    await boss.work('generate-rent-expected', async () => {
      const { generateRentExpectedJob } = await import('./workers/rent');
      await generateRentExpectedJob(deps);
    });
    await boss.work('finalize-proposals', async () => {
      const { finalizeProposalsJob } = await import('./workers/proposals');
      await finalizeProposalsJob(deps);
    });
    await boss.work('verify-ledger', async () => {
      const { verifyLedgerJob } = await import('./workers/ledger');
      await verifyLedgerJob(deps);
    });
    await boss.work('zakat-notice', async () => {
      const { zakatNoticeJob } = await import('./workers/zakat');
      await zakatNoticeJob(deps);
    });
    await boss.work('meeting-draft', async () => {
      const { meetingDraftJob } = await import('./workers/meetings');
      await meetingDraftJob(deps);
    });
    await boss.work('meeting-reminders', async () => {
      const { meetingRemindersJob } = await import('./workers/meetings');
      await meetingRemindersJob(deps);
    });
    await boss.work('member-status', async () => {
      const { statusJob } = await import('./workers/status');
      await statusJob(deps);
    });

    // Queues are created by `pnpm migrate` (the app role cannot attach partitions); this only
    // covers a queue added in code before the next migrate run.
    for (const name of JOB_QUEUES) {
      await boss.createQueue(name, { name, policy: 'singleton' });
    }

    const scheduleOpts = { tz: 'Asia/Dhaka' as const };
    await boss.schedule('send-notifications', '* * * * *', undefined, scheduleOpts);
    await boss.schedule('generate-dues', '10 0 * * *', undefined, scheduleOpts);
    await boss.schedule('apply-fines', '5 0 * * *', undefined, scheduleOpts);
    await boss.schedule('remind-dues', '0 9 * * *', undefined, scheduleOpts);
    await boss.schedule('notify-fines', '0 9 * * *', undefined, scheduleOpts);
    await boss.schedule('pending-payment-alert', '0 * * * *', undefined, scheduleOpts);
    await boss.schedule('cleanup', '0 4 * * *', undefined, scheduleOpts);
    await boss.schedule('sms-fallback', '*/15 * * * *', undefined, scheduleOpts);
    await boss.schedule('generate-rent-expected', '5 0 * * *', undefined, scheduleOpts);
    await boss.schedule('finalize-proposals', '* * * * *', undefined, scheduleOpts);
    await boss.schedule('member-status', '30 0 * * *', undefined, scheduleOpts);
    await boss.schedule('verify-ledger', '0 3 * * *', undefined, scheduleOpts);
    await boss.schedule('zakat-notice', '30 8 * * *', undefined, scheduleOpts);
    await boss.schedule('meeting-draft', '20 0 * * *', undefined, scheduleOpts);
    await boss.schedule('meeting-reminders', '0 * * * *', undefined, scheduleOpts);
  }

  async function stop(): Promise<void> {
    await boss.stop();
  }

  async function send(name: string, data?: Record<string, unknown>): Promise<void> {
    await boss.send(name, data ?? {});
  }

  return { start, stop, send };
}
