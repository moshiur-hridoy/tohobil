import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MOBILE, activate, issueCode } from '../helpers';

/**
 * Accessibility pass on the member screens (Phase 6): axe-core in light and dark mode (real colours, real
 * labels, real landmarks), and text at 200% must still fit a phone without sideways scrolling.
 */
const SCREENS = ['/home', '/pay', '/votes', '/assets', '/menu', '/menu/ledger', '/menu/members', '/menu/constitution', '/menu/notices', '/menu/settlement', '/menu/pin'];

async function open(page: Page, path: string): Promise<void> {
  // in-app navigation keeps the session in memory (a full reload would ask for the PIN again)
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await page.waitForLoadState('networkidle');
}

for (const scheme of ['light', 'dark'] as const) {
  test(`member screens pass axe in ${scheme} mode`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: MOBILE, colorScheme: scheme });
    const page = await ctx.newPage();
    await activate(page, 'M02', issueCode('M02'));
    const problems: string[] = [];
    for (const path of SCREENS) {
      await open(page, path);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of result.violations) {
        if (v.impact === 'serious' || v.impact === 'critical') {
          problems.push(`${scheme} ${path}: ${v.id} (${v.impact}) - ${v.nodes.length} element(s), e.g. ${v.nodes[0]?.target.join(' ')}`);
        }
      }
    }
    expect(problems).toEqual([]);
    await ctx.close();
  });
}

test('text at 200% still fits a phone: no sideways scrolling on any member screen', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: MOBILE });
  const page = await ctx.newPage();
  await activate(page, 'M02', issueCode('M02'));
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const wide: string[] = [];
  for (const path of SCREENS) {
    await open(page, path);
    const { scroll, inner, offenders } = await page.evaluate(() => {
      const inner = window.innerWidth;
      // An element inside an overflow-hidden ancestor is clipped, so it cannot widen the page (a vertical scroller
      // computes overflow-x as auto, so only hidden and clip count).
      const clipped = (el: Element): boolean => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'hidden' || o === 'clip') return true;
        }
        return false;
      };
      const offenders = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > inner + 1 && !clipped(el))
        .slice(0, 3)
        .map((el) => `<${el.tagName.toLowerCase()} class="${String(el.getAttribute('class') ?? '').slice(0, 60)}"> ${(el.textContent ?? '').trim().slice(0, 30)}`);
      return { scroll: document.documentElement.scrollWidth, inner, offenders };
    });
    if (scroll > inner + 1) wide.push(`${path}: content ${scroll}px wide in a ${inner}px screen; first offenders: ${offenders.join(' | ')}`);
  }
  expect(wide).toEqual([]);
  await ctx.close();
});
