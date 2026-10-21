import { tryParseBDT } from '@barakah/shared';
import { formatTaka } from './format';

/** A paisa string from the API as "৳৫,০০০". */
/** Red for any amount below zero, so a negative balance is never missed. */
export const negClass = (paisa: string | bigint | null): string => (paisa !== null && BigInt(paisa) < 0n ? 'text-bad' : '');

export const taka = (paisa: string | bigint): string => formatTaka(typeof paisa === 'bigint' ? paisa : BigInt(paisa));

/** Sum of paisa strings. */
export const sumPaisa = (values: Array<string | null | undefined>): bigint =>
  values.reduce<bigint>((a, v) => a + (v ? BigInt(v) : 0n), 0n);

/**
 * What the member typed ("5,000", "৫০০০", "5000.50") as a paisa string for the API, or null when it
 * is not a positive amount. Never goes through floating point.
 */
export function parseAmountInput(text: string): string | null {
  const paisa = tryParseBDT(text.trim());
  return paisa !== null && paisa > 0n ? paisa.toString() : null;
}

/** "17500.50": plain decimal taka for CSV and input fields, built from bigint paisa (no floats). */
export function paisaToDecimal(paisa: string | bigint): string {
  const p = typeof paisa === 'bigint' ? paisa : BigInt(paisa);
  const abs = p < 0n ? -p : p;
  return `${p < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** What a member is behind on now: dues past their due date plus unpaid fines (বকেয়া). Dues generated
 *  ahead of time that are not due yet are not arrears. */
export const arrearsOf = (m: { overdue_paisa: string; outstanding_fines_paisa: string }): bigint =>
  BigInt(m.overdue_paisa) + BigInt(m.outstanding_fines_paisa);
