import { expect, test } from '@playwright/test';
import { Api, DESKTOP, MOBILE, activate, issueCode, resetTotp, resumeSession, stepUp, tr } from '../helpers';

/**
 * Doc.md 14.3 governance e2e scenarios.
 *
 * (4) A member votes on an open proposal through the mobile votes screen.
 * (5) The cashier executes an approved distribution proposal from the admin screen.
 *
 * Each scenario starts from a fresh browser context. Single-use activation codes are issued through
 * the server CLI so the tests never depend on codes consumed by earlier scenarios.
 */

function suffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

test('(4) member votes on a proposal', async ({ browser, request }) => {
  const api = new Api(request);
  await api.activate('M01', issueCode('M01'));

  const title = `E2E Scenario 4 ${suffix()}`;
  const created = await api.post<{ id: string }>('/proposals', {
    type: 'general',
    title,
    payload: { text: 'End-to-end vote scenario' },
  });

  await api.post(`/proposals/${created.id}/open`, {
    closes_at: '2099-12-31T23:59:59Z',
  });

  const memberCtx = await browser.newContext({ viewport: MOBILE });
  const page = await memberCtx.newPage();
  await activate(page, 'M02', issueCode('M02'));

  await page.goto('/votes');
  const card = page.getByTestId('proposal-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.click();

  const [voteResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/proposals/${created.id}/vote`) && r.request().method() === 'POST'),
    page.getByTestId('vote-yes').click(),
  ]);
  if (!voteResponse.ok()) {
    console.error('vote failed', await voteResponse.text());
  }
  expect(voteResponse.ok()).toBeTruthy();
  await expect(page.getByTestId('voted-label')).toContainText(tr('votes.yes'));

  await page.reload();
  await expect(page.getByTestId('vote-yes')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('voted-label')).toBeVisible();

  await memberCtx.close();
});

test('(5) cashier executes a distribution proposal', async ({ browser, request }) => {
  const api = new Api(request);
  const session = await api.activate('M01', issueCode('M01'));
  await resetTotp('M01');

  const title = `E2E Scenario 5 ${suffix()}`;
  const totalPaisa = '100000'; // 1,000 BDT, small enough that cash balance is not a problem.
  const created = await api.post<{ id: string }>('/proposals', {
    type: 'distribution',
    title,
    payload: { total_paisa: totalPaisa, source_account: 'CASH' },
  });
  await api.post(`/proposals/${created.id}/open`, {
    closes_at: '2099-12-31T23:59:59Z',
  });

  // Distribution is share-weighted. With 20 outstanding shares the threshold is 11 shares.
  // We create a new API device for each supporting voter (voting is tied to the device).
  for (const code of ['M03', 'M04', 'M05', 'M06', 'M07']) {
    const voter = new Api(request);
    await voter.activate(code, issueCode(code));
    await voter.post(`/proposals/${created.id}/vote`, { choice: 'yes' });
  }
  // The cashier (M01) also votes yes on the proposal.
  await api.post(`/proposals/${created.id}/vote`, { choice: 'yes' });

  await api.post(`/proposals/${created.id}/close-early`, {});
  const before = await api.get<{ status: string }>(`/proposals/${created.id}`);
  expect(before.status).toBe('approved');

  const cashierCtx = await browser.newContext({ viewport: DESKTOP });
  const page = await cashierCtx.newPage();
  await resumeSession(page, 'M01', session);
  await page.goto('/');
  await expect(page).toHaveURL(/\/admin/);
  await stepUp(page);

  await page.goto('/admin/proposals');
  const row = page.getByTestId('proposal-row').filter({ hasText: title });
  await expect(row).toContainText(tr('status.proposal.approved'));

  await row.getByTestId('execute-proposal').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(tr('proposal.executeTitle'));
  const [executeResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/proposals/${created.id}/execute`) && r.request().method() === 'POST'),
    sheet.getByRole('button', { name: tr('proposal.execute') }).click(),
  ]);
  expect(executeResponse.ok(), await executeResponse.text()).toBeTruthy();

  await expect(row.getByTestId('execute-proposal')).toHaveCount(0);

  const after = await api.get<{ status: string }>(`/proposals/${created.id}`);
  expect(after.status).toBe('executed');

  const ledger = await api.get<{ items: Array<{ debit_account: string; credit_account: string }> }>(`/ledger?limit=20`);
  const distributionEntry = ledger.items.find(
    (e) => e.debit_account === 'DISTRIBUTIONS' && ['CASH', 'BANK', 'BKASH', 'NAGAD'].includes(e.credit_account),
  );
  expect(distributionEntry).toBeTruthy();

  await cashierCtx.close();
});
