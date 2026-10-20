import { describe, it, expect } from 'vitest';
import {
  formatBDT,
  parseBDT,
  tryParseBDT,
  divRound,
  toBengaliDigits,
  toWesternDigits,
} from './money';

describe('formatBDT', () => {
  it('formats simple amounts in Bengali', () => {
    expect(formatBDT(500000n, { digits: 'bn' })).toBe('৫,০০০');
  });

  it('formats simple amounts in English', () => {
    expect(formatBDT(500000n, { digits: 'en' })).toBe('5,000');
  });

  it('formats lakh grouping', () => {
    expect(formatBDT(10000000n, { digits: 'en' })).toBe('1,00,000');
    expect(formatBDT(10000000n, { digits: 'bn' })).toBe('১,০০,০০০');
  });

  it('formats crore grouping', () => {
    // 1,00,00,000 BDT = 10,00,00,000 paisa
    expect(formatBDT(1000000000n, { digits: 'en' })).toBe('1,00,00,000');
    expect(formatBDT(100000000n, { digits: 'en' })).toBe('10,00,000');
    expect(formatBDT(1000000000n, { digits: 'bn' })).toBe('১,০০,০০,০০০');
  });

  it('groups every length from 1 to 9 digits (lakh/crore)', () => {
    const cases: Array<[bigint, string]> = [
      [100n, '1'],
      [99900n, '999'],
      [100000n, '1,000'],
      [1234500n, '12,345'],
      [123456700n, '12,34,567'],
      [12345678900n, '12,34,56,789'],
    ];
    for (const [paisa, text] of cases) expect(formatBDT(paisa, { digits: 'en' })).toBe(text);
  });

  it('formats negative paisa with Bengali digits and the sign first', () => {
    expect(formatBDT(-12345600n, { digits: 'bn' })).toBe('-১,২৩,৪৫৬');
  });

  it('formats zero', () => {
    expect(formatBDT(0n, { digits: 'en' })).toBe('0');
  });

  it('formats negative amounts', () => {
    expect(formatBDT(-500000n, { digits: 'en' })).toBe('-5,000');
  });

  it('shows paisa when requested', () => {
    expect(formatBDT(500050n, { digits: 'en', showPaisa: true })).toBe('5,000.50');
  });

  it('does not show paisa when zero remainder', () => {
    expect(formatBDT(500000n, { digits: 'en', showPaisa: true })).toBe('5,000');
  });
});

describe('parseBDT', () => {
  it('parses simple number', () => {
    expect(parseBDT('5000')).toBe(500000n);
  });

  it('parses with taka symbol', () => {
    expect(parseBDT('৳5,000')).toBe(500000n);
  });

  it('parses Bengali digits', () => {
    expect(parseBDT('৫,০০০')).toBe(500000n);
  });

  it('parses lakh grouping', () => {
    expect(parseBDT('1,00,000')).toBe(10000000n);
  });

  it('parses with decimal', () => {
    expect(parseBDT('5000.50')).toBe(500050n);
  });

  it('parses with spaces', () => {
    expect(parseBDT(' 5,000 ')).toBe(500000n);
  });

  it('parses Bengali digits with decimals and the taka sign', () => {
    expect(parseBDT('৳১,০০,০০০.৫০')).toBe(10000050n);
  });

  it('parses SMS-style amounts (Tk / Tk. / BDT)', () => {
    expect(parseBDT('Tk 17,500.00')).toBe(1750000n);
    expect(parseBDT('Tk. 15,500')).toBe(1550000n);
    expect(parseBDT('BDT 20,400.00')).toBe(2040000n);
  });

  it('pads a single decimal digit (5000.5 is 5000.50)', () => {
    expect(parseBDT('5000.5')).toBe(500050n);
  });

  it('keeps the sign correct for negative amounts with paisa', () => {
    expect(parseBDT('-5,000.50')).toBe(-500050n);
    expect(parseBDT('-5,000')).toBe(-500000n);
  });

  it('rejects anything that is not a clean amount instead of guessing', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '5000.567', '12e3', '--5', '5,0.0.0', '৳']) {
      expect(() => parseBDT(bad), bad).toThrow(RangeError);
    }
  });

  it('tryParseBDT returns null instead of throwing', () => {
    expect(tryParseBDT('nonsense')).toBeNull();
    expect(tryParseBDT('Tk 1,000')).toBe(100000n);
  });

  it('round-trips with formatBDT for whole and fractional taka', () => {
    for (const paisa of [0n, 5n, 100n, 123456789n, 10000000n]) {
      expect(parseBDT(formatBDT(paisa, { digits: 'bn', showPaisa: true }))).toBe(paisa);
    }
  });
});

describe('divRound', () => {
  it('divides evenly', () => {
    expect(divRound(100n, 10n)).toBe(10n);
  });

  it('rounds half up', () => {
    expect(divRound(5n, 2n)).toBe(3n);
  });

  it('rounds down when below half', () => {
    expect(divRound(4n, 3n)).toBe(1n);
  });

  it('handles negative numerator', () => {
    expect(divRound(-5n, 2n)).toBe(-3n);
  });

  it('handles negative denominator', () => {
    expect(divRound(5n, -2n)).toBe(-3n);
  });

  it('throws on division by zero', () => {
    expect(() => divRound(5n, 0n)).toThrow('Division by zero');
  });

  it('is symmetric: a reversal of a computed amount nets to zero', () => {
    for (const [a, b] of [
      [5n, 2n],
      [7n, 3n],
      [100n, 8n],
      [1n, 2n],
      [999999n, 7n],
    ] as const) {
      expect(divRound(-a, b)).toBe(-divRound(a, b));
    }
  });

  it('rounds exactly half up for positive values and keeps exact quotients exact', () => {
    expect(divRound(1n, 2n)).toBe(1n);
    expect(divRound(3n, 2n)).toBe(2n);
    expect(divRound(0n, 7n)).toBe(0n);
    expect(divRound(-6n, -3n)).toBe(2n);
  });

  it('never overflows on values beyond 2^53 (bigint end to end)', () => {
    const big = 9007199254740993n * 3n; // 2^53 + 1, tripled
    expect(divRound(big, 3n)).toBe(9007199254740993n);
  });

  it('multiply before divide for precision', () => {
    // net_assets * shares / shares_outstanding
    const netAssets = 100000000n; // 10,00,000 BDT
    const shares = 4n;
    const sharesOutstanding = 20n;
    expect(divRound(netAssets * shares, sharesOutstanding)).toBe(20000000n);
  });
});

describe('digit conversion', () => {
  it('converts to Bengali', () => {
    expect(toBengaliDigits('12345')).toBe('১২৩৪৫');
  });

  it('converts to Western', () => {
    expect(toWesternDigits('১২৩৪৫')).toBe('12345');
  });
});
