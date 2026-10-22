import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { i18n as I18n } from 'i18next';

let i18n: I18n;

beforeAll(async () => {
  // i18n.ts sets <html lang>; these tests run without a browser.
  vi.stubGlobal('document', { documentElement: {} });
  ({ i18n } = await import('./i18n'));
});

describe('numbers inside translated sentences', () => {
  it('shows a number in Bengali digits in Bengali text', () => {
    expect(i18n.t('proposalsPage.count', { count: 2 })).toBe('মোট ২টি');
  });

  it('leaves text values such as member codes as they are', () => {
    expect(i18n.t('proposal.countMembers', { n: 'M07' })).toBe('M07 জন');
  });

  it('keeps English digits in English text', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('proposalsPage.count', { count: 2 })).toBe('Total: 2');
    await i18n.changeLanguage('bn');
  });
});
