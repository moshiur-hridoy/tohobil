import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import { AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, Card, CardHead, EmptyCard, ICONS } from '../../components/admin';
import { Icon } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useAuth } from '../../lib/auth';
import { fmtDate, todayDhaka } from '../../lib/dates';
import { formatCount } from '../../lib/format';
import { paisaToDecimal } from '../../lib/money';
import { RULE_GROUPS, ruleHint, ruleKind, ruleName, ruleValueText } from '../../lib/ruleText';
import type { RuleRow, RulesResponse } from '../../lib/types';
import { tryParseBDT } from '@barakah/shared';

export function RulesPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  // null: closed; '': open with no rule picked; a key: open for that rule
  const [changeKey, setChangeKey] = useState<string | null>(null);

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
  const current = Object.fromEntries(Object.entries(grouped ?? {}).map(([k, v]) => [k, currentOf(v, today).value]));
  const clauses = Object.fromEntries(Object.entries(grouped ?? {}).map(([k, v]) => [k, currentOf(v, today).clause_ref]));

  // each section with the rules that exist; anything unplaced goes to "other"
  const placed = new Set(RULE_GROUPS.flatMap((g) => g.keys));
  const sections = [
    ...RULE_GROUPS.map((g) => ({ ...g, keys: g.keys.filter((k) => grouped?.[k]) })),
    { id: 'other', icon: ICONS.sliders, keys: Object.keys(grouped ?? {}).filter((k) => !placed.has(k)).sort() },
  ].filter((g) => g.keys.length > 0);

  return (
    <AdminPage>
      <AdminHeader
        title={t('rulesPage.title')}
        subtitle={t('adminUi.sub.rules')}
        actions={isCashier && (
          <button type="button" className={BTN_PRIMARY} onClick={() => setChangeKey('')}>
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
        <>
          <nav aria-label={t('rulesPage.sectionsNav')} className="flex gap-2 overflow-x-auto pb-1">
            {sections.map((g) => (
              <a
                key={g.id}
                href={`#rules-${g.id}`}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-[0.8125rem] font-medium text-ink2 transition-colors hover:bg-hover"
              >
                <Icon d={g.icon} size={15} />
                {t(`rulesPage.groups.${g.id}.title`)}
                <span className="text-xs text-muted">{formatCount(g.keys.length)}</span>
              </a>
            ))}
          </nav>

          {sections.map((g) => (
            <Card key={g.id} id={`rules-${g.id}`} className="scroll-mt-4 p-[18px] sm:p-5">
              <CardHead icon={g.icon} title={t(`rulesPage.groups.${g.id}.title`)} sub={t(`rulesPage.groups.${g.id}.sub`)} />
              <ul>
                {g.keys.map((key) => (
                  <RuleItem
                    key={key}
                    ruleKey={key}
                    versions={grouped![key]!}
                    today={today}
                    canPropose={isCashier}
                    onPropose={() => setChangeKey(key)}
                    onHistory={() => setHistoryKey(key)}
                  />
                ))}
              </ul>
            </Card>
          ))}

          <Card className="p-[18px] sm:p-5">
            <CardHead icon={ICONS.alert} tone="bg-soft text-ink2" title={t('rulesPage.newRule.title')} />
            <p className="text-sm text-ink2">{t('rulesPage.newRule.body1')}</p>
            <p className="mt-2 text-sm text-ink2">{t('rulesPage.newRule.body2')}</p>
          </Card>
        </>
      )}

      <CreateRuleChange key={changeKey ?? 'closed'} open={changeKey !== null} presetKey={changeKey ?? ''} onClose={() => setChangeKey(null)} current={current} clauses={clauses} />
      <RuleHistoryDialog ruleKey={historyKey} onClose={() => setHistoryKey(null)} />
    </AdminPage>
  );
}

