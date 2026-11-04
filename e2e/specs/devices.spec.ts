import { expect, test } from '@playwright/test';
import { MOBILE, activate, issueCode, newPage, shot, tr } from '../helpers';

/**
 * Menu → আমার ডিভাইস and নিরাপত্তা ফিড: a member signed in on two browsers removes the other one
 * from this one, and the security feed names them. Uses M08, which no other scenario touches.
 */
test('a member removes another of their devices and the feed shows their name', async ({ browser }) => {
  const first = await newPage(browser, MOBILE);
  await activate(first.page, 'M08', issueCode('M08'));
  const second = await newPage(browser, MOBILE);
  await activate(second.page, 'M08', issueCode('M08', 'add'));

  const page = second.page;
  await page.goto('/menu');
  await shot(page, 'menu');
  await page.getByRole('link', { name: new RegExp(tr('devices.title')) }).click();
  await expect(page.getByRole('heading', { name: tr('devices.title') })).toBeVisible();
  await expect(page.getByText(tr('menu.thisDevice'), { exact: true })).toBeVisible();
  await shot(page, 'devices');

  await page.getByRole('button', { name: tr('devices.remove') }).click();
  await page.getByRole('dialog').getByRole('button', { name: tr('devices.remove') }).click();
  await expect(page.getByText(tr('devices.onlyThis'))).toBeVisible();

  await page.goto('/menu/security');
  const mine = page.getByRole('listitem').filter({ hasText: tr('securityFeed.you') }).first();
  await expect(mine).toContainText('সদস্য আট');
  await expect(mine).toContainText(tr('menu.deviceEvent.revoked'));
  await shot(page, 'security-feed');

  await first.context.close();
  await second.context.close();
});
