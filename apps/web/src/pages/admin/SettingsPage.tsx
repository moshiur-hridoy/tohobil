import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, BTN_PRIMARY, Card, CardHead, FieldLabel, ICONS, Notice } from '../../components/admin';
import { Icon, DateInput } from '../../components/ui';
import { PAYMENT_METHODS, type PaymentMethod, type TelegramStatus } from '@barakah/shared';
import { api } from '../../lib/api';
import type { PaymentInstructions } from '../../lib/types';
import { ADMIN_NAV } from '../../layouts/CashierLayout';
import { ALWAYS_SHOWN, useHiddenNav } from '../../lib/navPrefs';
import { ActionError, TelegramCard } from './TelegramCard';

type Pay = Required<PaymentInstructions>;
const PAY_TEXT = ['bkash', 'nagad', 'bank', 'bank_account', 'bank_holder', 'bank_branch'] as const;

/** The stored value with every field present, so an old value and the form compare cleanly. */
function payFrom(v: PaymentInstructions | undefined): Pay {
  return {
    bkash: v?.bkash ?? '',
    nagad: v?.nagad ?? '',
    bank: v?.bank ?? '',
    bank_account: v?.bank_account ?? '',
    bank_holder: v?.bank_holder ?? '',
    bank_branch: v?.bank_branch ?? '',
    methods: v?.methods?.length ? PAYMENT_METHODS.filter((m) => v.methods!.includes(m)) : ['bkash', 'bank', 'cash'],
  };
}
const samePay = (a: Pay, b: Pay): boolean => PAY_TEXT.every((k) => a[k].trim() === b[k].trim()) && a.methods.join() === b.methods.join();

interface SettingsResponse {
  payment_instructions?: PaymentInstructions;
  fund_name?: string;
  zakat_notice_date?: string;
}

const SECTIONS = [
  { id: 'general', icon: ICONS.sliders },
  { id: 'payments', icon: ICONS.wallet },
  { id: 'telegram', icon: ICONS.message },
  { id: 'device', icon: ICONS.grid },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

/**
 * Settings, one section at a time: a short menu on the left (a row of pills on a phone) and the chosen
 * section on the right. The section lives in `?tab=` so a link can open it. Each form saves on its own,
 * so an unsaved change is never hidden in a section that is not on screen.
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab: SectionId = SECTIONS.some((s) => s.id === params.get('tab')) ? (params.get('tab') as SectionId) : 'general';
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResponse>('/settings') });
  const telegram = useQuery({ queryKey: ['telegram'], queryFn: () => api<TelegramStatus>('/telegram') });

  if (settings.error) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} />;

  return (
    <AdminPage>
      <AdminHeader title={t('settingsPage.title')} subtitle={t('adminUi.sub.settings')} />

      <div className="grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label={t('settingsPage.sectionsNav')}
          className="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-4 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0"
        >
          {SECTIONS.map((s) => {
            const active = s.id === tab;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => setParams(s.id === 'general' ? {} : { tab: s.id }, { replace: true })}
                className={`flex shrink-0 items-center gap-2.5 rounded-full border px-3.5 py-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-11 lg:rounded-xl lg:border-transparent lg:px-3 ${
                  active
                    ? 'border-primary bg-primary-soft font-semibold text-primary'
                    : 'border-border bg-card text-ink2 hover:bg-hover lg:bg-transparent'
                }`}
              >
                <Icon d={s.icon} size={17} />
                <span className="whitespace-nowrap">{t(`settingsPage.nav.${s.id}`)}</span>
                {s.id === 'telegram' && telegram.data?.enabled && (
                  <span className="ml-auto h-2 w-2 rounded-full bg-ok" aria-label={t('settingsPage.telegram.on')} />
                )}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 max-w-3xl space-y-5">
          {tab === 'general' && <GeneralSection data={settings.data} />}
          {tab === 'payments' && <PaymentsSection data={settings.data} />}
          {tab === 'telegram' && <TelegramCard />}
          {tab === 'device' && <SidePanelCard />}
        </div>
      </div>
    </AdminPage>
  );
}

/** Saves one settings key per call; the server asks for the authenticator code. */
function useSaveSettings(onDone: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changes: { key: string; value: unknown }[]) =>
      Promise.all(changes.map((body) => api('/settings', { method: 'PATCH', body }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['payment-instructions'] });
      onDone();
    },
  });
}

/** The bottom of a form: "unsaved changes", the save button, the result. */
function SaveRow({ changed, busy, saved, error, onSave }: { changed: boolean; busy: boolean; saved: boolean; error: unknown; onSave: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
        {changed && <span className="text-sm font-medium text-warn">{t('adminUi.settings.unsaved')}</span>}
        <button type="button" disabled={!changed || busy} onClick={onSave} className={BTN_PRIMARY}>
          <Icon d={ICONS.check} size={18} sw={2} />
          {busy ? t('common.working') : t('common.save')}
        </button>
      </div>
      <Notice text={saved ? t('settingsPage.saved') : null} className="mt-3" />
      <ActionError error={error} />
    </>
  );
}

function useFlag(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  return [on, () => {
    setOn(true);
    window.setTimeout(() => setOn(false), 3000);
  }];
}

