import { expect, test } from '@playwright/test';
import { CODES, PIN } from './env';
import { DESKTOP, MOBILE, activate, newPage, shot, stepUp, todayDdMmYyyy, tr } from './helpers';

/**
 * Doc.md 14.3 end-to-end scenarios. (1) is the activation-code login that replaced the OTP login
 * (19.1); (2) is the member-pays, cashier-pastes-SMS, member-sees-confirmed round trip.
 */

for (const [name, viewport, who] of [
  ['mobile', MOBILE, CODES.mobileLogin],
  ['desktop', DESKTOP, CODES.desktopLogin],
] as const) {
  test(`(1) activation, PIN set and PIN login on ${name}`, async ({ browser }) => {
    const { context, page } = await newPage(browser, viewport);
    await activate(page, who.ref, who.code);
    await expect(page).toHaveURL(/\/home/);
    await expect(page.getByRole('heading', { name: tr('home.myOutstanding') })).toBeVisible();

    // Log out, then sign back in with the PIN pad on the registered device.
    await page.goto('/menu');
    await page.getByRole('button', { name: tr('menu.logout') }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: tr('auth.pinTitle') })).toBeVisible();

    await page.keyboard.type('111111'); // wrong
    await expect(page.getByRole('alert')).toBeVisible();
    await page.keyboard.type(PIN);
    await expect(page).toHaveURL(/\/home/);
    await context.close();
  });
}

test('(2) member submits, cashier pastes the SMS and approves, member sees it confirmed', async ({ browser }) => {
  const trx = 'E2ETRX0001';

  // Cashier on a desktop screen: activate and open the 12 h authenticator window.
  const cashier = await newPage(browser, DESKTOP);
  await activate(cashier.page, CODES.cashier.ref, CODES.cashier.code);
  await stepUp(cashier.page);
  await expect(cashier.page).toHaveURL(/\/admin/);

  // Member on a phone: activate and say "I have sent money".
  const member = await newPage(browser, MOBILE);
  await activate(member.page, CODES.member.ref, CODES.member.code);
  await member.page.goto('/pay');
  await member.page.getByLabel(tr('pay.amountLabel')).fill('5000');
  await member.page.getByLabel(tr('payment.trxId')).fill(trx);
  await member.page.getByRole('button', { name: tr('pay.send') }).click();
  const sheet = member.page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: tr('pay.reviewTitle') })).toBeVisible();
  await expect(sheet).toContainText('৳৫,০০০');
  await sheet.getByRole('button', { name: tr('pay.send') }).click();
  await expect(member.page.getByText(tr('pay.sent'))).toBeVisible();

  // While it waits, the member's home says "under verification".
  await member.page.goto('/home');
  await expect(member.page.getByText(tr('home.underVerification'), { exact: false }).first()).toBeVisible();

  await shot(member.page, 'member-home-pending');
  await member.page.goto('/pay');
  await shot(member.page, 'member-pay');

  // Cashier pastes the bKash message: the pending payment is matched exactly.
  await cashier.page.goto('/admin/payments');
  await cashier.page.getByRole('textbox', { name: tr('paymentsPage.pasteSms') }).fill(
    `You have received Tk 5,000.00 from 01700000002. Fee Tk 0.00. Balance Tk 9,000.00. TrxID ${trx} at ${todayDdMmYyyy()} 10:00`,
  );
  await cashier.page.getByRole('button', { name: tr('paymentsPage.parse') }).click();
  await expect(cashier.page.getByText(tr('paymentsPage.exactMatch')).first()).toBeVisible();
  await expect(cashier.page.getByRole('button', { name: tr('paymentsPage.bulkApprove', { n: '১' }) })).toBeVisible();

  await shot(cashier.page, 'cashier-payments');

  // Approve through the confirmation sheet, which shows the effect before anything is posted.
  await cashier.page.getByRole('button', { name: tr('paymentsPage.approve'), exact: true }).first().click();
  const confirm = cashier.page.getByRole('dialog');
  await expect(confirm.getByRole('heading', { name: tr('paymentsPage.approveTitle') })).toBeVisible();
  await expect(confirm).toContainText(tr('paymentsPage.toPrincipal'));
  await expect(confirm).toContainText('৳৫,০০০');
  await shot(cashier.page, 'cashier-confirm-sheet');
  await confirm.getByRole('button', { name: tr('paymentsPage.approve'), exact: true }).click();
  await expect(cashier.page.getByText(tr('paymentsPage.confirmed'))).toBeVisible();

  // The member sees it confirmed, with a receipt, and the waiting banner is gone.
  await member.page.goto('/pay');
  const item = member.page.getByRole('button', { name: new RegExp(tr('payment.status.confirmed')) }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(member.page.getByText(tr('pay.receipt'), { exact: true })).toBeVisible();
  await member.page.goto('/home');
  await expect(member.page.getByText(tr('home.underVerificationHint'))).toHaveCount(0);

  // The ledger shows the entry to everyone and its chain verifies.
  await member.page.goto('/menu/ledger');
  await expect(member.page.getByText('BKASH → MEMBER_CAPITAL')).toBeVisible();
  await member.page.getByRole('button', { name: tr('ledgerPage.verify') }).click();
  await expect(member.page.getByText(tr('ledgerPage.verifyOk', { n: '১', seq: '১' }))).toBeVisible();

  await shot(member.page, 'member-ledger');
  await cashier.page.goto('/admin');
  await expect(cashier.page.getByText('৳৫,০০০').first()).toBeVisible();
  await shot(cashier.page, 'cashier-dashboard');
  await cashier.page.goto('/admin/matrix');
  await expect(cashier.page.getByRole('table')).toBeVisible();
  await shot(cashier.page, 'cashier-matrix');
  await cashier.page.goto('/admin/ledger');
  await expect(cashier.page.getByRole('table')).toBeVisible();
  await shot(cashier.page, 'cashier-ledger');

  await cashier.context.close();
  await member.context.close();
});
