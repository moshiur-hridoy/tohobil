import { tryParseBDT } from '@barakah/shared';
import { formatTaka } from './format';

/** A paisa string from the API as "৳৫,০০০". */
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
