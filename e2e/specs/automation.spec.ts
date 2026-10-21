import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { MOBILE, activate, issueCode } from '../helpers';
import { E2E_MIGRATOR_URL } from '../env';

/**
 * Doc.md 14.3 scenario (3): a late fine appears and the member is notified.
 *
 * The scheduler runs against the real system clock, so instead of advancing the clock to the 21st
 * the scenario sets the `fine_day` rule to today and plants a monthly due that was payable
 * yesterday. The real `apply-fines` and `notify-fines` workers then run (queued through pg-boss),
 * and the member sees the notice in the app. The clock itself is covered by the simulated-year test.
 */
const requireFromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const PgBoss = requireFromApi('pg-boss') as typeof import('pg-boss').default;

const dhaka = (offsetDays: number): string => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d); // YYYY-MM-DD
};

test('(3) a late fine is applied by the scheduler and the member sees the notice', async ({ browser }) => {
  const today = dhaka(0);
  const yesterday = dhaka(-1);
  // Two months back, so it cannot collide with the monthly due the seed already has for this month.
  const [year, month] = today.split('-').map(Number) as [number, number];
  const period = new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 7);

  const admin = new pg.Client({ connectionString: E2E_MIGRATOR_URL });
  await admin.connect();
  const boss = new PgBoss({ connectionString: E2E_MIGRATOR_URL, max: 1, supervise: false, schedule: false });
  try {
    const ctx = await browser.newContext({ viewport: MOBILE });
    const page = await ctx.newPage();
    await activate(page, 'M02', issueCode('M02'));

    const member = (await admin.query(`SELECT id FROM members WHERE code='M02'`)).rows[0] as { id: string };
    await admin.query(
      `INSERT INTO rules (key, value, valid_from) VALUES ('fine_day', $1::jsonb, $2) ON CONFLICT (key, valid_from) DO NOTHING`,
      [String(Number(today.slice(8))), today],
    );
    await admin.query(
      `INSERT INTO dues (member_id, period, kind, shares_snapshot, amount_paisa, due_date)
       VALUES ($1, $2, 'monthly', 4, 2000000, $3) ON CONFLICT DO NOTHING`,
      [member.id, period, yesterday],
    );
    // Only this due's fine is looked at: after the 20th the seed's own current month is overdue too and
    // is fined by the same run, so counting every fine of the member would depend on the date.
    const ownFines = `SELECT f.id, f.amount_paisa::text AS amount FROM fines f JOIN dues d ON d.id = f.due_id WHERE d.member_id = $1 AND d.period = $2`;

    await boss.start();
    await boss.send('apply-fines');
    await expect
      .poll(async () => (await admin.query(ownFines, [member.id, period])).rowCount, { timeout: 30_000 })
      .toBe(1);
    const fine = (await admin.query(ownFines, [member.id, period])).rows[0];
    expect(fine.amount).toBe('200000'); // 4 shares x 500 BDT

    await boss.send('notify-fines');
    await expect
      .poll(
        async () =>
          Number(
            (
              await admin.query(
                `SELECT count(*) FROM notifications WHERE member_id=$1 AND template='fine_notice' AND channel='push' AND dedupe_key LIKE '%' || $2 || '%'`,
                [member.id, fine.id],
              )
            ).rows[0].count,
          ),
        { timeout: 30_000 },
      )
      .toBe(1);

    await page.goto('/menu/notices');
    await page.getByRole('tab').last().click(); // "All": the notice is unread, but do not depend on the default tab
    await expect(page.locator('article').filter({ hasText: /২,০০০/ }).first()).toBeVisible();

    await ctx.close();
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await admin.end();
  }
});
