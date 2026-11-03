import { describe, expect, it } from 'vitest';
import { APP_VERSION, RELEASES, parseChangelog } from './changelog';

describe('parseChangelog', () => {
  it('reads releases, their groups and changes, and leaves out the unreleased part', () => {
    const text = [
      '# কী নতুন',
      'intro',
      '## অপ্রকাশিত',
      '### নতুন',
      '- not yet',
      '## 1.1.0 (2026-11-03)',
      '### নতুন',
      '- one',
      '- two',
      '### ঠিক করা হয়েছে',
      '- fixed',
      '## 1.0.0 (2026-10-20)',
      '### প্রথম সংস্করণ',
      '- first',
    ].join('\n');
    expect(parseChangelog(text)).toEqual([
      { version: '1.1.0', date: '2026-11-03', sections: [{ title: 'নতুন', items: ['one', 'two'] }, { title: 'ঠিক করা হয়েছে', items: ['fixed'] }] },
      { version: '1.0.0', date: '2026-10-20', sections: [{ title: 'প্রথম সংস্করণ', items: ['first'] }] },
    ]);
  });

  it('the real CHANGELOG has the app version as its newest release, newest first', () => {
    expect(RELEASES[0]?.version).toBe(APP_VERSION);
    const versions = RELEASES.map((r) => r.version.split('.').map(Number));
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [versions[i - 1] as number[], versions[i] as number[]];
      expect(a[0]! * 1e6 + a[1]! * 1e3 + a[2]!).toBeGreaterThan(b[0]! * 1e6 + b[1]! * 1e3 + b[2]!);
    }
    expect(RELEASES.every((r) => r.sections.length > 0 && r.sections.every((s) => s.items.length > 0))).toBe(true);
  });
});
