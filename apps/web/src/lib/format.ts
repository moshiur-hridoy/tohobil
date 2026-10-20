import { formatBDT, toBengaliDigits, type DigitSystem } from '@barakah/shared';

const DIGITS_KEY = 'barakah.digits';

/**
 * The user's numeral preference (Bengali by default). Stored locally for now; Phase 1 wires it to
 * the member's `notify_prefs.digits` setting. localStorage can throw (private mode), so guard it.
 */
export function getDigits(): DigitSystem {
  try {
    return localStorage.getItem(DIGITS_KEY) === 'en' ? 'en' : 'bn';
  } catch {
    return 'bn';
  }
}

export function setDigits(digits: DigitSystem): void {
  try {
    localStorage.setItem(DIGITS_KEY, digits);
  } catch {
    // Ignore: the preference simply will not persist.
  }
}

/** "৳৫,০০০" or "৳5,000": money always goes through formatBDT (lakh/crore grouping, no floats). */
export function formatTaka(paisa: bigint, digits: DigitSystem = getDigits()): string {
  return '৳' + formatBDT(paisa, { digits });
}

/** A plain count ("৩" or "3") in the user's numerals. */
export function formatCount(n: number, digits: DigitSystem = getDigits()): string {
  const text = String(n);
  return digits === 'bn' ? toBengaliDigits(text) : text;
}
