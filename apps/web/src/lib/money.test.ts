import { describe, expect, it } from 'vitest';
import { paisaToDecimal, parseAmountInput, sumPaisa } from './money';
import { toCsv } from './csv';

describe('parseAmountInput', () => {
  it('reads taka the way people type them, as paisa strings', () => {
    expect(parseAmountInput('5000')).toBe('500000');
    expect(parseAmountInput('5,000.50')).toBe('500050');
    expect(parseAmountInput('৫০০০')).toBe('500000');
    expect(parseAmountInput('  ৳১,০০,০০০ ')).toBe('10000000');
  });
  it('refuses empty, zero, negative and junk', () => {
    for (const bad of ['', '0', '0.00', '-5', 'abc', '1.234', '1e3']) expect(parseAmountInput(bad)).toBeNull();
  });
});

describe('paisaToDecimal and sumPaisa', () => {
  it('formats without floating point', () => {
    expect(paisaToDecimal('0')).toBe('0.00');
    expect(paisaToDecimal('5')).toBe('0.05');
    expect(paisaToDecimal('1750000')).toBe('17500.00');
    expect(paisaToDecimal(-1234n)).toBe('-12.34');
    expect(paisaToDecimal('999999999999999999')).toBe('9999999999999999.99');
  });
  it('sums strings and ignores gaps', () => {
    expect(sumPaisa(['100', null, undefined, '250'])).toBe(350n);
  });
});

describe('toCsv', () => {
  it('quotes commas, quotes and newlines and starts with a BOM', () => {
    const csv = toCsv([['a', 'b,c'], ['say "hi"', 'x\ny']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('a,"b,c"');
    expect(csv).toContain('"say ""hi""","x\ny"');
  });
});
