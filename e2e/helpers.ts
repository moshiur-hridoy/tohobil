import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import bn from '../packages/shared/src/i18n/bn.json' with { type: 'json' };
import { PIN } from './env';

export const MOBILE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };

/** A Bengali UI string by i18n key, with {placeholders} filled. The app runs in Bengali by default. */
export function tr(key: string, params: Record<string, string | number> = {}): string {
  let node: unknown = bn;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)?.[part];
  if (typeof node !== 'string') throw new Error(`Missing i18n key ${key}`);
  return node.replace(/\{\{?(\w+)\}?\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));
}

export async function newPage(browser: Browser, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  return { context, page: await context.newPage() };
}

/** Activation screen: member id and code, choose the PIN, confirm it. Lands on the app. */
export async function activate(page: Page, ref: string, code: string): Promise<void> {
  await page.goto('/activate');
  await page.getByLabel(tr('auth.memberRef')).fill(ref);
  await page.getByLabel(tr('auth.activateCode')).fill(code);
  await page.getByRole('button', { name: tr('common.next') }).click();
  await expect(page.getByRole('heading', { name: tr('auth.setPinTitle') })).toBeVisible();
  await page.keyboard.type(PIN);
  await expect(page.getByRole('heading', { name: tr('auth.confirmPinTitle') })).toBeVisible();
  await page.keyboard.type(PIN);
  await expect(page).not.toHaveURL(/\/activate/);
}

/** Cashier and auditor: enrol the authenticator (or enter a code) and open the 12 h step-up window. */
export async function stepUp(page: Page): Promise<void> {
  await page.goto('/totp');
  const start = page.getByRole('button', { name: tr('totp.startEnrol') });
  await expect(start.or(page.getByLabel(tr('totp.code')))).toBeVisible();
  if (await start.isVisible()) {
    await start.click();
    const secret = (await page.locator('p.font-mono').innerText()).replace(/\s/g, '');
    await page.getByLabel(tr('totp.code')).fill(authenticator.generate(secret));
    await page.getByRole('button', { name: tr('totp.verify') }).click();
    await expect(page).not.toHaveURL(/\/totp/);
    // remember the secret for a later step-up in the same run
    (page.context() as unknown as { _totp?: string })._totp = secret;
  } else {
    const secret = (page.context() as unknown as { _totp?: string })._totp;
    if (!secret) throw new Error('no authenticator secret known for this context');
    await page.getByLabel(tr('totp.code')).fill(authenticator.generate(secret));
    await page.getByRole('button', { name: tr('totp.verify') }).click();
    await expect(page).not.toHaveURL(/\/totp/);
  }
}

/** Today's date in Asia/Dhaka as DD/MM/YYYY (the form bKash writes in its messages). */
export function todayDdMmYyyy(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}

/** Set E2E_SHOTS=1 to save full-page screenshots to e2e/test-results/shots for a visual check. */
export async function shot(page: Page, name: string): Promise<void> {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `e2e/test-results/shots/${name}.png`, fullPage: true });
}
