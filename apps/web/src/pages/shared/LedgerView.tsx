import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACCOUNT_CODES } from '@barakah/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { PullToRefresh } from '../../components/PullToRefresh';
import { Empty, LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { downloadCsv } from '../../lib/csv';
import { fmtDate } from '../../lib/dates';
import { formatCount, localDigits } from '../../lib/format';
import { paisaToDecimal, taka } from '../../lib/money';
import type { AccountBalance, LedgerRow, MemberRow, Page } from '../../lib/types';

interface Verify {
  ok: boolean;
  count: number;
  last_seq: string | null;
  issues_total: number;
}

/**
 * The ledger (spec 8): filterable, with the hash, reversal links both ways and the open-objection
 * badge. Members get cards and an "Object" button; the cashier and auditor get a dense table with
 * running balances and a CSV export.
 */
export function LedgerView({ variant }: { variant: 'member' | 'admin' }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [account, setAccount] = useState('');
  const [memberId, setMemberId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [order, setOrder] = useState<'asc' | 'desc'>(variant === 'admin' ? 'asc' : 'desc');
  const [objectTo, setObjectTo] = useState<LedgerRow | null>(null);
  const [objectText, setObjectText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useRef(crypto.randomUUID());

  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members') });
  const accounts = useQuery({ queryKey: ['balances'], queryFn: () => api<{ items: AccountBalance[] }>('/accounts/balances') });

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: '50', order });
    if (account) p.set('account', account);
    if (memberId) p.set('member_id', memberId);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
  }, [account, memberId, from, to, order]);

  const q = useInfiniteQuery({
    queryKey: ['ledger', qs],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<LedgerRow>>(`/ledger?${qs}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];

  const verify = useQuery({ queryKey: ['ledger-verify'], enabled: false, queryFn: () => api<Verify>('/ledger/verify') });

  // Running balance is only honest from the first row of one account.
  const running = useMemo(() => {
    if (variant !== 'admin' || !account || from || to || order !== 'asc') return null;
    const kind = accounts.data?.items.find((a) => a.code === account)?.kind;
    const creditNormal = kind === 'liability' || kind === 'equity' || kind === 'income';
    let balance = 0n;
    const out = new Map<string, bigint>();
    for (const r of rows) {
      const amount = BigInt(r.amount_paisa);
      const raw = r.debit_account === account ? amount : -amount;
      balance += creditNormal ? -raw : raw;
      out.set(r.seq, balance);
    }
    return out;
  }, [variant, account, from, to, order, rows, accounts.data]);

  const canObject = !!me && !me.read_only;
  const refresh = () => qc.invalidateQueries({ queryKey: ['ledger'] });

  const exportCsv = () =>
    downloadCsv('ledger.csv', [
      ['seq', 'date', 'debit', 'credit', 'amount_taka', 'member', 'ref_type', 'memo', 'hash'],
      ...rows.map((r) => [r.seq, r.entry_date, r.debit_account, r.credit_account, paisaToDecimal(r.amount_paisa), r.member_code ?? '', r.ref_type ?? '', r.memo ?? '', r.hash]),
    ]);

  const submitObjection = async () => {
    if (!objectTo) return;
    await api('/objections', { method: 'POST', headers: { 'Idempotency-Key': attempt.current }, body: { ledger_seq: objectTo.seq, text: objectText.trim() } });
    setNotice(t('ledgerPage.objectSent'));
    setObjectText('');
    void refresh();
    void qc.invalidateQueries({ queryKey: ['objections'] });
  };

  const field = 'h-11 rounded-md border border-input bg-background px-2';

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className={variant === 'member' ? 'space-y-3 p-4' : 'space-y-4'}>
        {variant === 'member' ? (
          <header>
            <h2 className="text-lg font-semibold">{t('ledgerPage.title')}</h2>
            <p className="text-muted">{t('ledgerPage.subtitle')}</p>
          </header>
        ) : (
          <h1 className="text-2xl font-semibold">{t('ledgerPage.title')}</h1>
        )}

        <section aria-label={t('ledgerPage.filters')} className="grid grid-cols-2 gap-2 lg:grid-cols-6">
          <select aria-label={t('ledgerPage.account')} className={field} value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">{t('ledgerPage.anyAccount')}</option>
            {ACCOUNT_CODES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select aria-label={t('ledgerPage.memberFilter')} className={field} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">{t('ledgerPage.anyMember')}</option>
            {members.data?.items.map((m) => (
              <option key={m.id} value={m.id}>{m.code} {m.full_name}</option>
            ))}
          </select>
          <input aria-label={t('common.from')} type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input aria-label={t('common.to')} type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
          <select aria-label={t('ledgerPage.date')} className={field} value={order} onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')}>
            <option value="desc">{t('ledgerPage.newestFirst')}</option>
            <option value="asc">{t('ledgerPage.oldestFirst')}</option>
          </select>
          <div className="flex gap-2">
            <button type="button" className="h-11 flex-1 rounded-md border border-border px-2" onClick={() => void verify.refetch()} disabled={verify.isFetching}>
              {t('ledgerPage.verify')}
            </button>
            {variant === 'admin' && (
              <button type="button" className="h-11 flex-1 rounded-md border border-border px-2" onClick={exportCsv}>
                {t('ledgerPage.exportCsv')}
              </button>
            )}
          </div>
        </section>

        {verify.data && (
          <p role="status" className={verify.data.ok ? 'text-ok' : 'text-bad'}>
            {verify.data.ok ? t('ledgerPage.verifyOk', { n: formatCount(verify.data.count), seq: localDigits(verify.data.last_seq ?? '-') }) : t('ledgerPage.verifyBad', { n: formatCount(verify.data.issues_total) })}
          </p>
        )}
        {verify.error && <LoadError error={verify.error} />}
        {notice && <p role="status" className="text-ok">{notice}</p>}
        {variant === 'admin' && account && !running && <p className="text-sm text-muted">{t('ledgerPage.runningHint')}</p>}

        {q.error ? (
          <LoadError error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <ListSkeleton rows={5} />
        ) : rows.length === 0 ? (
          <Empty text={t('ledgerPage.empty')} />
        ) : variant === 'member' ? (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.seq} className="rounded-lg border border-border bg-card p-3">
                <EntryBody r={r} />
                {canObject && (
                  <button type="button" onClick={() => { attempt.current = crypto.randomUUID(); setNotice(null); setObjectTo(r); }} className="mt-2 h-10 rounded-md border border-border px-3 text-sm">
                    {t('ledgerPage.objectButton')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead className="border-b border-border text-muted">
                <tr>
                  <th className="p-2">#</th>
                  <th className="p-2">{t('ledgerPage.date')}</th>
                  <th className="p-2">{t('ledger.debit')}</th>
                  <th className="p-2">{t('ledger.credit')}</th>
                  <th className="p-2 text-right">{t('ledger.amount')}</th>
                  {running && <th className="p-2 text-right">{t('ledgerPage.runningBalance')}</th>}
                  <th className="p-2">{t('common.member')}</th>
                  <th className="p-2">{t('ledger.memo')}</th>
                  <th className="p-2">{t('ledgerPage.hash')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq} className="border-b border-border align-top last:border-0">
                    <td className="p-2">{localDigits(r.seq)}</td>
                    <td className="p-2 whitespace-nowrap">{fmtDate(r.entry_date)}</td>
                    <td className="p-2">{r.debit_account}</td>
                    <td className="p-2">{r.credit_account}</td>
                    <td className="p-2 text-right font-medium">{taka(r.amount_paisa)}</td>
                    {running && <td className="p-2 text-right">{taka(running.get(r.seq) ?? 0n)}</td>}
                    <td className="p-2">{r.member_code ?? ''}</td>
                    <td className="p-2">
                      {r.memo}
                      <Flags r={r} />
                    </td>
                    <td className="p-2 font-mono text-xs text-muted" title={r.hash}>{r.hash.slice(0, 10)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {q.hasNextPage && (
          <button type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} className="h-11 w-full rounded-md border border-border">
            {t('common.loadMore')}
          </button>
        )}

        <ConfirmSheet
          open={!!objectTo}
          onClose={() => setObjectTo(null)}
          title={t('ledgerPage.objectTitle', { seq: localDigits(objectTo?.seq ?? '') })}
          confirmLabel={t('common.submit')}
          canConfirm={objectText.trim().length >= 3}
          onConfirm={submitObjection}
        >
          {objectTo && <EntryBody r={objectTo} />}
          <p className="text-muted">{t('ledgerPage.objectBody')}</p>
          <textarea
            aria-label={t('ledgerPage.objectPlaceholder')}
            placeholder={t('ledgerPage.objectPlaceholder')}
            className="min-h-24 w-full rounded-md border border-input bg-background p-2"
            maxLength={1000}
            value={objectText}
            onChange={(e) => setObjectText(e.target.value)}
          />
        </ConfirmSheet>
      </div>
    </PullToRefresh>
  );
}

function EntryBody({ r }: { r: LedgerRow }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{taka(r.amount_paisa)}</span>
        <span className="text-sm text-muted">#{localDigits(r.seq)} · {fmtDate(r.entry_date)}</span>
      </div>
      <p className="text-sm">{r.debit_account} → {r.credit_account}{r.member_code ? ` · ${r.member_code}` : ''}</p>
      {r.memo && <p className="text-sm text-muted">{r.memo}</p>}
      <Flags r={r} />
      <p className="mt-1 break-all font-mono text-xs text-muted">{t('ledgerPage.hash')}: {r.hash.slice(0, 16)}…</p>
    </>
  );
}

function Flags({ r }: { r: LedgerRow }) {
  const { t } = useTranslation();
  return (
    <span className="block text-xs">
      {r.reverses_seq && <span className="mr-2 text-warn">{t('ledgerPage.reversal', { seq: localDigits(r.reverses_seq) })}</span>}
      {r.reversed_by_seq && <span className="mr-2 text-warn">{t('ledgerPage.reversedBy', { seq: localDigits(r.reversed_by_seq) })}</span>}
      {r.open_objections > 0 && <span className="mr-2 text-bad">⚑ {t('ledgerPage.objectionBadge', { n: formatCount(r.open_objections) })}</span>}
      {r.posted_by_code && <span className="text-muted">{t('ledgerPage.postedBy', { code: r.posted_by_code })}</span>}
    </span>
  );
}
