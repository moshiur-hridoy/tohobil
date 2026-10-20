import { describe, it, expect } from 'vitest';
import {
  addMonths,
  createFakeClock,
  currentPeriod,
  dateInPeriod,
  formatDateBn,
  isValidIsoDate,
  parseDDMMYYYY,
  parseDDMonYYYY,
  periodEnd,
  toDhakaDate,
} from './date';

describe('toDhakaDate', () => {
  it('uses the Asia/Dhaka calendar day, not UTC', () => {
    // 20:00 UTC on 31 Jan is 02:00 on 1 Feb in Dhaka (UTC+6).
    expect(toDhakaDate(new Date('2026-01-31T20:00:00Z'))).toBe('2026-02-01');
    expect(toDhakaDate(new Date('2026-01-31T17:59:59Z'))).toBe('2026-01-31');
    expect(toDhakaDate(new Date('2026-01-31T18:00:00Z'))).toBe('2026-02-01');
  });
});

describe('Clock', () => {
  it('fake clock simulates months (jobs depend on this)', () => {
    const clock = createFakeClock(new Date('2026-01-20T05:00:00Z'));
    expect(clock.todayDhaka()).toBe('2026-01-20');
    clock.advance(24 * 3600 * 1000);
    expect(clock.todayDhaka()).toBe('2026-01-21');
    clock.set(new Date('2026-12-31T19:00:00Z'));
    expect(clock.todayDhaka()).toBe('2027-01-01');
    expect(currentPeriod(clock)).toBe('2027-01');
  });
});

describe('periods', () => {
  it('addMonths crosses year boundaries in both directions', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-01', -13)).toBe('2024-12');
    expect(addMonths('2026-06', 0)).toBe('2026-06');
  });

  it('periodEnd handles leap years', () => {
    expect(periodEnd('2028-02')).toBe('2028-02-29');
    expect(periodEnd('2027-02')).toBe('2027-02-28');
    expect(periodEnd('2026-12')).toBe('2026-12-31');
  });

  it('dateInPeriod builds a due date and clamps to the month length', () => {
    expect(dateInPeriod('2026-11', 20)).toBe('2026-11-20');
    expect(dateInPeriod('2026-11', 5)).toBe('2026-11-05');
    expect(dateInPeriod('2026-11', 31)).toBe('2026-11-30');
    expect(dateInPeriod('2027-02', 30)).toBe('2027-02-28');
    expect(dateInPeriod('2028-02', 30)).toBe('2028-02-29');
    expect(dateInPeriod('2026-11', 0)).toBe('2026-11-01');
  });
});

describe('isValidIsoDate', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2027-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-00-10')).toBe(false);
    expect(isValidIsoDate('2026-04-31')).toBe(false);
    expect(isValidIsoDate('2026-4-3')).toBe(false);
  });
});

describe('SMS date parsing', () => {
  it('parses DD/MM/YYYY', () => {
    expect(parseDDMMYYYY('TrxID AB12 at 30/12/2025 22:00')).toBe('2025-12-30');
  });
  it('rejects impossible DD/MM/YYYY dates', () => {
    expect(parseDDMMYYYY('at 31/02/2026')).toBeNull();
    expect(parseDDMMYYYY('no date here')).toBeNull();
  });
  it('parses DD-Mon-YYYY case-insensitively', () => {
    expect(parseDDMonYYYY('28-Dec-2025 Tk. 15,500')).toBe('2025-12-28');
    expect(parseDDMonYYYY('28-DEC-2025')).toBe('2025-12-28');
    expect(parseDDMonYYYY('28-Foo-2025')).toBeNull();
  });
});

describe('formatDateBn', () => {
  it('honours the digits setting', () => {
    expect(formatDateBn('2026-01-20')).toBe('২০ জানুয়ারি ২০২৬');
    expect(formatDateBn('2026-01-20', { digits: 'en' })).toBe('20 জানুয়ারি 2026');
  });
});
