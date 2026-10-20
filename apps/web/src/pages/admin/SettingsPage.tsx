import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet, SheetRow } from '../../components/ConfirmSheet';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';
import type { PaymentInstructions } from '../../lib/types';

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
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">{t('settingsPage.title')}</h1>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <h2 className="mb-3 font-semibold">{t('settingsPage.general')}</h2>
        <label className="block text-sm text-muted">
          {t('settingsPage.fundName')}
          <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={fundName} onChange={(e) => setFundName(e.target.value)} />
        </label>
      </section>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <h2 className="mb-3 font-semibold">{t('settingsPage.paymentInstructions')}</h2>
        <div className="space-y-3">
          <label className="block text-sm text-muted">
            {t('payment.methods.bkash')}
            <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={bkash} onChange={(e) => setBkash(e.target.value)} />
          </label>
          <label className="block text-sm text-muted">
            {t('payment.methods.nagad')}
            <input className="mt-1 h-11 w-full rounded-md border border-input bg-background px-2" value={nagad} onChange={(e) => setNagad(e.target.value)} />
          </label>
          <label className="block text-sm text-muted">
            {t('payment.methods.bank')}
            <textarea className="mt-1 min-h-20 w-full rounded-md border border-input bg-background p-2" value={bank} onChange={(e) => setBank(e.target.value)} />
          </label>
        </div>
      </section>

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <h2 className="mb-1 font-semibold">{t('settingsPage.zakat')}</h2>
        <p className="mb-3 text-sm text-muted">{t('settingsPage.zakatHint')}</p>
        <input type="date" aria-label={t('settingsPage.zakat')} className="h-11 rounded-md border border-input bg-background px-2" value={zakatDate} onChange={(e) => setZakatDate(e.target.value)} />
      </section>

      <div className="flex items-center gap-3">
        <button type="button" disabled={!changed || save.isPending} onClick={() => setSheet(true)} className="h-12 rounded-xl bg-primary px-4 text-primary-foreground disabled:opacity-50">
          {save.isPending ? t('common.working') : t('common.save')}
        </button>
        {saved && <p className="text-ok">{t('settingsPage.saved')}</p>}
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
    </div>
  );
}
