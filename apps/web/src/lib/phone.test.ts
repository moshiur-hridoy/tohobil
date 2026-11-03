import { describe, expect, it } from 'vitest';
import { phoneForInput, phoneFromInput } from './phone';

describe('phoneFromInput', () => {
  it('reads a mobile number however it is written', () => {
    for (const raw of ['01712345678', '01712-345678', '+880 1712 345678', '8801712345678', '০১৭১২৩৪৫৬৭৮'])
      expect(phoneFromInput(raw)).toBe('+8801712345678');
  });
  it('refuses what is not a Bangladeshi mobile number', () => {
    for (const bad of ['', '0171234567', '017123456789', '01212345678', '+441712345678', 'abc']) expect(phoneFromInput(bad)).toBeNull();
  });
  it('shows the stored number the way it is typed', () => {
    expect(phoneForInput('+8801712345678')).toBe('01712345678');
  });
});
