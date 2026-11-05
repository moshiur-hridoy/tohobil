import { describe, expect, it } from 'vitest';
import { splitTimeLeft } from './countdown';

describe('splitTimeLeft', () => {
  it('splits the time left into days, hours, minutes and seconds', () => {
    const ms = (((2 * 24 + 5) * 60 + 12) * 60 + 9) * 1000 + 999;
    expect(splitTimeLeft(ms)).toEqual({ days: 2, hours: 5, minutes: 12, seconds: 9 });
  });

  it('counts the last second down to zero, then reports the time up', () => {
    expect(splitTimeLeft(1)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0 });
    expect(splitTimeLeft(0)).toBeNull();
    expect(splitTimeLeft(-5000)).toBeNull();
  });
});
