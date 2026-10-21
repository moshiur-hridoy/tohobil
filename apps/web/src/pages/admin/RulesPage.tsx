import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, Card, EmptyCard, ICONS } from '../../components/admin';
import { Chip, Icon } from '../../components/ui';
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

  const today = todayDhaka();

  return (
    <AdminPage>
      <AdminHeader
        title={t('rulesPage.title')}
        subtitle={t('adminUi.sub.rules')}
        actions={isCashier && (
          <button type="button" className={BTN_PRIMARY} onClick={() => setCreateOpen(true)}>
            <Icon d={ICONS.plus} size={18} sw={2} />
            {t('rulesPage.createRuleChange')}
          </button>
        )}
      />

      {rules.error ? (
        <LoadError error={rules.error} onRetry={() => void rules.refetch()} />
      ) : !rules.data ? (
        <ListSkeleton rows={4} />
      ) : rules.data.items.length === 0 ? (
        <Card className="p-5"><EmptyCard text={t('rulesPage.empty')} icon={ICONS.sliders} /></Card>
      ) : (
        <div className="grid items-start gap-3.5 md:grid-cols-2 2xl:grid-cols-3">
          {Object.entries(grouped ?? {}).map(([key, versions]) => {
            const sorted = [...versions].sort((x, y) => y.valid_from.localeCompare(x.valid_from));
            // in force today: the newest version that has started; a later one is a scheduled change
            const current = sorted.find((r) => r.valid_from <= today) ?? sorted[sorted.length - 1]!;
            const upcoming = sorted.filter((r) => r.valid_from > today);
            const earlier = sorted.filter((r) => r.valid_from < current.valid_from);
            return (
              <Card key={key} className="flex flex-col p-[18px]">
                <div className="flex items-start gap-3">
                  <Chip tone="bg-primary-soft text-primary" d={ICONS.sliders} size={32} iconSize={18} />
                  <div className="min-w-0 flex-1">
                    <h2 className="break-all font-mono text-[0.8125rem] font-semibold text-ink2">{key}</h2>
                    <p className="mt-1 break-words font-mono text-xl font-bold">{renderValue(current.value)}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {t('adminUi.rules.since', { date: fmtDate(current.valid_from) })}
                      {current.clause_ref && (
                        <>
                          {' · '}{t('rulesPage.clause')}{' '}
                          <Link to={`/menu/constitution?clause=${encodeURIComponent(current.clause_ref)}`} className="font-semibold text-primary hover:underline">
                            {current.clause_ref}
                          </Link>
                        </>
                      )}
                    </p>
                  </div>
                </div>
                {upcoming.map((r) => (
                  <p key={r.valid_from} className="mt-3 rounded-xl bg-warn-bg px-3 py-2 text-xs text-warn">
                    <span className="font-mono font-semibold">{renderValue(r.value)}</span> · {fmtDate(r.valid_from)}
                  </p>
                ))}
                {earlier.length > 0 && (
                  <div className="mt-3 border-t border-border pt-2">
                    <p className="text-xs font-semibold text-muted">{t('adminUi.rules.earlier')}</p>
                    <ul className="mt-1 text-xs">
                      {earlier.slice(0, 2).map((r) => (
                        <li key={r.valid_from} className="flex justify-between gap-2 py-0.5">
                          <span className="truncate font-mono text-ink2">{renderValue(r.value)}</span>
                          <span className="shrink-0 text-muted">{fmtDate(r.valid_from)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <button type="button" className="mt-3 self-start text-[0.8125rem] font-semibold text-primary hover:underline" onClick={() => setSelected(current)}>
                  {t('rulesPage.history')} ›
                </button>
              </Card>
            );
          })}
        </div>
      )}

      <CreateRuleChange open={createOpen} onClose={() => setCreateOpen(false)} />
      <RuleHistoryDialog ruleKey={selected?.key ?? null} onClose={() => setSelected(null)} />
    </AdminPage>
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
    <AdminDialog open={!!ruleKey} onClose={onClose} title={<>{t('rulesPage.history')}: <span className="font-mono">{ruleKey}</span></>}>
      {q.error ? <LoadError error={q.error} /> : !q.data ? <ListSkeleton rows={4} /> : (
        <ul className="text-sm">
          {q.data.items.map((r) => (
            <li key={r.valid_from} className="flex justify-between gap-3 border-t border-border py-2.5 first:border-t-0">
              <span className="break-all font-mono">{renderValue(r.value)}</span>
              <span className="shrink-0 text-muted">{fmtDate(r.valid_from)}</span>
            </li>
          ))}
        </ul>
      )}
    </AdminDialog>
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
        <input className="field mt-1 w-full" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('rulesPage.value')}
        <textarea className="field mt-1 min-h-20 w-full" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('rulesPage.validFrom')}
        <input type="date" className="field mt-1 w-full" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('proposal.clauseRef')}
        <input className="field mt-1 w-full" value={clause} onChange={(e) => setClause(e.target.value)} />
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
