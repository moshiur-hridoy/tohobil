import { describe, it, expect } from 'vitest';
import {
  ZERO_HASH,
  computeLedgerHash,
  ledgerCanonical,
  verifyLedgerChain,
  type LedgerChainRow,
} from './ledger-chain';

function row(seq: number, memo: string, prevHash: string): LedgerChainRow {
  const base = {
    seq: String(seq),
    entry_date: '2026-01-05',
    debit_account: 'CASH',
    credit_account: 'MEMBER_CAPITAL',
    amount_paisa: '500000',
    member_id: null,
    ref_type: 'payment',
    ref_id: null,
    memo,
    created_by: null,
    created_at: `2026-01-05T04:00:00.12345${seq}Z`,
    prev_hash: prevHash,
    hash: '',
  };
  return { ...base, hash: computeLedgerHash(prevHash, base) };
}

function chain(n: number): LedgerChainRow[] {
  const rows: LedgerChainRow[] = [];
  let prev = ZERO_HASH;
  for (let i = 1; i <= n; i++) {
    const r = row(i, `entry ${i}`, prev);
    rows.push(r);
    prev = r.hash;
  }
  return rows;
}

describe('ledger canonical form (spec 5.6)', () => {
  it('is pipe-joined with empty strings for nulls and microsecond UTC timestamps', () => {
    const r = row(7, 'rent', ZERO_HASH);
    expect(ledgerCanonical(r)).toBe(
      '7|2026-01-05|CASH|MEMBER_CAPITAL|500000||payment||rent||2026-01-05T04:00:00.123457Z',
    );
  });
});

describe('verifyLedgerChain', () => {
  it('accepts an empty ledger', () => {
    expect(verifyLedgerChain([])).toMatchObject({
      ok: true,
      count: 0,
      lastSeq: null,
      lastHash: ZERO_HASH,
    });
  });

  it('accepts a valid chain and reports the last seq and hash', () => {
    const rows = chain(5);
    const result = verifyLedgerChain(rows);
    expect(result).toMatchObject({ ok: true, count: 5, lastSeq: '5', lastHash: rows[4]?.hash });
  });

  it('detects an edited row (hash mismatch at that seq only)', () => {
    const rows = chain(5);
    rows[2] = { ...(rows[2] as LedgerChainRow), memo: 'edited by an attacker' };
    const { ok, issues } = verifyLedgerChain(rows);
    expect(ok).toBe(false);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ seq: '3', kind: 'hash' });
  });

  it('detects a deleted row (prev_hash break at the next seq)', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    const { ok, issues } = verifyLedgerChain(rows);
    expect(ok).toBe(false);
    expect(issues).toEqual([expect.objectContaining({ seq: '4', kind: 'prev_hash' })]);
  });

  it('detects a deleted first row and a reordered pair', () => {
    expect(verifyLedgerChain(chain(3).slice(1)).ok).toBe(false);
    const swapped = chain(4);
    [swapped[1], swapped[2]] = [swapped[2] as LedgerChainRow, swapped[1] as LedgerChainRow];
    expect(verifyLedgerChain(swapped).ok).toBe(false);
  });
});
