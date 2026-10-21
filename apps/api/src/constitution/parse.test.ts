import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseConstitution } from './parse';

describe('parseConstitution', () => {
  it('reads the example constitution shipped in the repo', () => {
    const md = readFileSync(new URL('../../../../examples/constitution.example.md', import.meta.url), 'utf8');
    const { title, clauses } = parseConstitution(md);
    expect(title).toBe('Example constitution (fictional)');
    expect(clauses.map((c) => c.clause_no)).toEqual(['1.1', '1.2', '1.4', '2.1', '2.2', '2.4', '3.1', '4.1', '4.2']);
    expect(clauses[4]).toMatchObject({ title: 'Late fine', summary: 'Article 2. Dues and fines' });
    expect(clauses[4]!.body).toMatch(/^A fine of 500 BDT per share/);
  });

  it('stores Bengali clause numbers with Western digits so they match rules.clause_ref', () => {
    const md = [
      '# সংবিধান',
      '<!-- a note that is not loaded -->',
      'বিসমিল্লাহ',
      '## ভূমিকা',
      '### ০ শপথনামা',
      'শপথের লেখা',
      '## অনুচ্ছেদ ২. চাঁদা',
      '### ২.২। জরিমানা (Late Fine)',
      '১০ তারিখের পর ৫০০ টাকা।',
      '(ক) প্রথম ভাগ',
      '',
      '### ১০.১ বিরোধ',
      'সংখ্যাগরিষ্ঠের সিদ্ধান্ত।',
    ].join('\n');
    const { clauses, ignored } = parseConstitution(md);
    expect(clauses.map((c) => c.clause_no)).toEqual(['0', '2.2', '10.1']);
    expect(clauses[1]).toEqual({
      clause_no: '2.2',
      title: 'জরিমানা (Late Fine)',
      summary: 'অনুচ্ছেদ ২. চাঁদা',
      body: '১০ তারিখের পর ৫০০ টাকা।\n(ক) প্রথম ভাগ',
    });
    expect(ignored).toEqual(['বিসমিল্লাহ']);
  });

  it('refuses a clause number used twice', () => {
    expect(() => parseConstitution('### 1.1 A\nx\n### ১.১ B\ny')).toThrow(/1\.1 appears twice/);
  });
});
