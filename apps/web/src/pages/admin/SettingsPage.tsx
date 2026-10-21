import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { LoadError } from '../../components/StateViews';
import { AdminHeader, AdminPage, BTN_PRIMARY, Card, CardHead, FieldLabel, ICONS, Notice } from '../../components/admin';
import { Icon } from '../../components/ui';
import { api } from '../../lib/api';
import type { PaymentInstructions } from '../../lib/types';
import { ADMIN_NAV } from '../../layouts/CashierLayout';
import { ALWAYS_SHOWN, useHiddenNav } from '../../lib/navPrefs';

interface SettingsResponse {
  payment_instructions?: PaymentInstructions;
  fund_name?: string;
  zakat_notice_date?: string;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsResponse>('/settings'),
  });

  const [fundName, setFundName] = useState(settings.data?.fund_name ?? '');
  const [bkash, setBkash] = useState(settings.data?.payment_instructions?.bkash ?? '');
  const [nagad, setNagad] = useState(settings.data?.payment_instructions?.nagad ?? '');
  const [bank, setBank] = useState(settings.data?.payment_instructions?.bank ?? '');
  const [zakatDate, setZakatDate] = useState(settings.data?.zakat_notice_date ?? '');
  const [sheet, setSheet] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setFundName(settings.data.fund_name ?? '');
      setBkash(settings.data.payment_instructions?.bkash ?? '');
      setNagad(settings.data.payment_instructions?.nagad ?? '');
      setBank(settings.data.payment_instructions?.bank ?? '');
      setZakatDate(settings.data.zakat_notice_date ?? '');
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async () => {
      const promises: Promise<unknown>[] = [];
      if (fundName !== (settings.data?.fund_name ?? '')) {
        promises.push(api('/settings', { method: 'PATCH', body: { key: 'fund_name', value: fundName.trim() } }));
      }
      const next = { bkash: bkash.trim() || '', nagad: nagad.trim() || '', bank: bank.trim() || '' };
      const current = settings.data?.payment_instructions ?? { bkash: '', nagad: '', bank: '' };
      if (next.bkash !== current.bkash || next.nagad !== current.nagad || next.bank !== current.bank) {
        promises.push(api('/settings', { method: 'PATCH', body: { key: 'payment_instructions', value: next } }));
      }
      if (zakatDate !== (settings.data?.zakat_notice_date ?? '') && zakatDate) {
        promises.push(api('/settings', { method: 'PATCH', body: { key: 'zakat_notice_date', value: zakatDate } }));
      }
      await Promise.all(promises);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['payment-instructions'] });
      setSaved(true);
      setSheet(false);
      window.setTimeout(() => setSaved(false), 3000);
    },
  });

  const changed =
    fundName !== (settings.data?.fund_name ?? '') ||
    bkash !== (settings.data?.payment_instructions?.bkash ?? '') ||
    nagad !== (settings.data?.payment_instructions?.nagad ?? '') ||
    bank !== (settings.data?.payment_instructions?.bank ?? '') ||
    (zakatDate !== (settings.data?.zakat_notice_date ?? '') && zakatDate !== '');

  if (settings.error) return <LoadError error={settings.error} onRetry={() => void settings.refetch()} />;

  return (
    <AdminPage>
      <AdminHeader
        title={t('settingsPage.title')}
        subtitle={t('adminUi.sub.settings')}
        actions={
          <>
            {changed && <span className="text-sm font-medium text-warn">{t('adminUi.settings.unsaved')}</span>}
            <button type="button" disabled={!changed || save.isPending} onClick={() => setSheet(true)} className={BTN_PRIMARY}>
              <Icon d={ICONS.check} size={18} sw={2} />
              {save.isPending ? t('common.working') : t('common.save')}
            </button>
          </>
        }
      />
      <Notice text={saved ? t('settingsPage.saved') : null} />

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Card className="p-5">
            <CardHead icon={ICONS.sliders} title={t('settingsPage.general')} />
            <FieldLabel label={t('settingsPage.fundName')}>
              <input className="field w-full" value={fundName} onChange={(e) => setFundName(e.target.value)} />
            </FieldLabel>
          </Card>

          <Card className="p-5">
            <CardHead icon={ICONS.clock} tone="bg-warn-bg text-warn" title={t('settingsPage.zakat')} sub={t('settingsPage.zakatHint')} />
            <input type="date" aria-label={t('settingsPage.zakat')} className="field" value={zakatDate} onChange={(e) => setZakatDate(e.target.value)} />
          </Card>
        </div>

        <SidePanelCard />

        <Card className="p-5">
          <CardHead icon={ICONS.wallet} tone="bg-blue-bg text-blue" title={t('settingsPage.paymentInstructions')} />
          <div className="space-y-3">
            <FieldLabel label={t('payment.methods.bkash')}>
              <input className="field w-full" value={bkash} onChange={(e) => setBkash(e.target.value)} />
            </FieldLabel>
            <FieldLabel label={t('payment.methods.nagad')}>
              <input className="field w-full" value={nagad} onChange={(e) => setNagad(e.target.value)} />
            </FieldLabel>
            <FieldLabel label={t('payment.methods.bank')}>
              <textarea className="field min-h-24 w-full" value={bank} onChange={(e) => setBank(e.target.value)} />
            </FieldLabel>
          </div>
        </Card>
      </div>

      <ConfirmSheet
        open={sheet}
        onClose={() => setSheet(false)}
        title={t('settingsPage.saveTitle')}
        confirmLabel={t('common.save')}
        onConfirm={async () => {
          await save.mutateAsync();
        }}
      >
        {fundName !== (settings.data?.fund_name ?? '') && <SheetRow label={t('settingsPage.fundName')} value={fundName.trim()} />}
        {(bkash !== (settings.data?.payment_instructions?.bkash ?? '') || nagad !== (settings.data?.payment_instructions?.nagad ?? '') || bank !== (settings.data?.payment_instructions?.bank ?? '')) && (
          <SheetRow label={t('settingsPage.paymentInstructions')} value={t('settingsPage.changed')} />
        )}
        {save.error && <p className="text-bad">{t('errors.generic')}</p>}
      </ConfirmSheet>
    </AdminPage>
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
