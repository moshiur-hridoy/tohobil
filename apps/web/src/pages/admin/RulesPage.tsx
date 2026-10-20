import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, todayDhaka } from '../../lib/dates';
import type { RuleRow, RulesResponse } from '../../lib/types';

export function RulesPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [selected, setSelected] = useState<RuleRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () => api<RulesResponse>('/rules'),
  });

  const grouped = rules.data?.items.reduce<Record<string, RuleRow[]>>((acc, r) => {
    acc[r.key] = acc[r.key] ?? [];
    acc[r.key]!.push(r);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{t('rulesPage.title')}</h1>
        {isCashier && (
          <button type="button" className="h-11 rounded-xl bg-primary px-3 text-primary-foreground" onClick={() => setCreateOpen(true)}>
            {t('rulesPage.createRuleChange')}
          </button>
        )}
      </div>

      {rules.error ? (
        <LoadError error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !rules.data ? (
        <ListSkeleton rows={4} />
      ) : rules.data.items.length === 0 ? (
        <Empty text={t('rulesPage.empty')} />
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped ?? {}).map(([key, versions]) => (
            <section key={key} className="rounded-[18px] border border-border bg-card shadow-card p-3">
              <h2 className="mb-2 font-semibold">{key}</h2>
              <ul className="divide-y divide-border text-sm">
                {versions.slice(0, 3).map((r) => (
                  <li key={`${key}-${r.valid_from}`} className="flex justify-between py-2">
                    <div>
                      <span className="font-mono">{renderValue(r.value)}</span>
                      {r.clause_ref && (
                        <span className="ml-2 text-muted">
                          {t('rulesPage.clause')}:{' '}
                          <Link to={`/menu/constitution?clause=${encodeURIComponent(r.clause_ref)}`} className="text-primary underline">
                            {r.clause_ref}
                          </Link>
                        </span>
                      )}
                    </div>
                    <div className="text-muted">{fmtDate(r.valid_from)}</div>
                  </li>
                ))}
              </ul>
              {versions.length > 3 && (
                <button type="button" className="mt-1 text-sm text-primary underline" onClick={() => setSelected(versions[0]!)}>
                  {t('rulesPage.history')}
                </button>
              )}
            </section>
          ))}
        </div>
      )}

      <CreateRuleChange open={createOpen} onClose={() => setCreateOpen(false)} />
      <RuleHistoryDialog ruleKey={selected?.key ?? null} onClose={() => setSelected(null)} />
    </div>
  );
}

function renderValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function RuleHistoryDialog({ ruleKey, onClose }: { ruleKey: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['rules', 'history', ruleKey],
    enabled: !!ruleKey,
    queryFn: () => api<RulesResponse>(`/rules?key=${ruleKey}&history=true`),
  });

  return (
    <Dialog.Root open={!!ruleKey} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,92vw)] max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{t('rulesPage.history')}: {ruleKey}</Dialog.Title>
          {q.error ? <LoadError error={q.error} /> : !q.data ? <ListSkeleton rows={4} /> : (
            <ul className="divide-y divide-border text-sm">
              {q.data.items.map((r) => (
                <li key={r.valid_from} className="flex justify-between py-2">
                  <span className="font-mono">{renderValue(r.value)}</span>
                  <span className="text-muted">{fmtDate(r.valid_from)}</span>
                </li>
              ))}
            </ul>
          )}
          <Dialog.Close className="mt-4 h-11 w-full rounded-xl border border-border">{t('common.close')}</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CreateRuleChange({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [validFrom, setValidFrom] = useState(todayDhaka());
  const [clause, setClause] = useState('');
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    setError(null);
    try {
      await api('/proposals', {
        method: 'POST',
        body: {
          type: 'rule_change',
          title: `${t('rulesPage.ruleChangeTitle')}: ${key.trim()}`,
          description: `Change ${key.trim()} effective ${validFrom}.`,
          payload: { key: key.trim(), value: parseJsonOrString(value), valid_from: validFrom, ...(clause ? { clause_ref: clause } : {}) },
          ...(clause ? { clause_ref: clause } : {}),
        },
      });
      void qc.invalidateQueries({ queryKey: ['proposals'] });
      setKey('');
      setValue('');
      setValidFrom(todayDhaka());
      setClause('');
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={t('rulesPage.createRuleChange')}
      confirmLabel={t('common.submit')}
      canConfirm={key.trim().length > 0 && value.trim().length > 0}
      onConfirm={submit}
    >
      <label className="block text-sm text-muted">
        {t('rulesPage.key')}
        <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('rulesPage.value')}
        <textarea className="mt-1 min-h-20 w-full rounded-md border border-input bg-background p-2" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('rulesPage.validFrom')}
        <input type="date" className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('proposal.clauseRef')}
        <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={clause} onChange={(e) => setClause(e.target.value)} />
      </label>
      {error != null && <p className="text-bad">{error instanceof ApiError ? error.message : String(error)}</p>}
    </ConfirmSheet>
  );
}

function parseJsonOrString(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