/** One rule as a row: name and plain explanation on the left, the value on the right, a ⋮ menu. */
function RuleItem({ ruleKey: key, versions, today, canPropose, onPropose, onHistory }: {
  ruleKey: string;
  versions: RuleRow[];
  today: string;
  canPropose: boolean;
  onPropose: () => void;
  onHistory: () => void;
}) {
  const { t } = useTranslation();
  const current = currentOf(versions, today);
  const upcoming = versions.filter((r) => r.valid_from > today).sort((x, y) => x.valid_from.localeCompare(y.valid_from));
  const hint = ruleHint(t, key);
  return (
    <li className="flex items-start gap-3 border-t border-border py-3.5 first:border-t-0 first:pt-1 last:pb-0">
      <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.9375rem] font-semibold">{ruleName(t, key)}</h3>
          {hint && <p className="mt-0.5 text-[0.8125rem] text-muted">{hint}</p>}
          <p className="mt-1 text-xs text-muted">
            {t('adminUi.rules.since', { date: fmtDate(current.valid_from) })}
            {current.clause_ref && (
              <>
                {' · '}
                <Link to={`/menu/constitution?clause=${encodeURIComponent(current.clause_ref)}`} className="font-semibold text-primary hover:underline">
                  {t('rulesPage.clause')} {current.clause_ref}
                </Link>
              </>
            )}
          </p>
          {upcoming.map((r) => (
            <p key={r.valid_from} className="mt-2 inline-block rounded-lg bg-warn-bg px-2.5 py-1 text-xs text-warn">
              {t('rulesPage.upcoming', { value: ruleValueText(t, key, r.value), date: fmtDate(r.valid_from) })}
            </p>
          ))}
        </div>
        <p className="mt-1.5 break-words text-lg font-bold sm:mt-0 sm:max-w-[45%] sm:text-right">{ruleValueText(t, key, current.value)}</p>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={t('rulesPage.menu', { name: ruleName(t, key) })}
          className="-mr-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon d={DOTS} size={18} sw={2.4} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-[13rem] rounded-xl border border-border bg-card p-1 shadow-lift">
            {canPropose && (
              <DropdownMenu.Item onSelect={onPropose} className={MENU_ITEM}>
                <Icon d={ICONS.sliders} size={16} />
                {t('rulesPage.proposeChange')}
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item onSelect={onHistory} className={MENU_ITEM}>
              <Icon d={ICONS.clock} size={16} />
              {t('rulesPage.seeHistory')}
            </DropdownMenu.Item>
            {current.clause_ref && (
              <DropdownMenu.Item asChild className={MENU_ITEM}>
                <Link to={`/menu/constitution?clause=${encodeURIComponent(current.clause_ref)}`}>
                  <Icon d={ICONS.book} size={16} />
                  {t('rulesPage.readClause', { clause: current.clause_ref })}
                </Link>
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

// three vertical dots
const DOTS = 'M12 5h.01M12 12h.01M12 19h.01';
const MENU_ITEM =
  'flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-foreground outline-none data-[highlighted]:bg-hover';

/** The version in force today: the newest that has started; a later one is a scheduled change. */
function currentOf(versions: RuleRow[], today: string): RuleRow {
  const sorted = [...versions].sort((x, y) => y.valid_from.localeCompare(x.valid_from));
  return sorted.find((r) => r.valid_from <= today) ?? sorted[sorted.length - 1]!;
}

function RuleHistoryDialog({ ruleKey, onClose }: { ruleKey: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['rules', 'history', ruleKey],
    enabled: !!ruleKey,
    queryFn: () => api<RulesResponse>(`/rules?key=${ruleKey}&history=true`),
  });

  return (
    <AdminDialog open={!!ruleKey} onClose={onClose} title={<>{t('rulesPage.history')}: {ruleKey ? ruleName(t, ruleKey) : ''}</>}>
      {q.error ? <LoadError error={q.error} /> : !q.data ? <ListSkeleton rows={4} /> : (
        <ul className="text-sm">
          {q.data.items.map((r) => (
            <li key={r.valid_from} className="flex justify-between gap-3 border-t border-border py-2.5 first:border-t-0">
              <span className="break-all">{ruleValueText(t, r.key, r.value)}</span>
              <span className="shrink-0 text-muted">{fmtDate(r.valid_from)}</span>
            </li>
          ))}
        </ul>
      )}
    </AdminDialog>
  );
}

function CreateRuleChange({ open, presetKey, onClose, current, clauses }: {
  open: boolean;
  presetKey: string;
  onClose: () => void;
  current: Record<string, unknown>;
  clauses: Record<string, string | null>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  // the page remounts this form each time it opens (see `key` there), so the preset applies afresh
  const [key, setKey] = useState(presetKey);
  const [value, setValue] = useState(presetKey in current ? toInputText(presetKey, current[presetKey]) : '');
  const [validFrom, setValidFrom] = useState(todayDhaka());
  const [clause, setClause] = useState(clauses[presetKey] ?? '');
  const [error, setError] = useState<unknown>(null);

  // only rules that exist: a brand-new key would be stored but nothing in the app would read it
  const keys = Object.keys(current)
    .sort((a, b) => ruleName(t, a).localeCompare(ruleName(t, b), 'bn'));
  const kind = ruleKind(key);
  const parsed = toRuleValue(key, value, current[key]);

  const pickKey = (next: string) => {
    setKey(next);
    setValue(next in current ? toInputText(next, current[next]) : '');
    setClause(clauses[next] ?? '');
  };

  const submit = async () => {
    if (parsed === undefined) return;
    setError(null);
    try {
      await api('/proposals', {
        method: 'POST',
        body: {
          type: 'rule_change',
          title: `${t('rulesPage.ruleChangeTitle')}: ${ruleName(t, key)}`,
          description: `Change ${key} effective ${validFrom}.`,
          payload: { key, value: parsed, valid_from: validFrom, ...(clause ? { clause_ref: clause } : {}) },
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
      canConfirm={key.length > 0 && parsed !== undefined}
      onConfirm={submit}
    >
      <p className="mb-3 rounded-xl bg-soft px-3 py-2.5 text-[0.8125rem] text-ink2">{t('rulesPage.howItWorks')}</p>
      <label className="block text-sm text-muted">
        {t('rulesPage.pickRule')}
        <select className="field mt-1 w-full" value={key} onChange={(e) => pickKey(e.target.value)}>
          <option value="" disabled>—</option>
          {keys.map((k) => <option key={k} value={k}>{ruleName(t, k)}</option>)}
        </select>
      </label>
      {key && (
        <p className="mt-1 text-xs text-muted">
          {ruleHint(t, key)}
          {key in current && <> {t('rulesPage.currentValue', { value: ruleValueText(t, key, current[key]) })}</>}
        </p>
      )}
      {key && (
        <label className="mt-2 block text-sm text-muted">
          {kind === 'paisa' ? t('rulesPage.valueTaka') : isWholeNumber(kind) ? t('rulesPage.valueNumber') : t('rulesPage.value')}
          {kind === 'bool' ? (
            <select className="field mt-1 w-full" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="" disabled>—</option>
              <option value="true">{t('rulesPage.units.yes')}</option>
              <option value="false">{t('rulesPage.units.no')}</option>
            </select>
          ) : kind === 'date' ? (
            <input type="date" className="field mt-1 w-full" value={value} onChange={(e) => setValue(e.target.value)} />
          ) : kind === undefined ? (
            <textarea className="field mt-1 min-h-20 w-full" value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input className="field mt-1 w-full" inputMode={kind === 'paisa' || isWholeNumber(kind) ? 'decimal' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} />
          )}
        </label>
      )}
      <label className="mt-2 block text-sm text-muted">
        {t('rulesPage.validFrom')}
        <input type="date" className="field mt-1 w-full" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </label>
      <label className="mt-2 block text-sm text-muted">
        {t('proposal.clauseRef')}
        <input className="field mt-1 w-full" value={clause} onChange={(e) => setClause(e.target.value)} />
      </label>
      {key && <p className="mt-2 text-xs text-muted">{t('rulesPage.technicalKey')}: <span className="font-mono">{key}</span></p>}
      {error != null && <p className="mt-2 text-sm text-bad">{errorMessage(t, error).message}</p>}
    </ConfirmSheet>
  );
}

const isWholeNumber = (kind: ReturnType<typeof ruleKind>) =>
  kind === 'dayOfMonth' || kind === 'days' || kind === 'hours' || kind === 'months' || kind === 'percent' || kind === 'times' || kind === 'count';

/** What the form field starts with for a rule's current value (taka for money, not paisa). */
function toInputText(key: string, value: unknown): string {
  const kind = ruleKind(key);
  if (kind === 'paisa' && (typeof value === 'number' || typeof value === 'string')) return paisaToDecimal(String(value)).replace(/\.00$/, '');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The typed text as the value stored for the rule, or undefined when it does not fit the rule.
 * Money is typed in taka and stored as paisa, in the same JSON type (number or string) the rule has now.
 */
function toRuleValue(key: string, text: string, now: unknown): unknown {
  const kind = ruleKind(key);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (kind === 'paisa') {
    const paisa = tryParseBDT(trimmed);
    if (paisa === null || paisa < 0n) return undefined;
    return typeof now === 'string' ? paisa.toString() : Number(paisa);
  }
  if (isWholeNumber(kind)) {
    const n = tryParseBDT(trimmed);
    // tryParseBDT reads taka; a whole number of taka is a whole number here
    if (n === null || n < 0n || n % 100n !== 0n) return undefined;
    return Number(n / 100n);
  }
  if (kind === 'bool') return trimmed === 'true';
  if (kind === undefined) return parseJsonOrString(trimmed);
  return trimmed;
}

function parseJsonOrString(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
