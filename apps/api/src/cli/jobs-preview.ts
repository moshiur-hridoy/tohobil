/* eslint-disable no-console -- a command-line tool: stdout is its interface */
import { addMonths, formatBDT, systemClock } from '@barakah/shared';
import { lateFineCandidates, lastFineRun } from '../fines/service';
import { ruleInt } from '../jobs/workers/util';
import { createPool } from '../lib/db';
import { autoJobsOn, loadEnv } from '../lib/env';
import { computeConsecutiveUnpaidMonths } from '../members/status';
import { STALE_AFTER_MS } from '../notifications/service';

/**
 * What the scheduled jobs would do if they ran now. Read-only (a READ ONLY transaction), for the owner
 * to look at before setting AUTO_JOBS=on (docs/RUNBOOK.md).
 *
 *   pnpm jobs:preview                    # development
 *   node dist/cli/jobs-preview.js        # inside the production api container
 */
const money = (paisa: bigint) => `Tk ${formatBDT(paisa, { digits: 'en' })}`;

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env.DATABASE_URL);
  const clock = systemClock;
  try {
    const today = clock.todayDhaka();
    const fineDay = await ruleInt(pool, clock, 'fine_day', 21);
    const warnAfter = await ruleInt(pool, clock, 'warning_after_months', 2);
    const noticeAfter = await ruleInt(pool, clock, 'suspension_after_consecutive_unpaid_months', 3);

    const db = await pool.connect();
    try {
      await db.query('BEGIN TRANSACTION READ ONLY');
      console.log(`Preview for ${today}. Nothing is changed.`);
      console.log(`Automatic jobs are currently ${autoJobsOn(env) ? 'ON' : 'OFF'}.`);

      const notices = await db.query(
        `SELECT channel, scheduled_for < $1 AS stale, count(*)::int AS n FROM notifications
         WHERE status = 'queued' GROUP BY 1, 2 ORDER BY 1, 2`,
        [new Date(clock.now().getTime() - STALE_AFTER_MS)],
      );
      console.log('\nWaiting notifications:');
      for (const r of notices.rows as Array<{ channel: string; stale: boolean; n: number }>) {
        console.log(`  ${r.channel}: ${r.n} ${r.stale ? 'too old, will NOT be sent' : 'will be sent'}`);
      }
      if (notices.rows.length === 0) console.log('  none');

      console.log('\nMonthly dues:');
      for (const period of [addMonths(today.slice(0, 7), -1), today.slice(0, 7)]) {
        const n = await db.query(`SELECT count(*)::int AS n FROM dues WHERE kind = 'monthly' AND period = $1`, [period]);
        const count = (n.rows[0] as { n: number }).n;
        console.log(`  ${period}: ${count} on record${count === 0 ? ` (if they should exist: pnpm dues:generate ${period}, or node dist/cli/generate-dues.js ${period})` : ''}`);
      }

      const from = env.AUTO_FINES_FROM || null;
      const fines = await lateFineCandidates(db, lastFineRun(today, fineDay), null, from);
      console.log(`\nLate fines the first run would add${from ? ` (dues from ${from} only)` : ' (every late due, however old)'}:`);
      for (const f of fines) console.log(`  ${f.member_code}  ${f.period}  ${money(f.amount_paisa)}`);
      console.log(fines.length ? `  total: ${fines.length} fine(s), ${money(fines.reduce((s, f) => s + f.amount_paisa, 0n))}` : '  none');

      console.log('\nMember status the first run would change:');
      const members = await db.query(`SELECT id, code, status FROM members WHERE status IN ('active','warning') ORDER BY code`);
      let changes = 0;
      for (const m of members.rows as Array<{ id: string; code: string; status: string }>) {
        const months = await computeConsecutiveUnpaidMonths(db, m.id, today);
        const warn = m.status === 'active' && months >= warnAfter;
        const notice = (m.status === 'warning' || warn) && months >= noticeAfter;
        if (!warn && !notice) continue;
        changes += 1;
        // The job warns on one run and gives the final notice on a later one, a day apart.
        const steps = [warn ? 'warning' : '', notice ? `final notice${warn ? ' the next day' : ''} (suspension may follow automatically)` : ''];
        console.log(`  ${m.code}: ${months} unpaid months -> ${steps.filter(Boolean).join(', then ')}`);
      }
      if (changes === 0) console.log('  none');

      const votes = await db.query(`SELECT title FROM proposals WHERE status = 'open' AND closes_at <= $1 ORDER BY closes_at`, [clock.now()]);
      console.log('\nVotes past their closing time, to be closed and counted:');
      for (const v of votes.rows as Array<{ title: string }>) console.log(`  ${v.title}`);
      if (votes.rows.length === 0) console.log('  none');
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
