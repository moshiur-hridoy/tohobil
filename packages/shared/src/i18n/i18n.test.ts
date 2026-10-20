import { describe, it, expect } from 'vitest';
import bn from './bn.json';
import en from './en.json';

function flatten(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') Object.assign(out, flatten(v, key));
    else out[key] = String(v);
  }
  return out;
}

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

describe('i18n catalogues', () => {
  const b = flatten(bn);
  const e = flatten(en);

  it('bn and en have exactly the same keys', () => {
    expect(Object.keys(b).sort()).toEqual(Object.keys(e).sort());
  });

  it('every template uses the same {placeholders} in both languages', () => {
    for (const key of Object.keys(b)) {
      expect(placeholders(b[key] as string), key).toEqual(placeholders(e[key] as string));
    }
  });

  it('has no OTP template (SMS OTP login was removed in 19.1)', () => {
    expect(Object.keys(b).some((k) => k.startsWith('notif.otp'))).toBe(false);
  });

  it('does not label Nagad with the Bengali word "নগদ" (19.3: ambiguous with cash)', () => {
    expect(b['payment.methods.nagad']).toBe('Nagad');
    expect(b['payment.methods.cash']).toBe('হাতে নগদ');
    // the cash-account pickers added later follow the same rule
    for (const group of ['cashAccount', 'proposalOptions']) {
      expect(b[`${group}.NAGAD`], group).toBe('Nagad');
      expect(b[`${group}.CASH`], group).toBe('হাতে নগদ');
    }
  });
});