function GeneralSection({ data }: { data: SettingsResponse | undefined }) {
  const { t } = useTranslation();
  const [fundName, setFundName] = useState(data?.fund_name ?? '');
  const [zakatDate, setZakatDate] = useState(data?.zakat_notice_date ?? '');
  const [saved, flash] = useFlag();
  const save = useSaveSettings(flash);

  useEffect(() => {
    setFundName(data?.fund_name ?? '');
    setZakatDate(data?.zakat_notice_date ?? '');
  }, [data]);

  const nameChanged = fundName.trim() !== (data?.fund_name ?? '') && fundName.trim() !== '';
  const zakatChanged = zakatDate !== (data?.zakat_notice_date ?? '') && zakatDate !== '';

  return (
    <Card className="p-5">
      <CardHead icon={ICONS.sliders} title={t('settingsPage.general')} />
      <div className="space-y-5">
        <FieldLabel label={t('settingsPage.fundName')}>
          <input className="field w-full" value={fundName} onChange={(e) => setFundName(e.target.value)} />
        </FieldLabel>
        <div>
          <FieldLabel label={t('settingsPage.zakat')}>
            <DateInput aria-label={t('settingsPage.zakat')} className="field" value={zakatDate} onChange={(e) => setZakatDate(e.target.value)} />
          </FieldLabel>
          <p className="field-hint mt-1.5">{t('settingsPage.zakatHint')}</p>
        </div>
      </div>
      <SaveRow
        changed={nameChanged || zakatChanged}
        busy={save.isPending}
        saved={saved}
        error={save.error}
        onSave={() =>
          save.mutate([
            ...(nameChanged ? [{ key: 'fund_name', value: fundName.trim() }] : []),
            ...(zakatChanged ? [{ key: 'zakat_notice_date', value: zakatDate }] : []),
          ])
        }
      />
    </Card>
  );
}

function PaymentsSection({ data }: { data: SettingsResponse | undefined }) {
  const { t } = useTranslation();
  const stored = payFrom(data?.payment_instructions);
  const [pay, setPay] = useState<Pay>(stored);
  const [saved, flash] = useFlag();
  const save = useSaveSettings(flash);

  useEffect(() => setPay(payFrom(data?.payment_instructions)), [data]);

  const setText = (k: (typeof PAY_TEXT)[number], v: string) => setPay((p) => ({ ...p, [k]: v }));
  const toggleMethod = (m: PaymentMethod, on: boolean) =>
    setPay((p) => ({ ...p, methods: PAYMENT_METHODS.filter((x) => (x === m ? on : p.methods.includes(x))) }));
  const field = (k: (typeof PAY_TEXT)[number], label: string, numeric = false): ReactNode => (
    <FieldLabel label={label}>
      <input className="field w-full" inputMode={numeric ? 'numeric' : undefined} value={pay[k]} onChange={(e) => setText(k, e.target.value)} />
    </FieldLabel>
  );

  return (
    <Card className="p-5">
      <CardHead icon={ICONS.wallet} tone="bg-blue-bg text-blue" title={t('settingsPage.paymentInstructions')} sub={t('settingsPage.paymentsHint')} />
      <fieldset className="mb-5">
        <legend className="mb-1 text-sm font-semibold">{t('settingsPage.memberMethods')}</legend>
        <p className="mb-2 text-sm text-muted">{t('settingsPage.memberMethodsHint')}</p>
        <div className="flex flex-wrap gap-2">
          {PAYMENT_METHODS.map((m) => {
            const on = pay.methods.includes(m);
            return (
              <label key={m} className={`flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${on ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-border text-ink2'}`}>
                <input type="checkbox" className="h-4 w-4" checked={on} disabled={on && pay.methods.length === 1} onChange={(e) => toggleMethod(m, e.target.checked)} />
                {t(`payment.methods.${m}`)}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-4">
        {(pay.methods.includes('bkash') || pay.methods.includes('nagad')) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {pay.methods.includes('bkash') && field('bkash', t('payment.methods.bkash'))}
            {pay.methods.includes('nagad') && field('nagad', t('payment.methods.nagad'))}
          </div>
        )}
        {pay.methods.includes('bank') && (
          <div className="rounded-xl border border-border p-4">
            <p className="mb-3 text-sm font-semibold">{t('payment.methods.bank')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {field('bank_account', t('pay.bankAccount'), true)}
              {field('bank_holder', t('pay.bankHolder'))}
              {field('bank', t('pay.bankName'))}
              {field('bank_branch', t('pay.bankBranch'))}
            </div>
          </div>
        )}
      </div>

      <SaveRow
        changed={!samePay(pay, stored)}
        busy={save.isPending}
        saved={saved}
        error={save.error}
        onSave={() =>
          save.mutate([
            {
              key: 'payment_instructions',
              value: { ...Object.fromEntries(PAY_TEXT.map((k) => [k, pay[k].trim()])), methods: pay.methods },
            },
          ])
        }
      />
    </Card>
  );
}

/** Which side-panel links to show. Kept on this device and applied at once; it needs no save. */
function SidePanelCard() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useHiddenNav();
  return (
    <Card className="p-5">
      <CardHead icon={ICONS.grid} tone="bg-soft text-ink2" title={t('settingsPage.sidePanel')} sub={t('settingsPage.sidePanelHint')} />
      <ul className="grid gap-1 sm:grid-cols-2">
        {ADMIN_NAV.filter(([to]) => !ALWAYS_SHOWN.includes(to)).map(([to, key]) => (
          <li key={to}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-2 text-sm hover:bg-hover">
              <input type="checkbox" className="h-4 w-4" checked={!hidden.has(to)} onChange={(e) => setHidden(to, !e.target.checked)} />
              <span className={hidden.has(to) ? 'text-muted line-through' : ''}>{t(key)}</span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}
