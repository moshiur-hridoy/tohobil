import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { LoadError } from '../../components/StateViews';
import { Skeleton } from '../../components/Skeleton';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtInstant } from '../../lib/dates';
import { useState } from 'react';

interface Backup {
  ok: boolean;
  finished?: string;
  size?: number;
  error?: string;
}

interface Status {
  backup: Backup | null;
  restore_test: (Backup & { verified?: boolean }) | null;
  ledger_verify: { at: string; ok: boolean; count: number; issues: number } | null;
  offline_copy: { on: string } | null;
  queue_depth: number | null;
  disk: { free_bytes: number; total_bytes: number } | null;
}

interface Verification {
  ok: boolean;
  count: number;
  last_hash: string;
  issues_total: number;
}

const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
const mb = (bytes: number): string => (bytes / 1024 ** 2).toFixed(1);

/** Is the fund safe: the last backup, the weekly restore test, the ledger chain, the job queue and the disk. */
export function AdminSystemStatusPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [confirmCopy, setConfirmCopy] = useState(false);
  const status = useQuery({ queryKey: ['system-status'], queryFn: () => api<Status>('/system/status'), refetchInterval: 60_000 });
  const verify = useMutation({ mutationFn: () => api<Verification>('/ledger/verify') });
  const isCashier = me?.roles.includes('cashier') ?? false;

  const card = (title: string, ok: boolean | null, lines: string[]) => (
    <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${ok === null ? 'bg-soft text-muted' : ok ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad'}`}>
          {ok === null ? t('systemStatus.unknown') : ok ? t('systemStatus.ok') : t('systemStatus.problem')}
        </span>
      </div>
      <ul className="mt-2 space-y-0.5 text-sm text-muted">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  );

  const s = status.data;
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">{t('systemStatus.title')}</h1>
      {status.error ? (
        <LoadError error={status.error} onRetry={() => void status.refetch()} />
      ) : !s ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {card(
            t('systemStatus.backup'),
            s.backup ? s.backup.ok : null,
            s.backup
              ? [
                  s.backup.finished ? `${t('systemStatus.last')}: ${fmtInstant(s.backup.finished)}` : '',
                  s.backup.size ? `${t('systemStatus.size')}: ${mb(s.backup.size)} MB` : '',
                  s.backup.error ?? '',
                ].filter(Boolean)
              : [t('systemStatus.noBackup')],
          )}
          {card(
            t('systemStatus.restore'),
            s.restore_test ? s.restore_test.ok : null,
            s.restore_test
              ? [s.restore_test.finished ? `${t('systemStatus.last')}: ${fmtInstant(s.restore_test.finished)}` : '', s.restore_test.error ?? ''].filter(Boolean)
              : [t('systemStatus.noRestore')],
          )}
          {card(
            t('systemStatus.ledger'),
            s.ledger_verify ? s.ledger_verify.ok : null,
            s.ledger_verify ? [`${t('systemStatus.last')}: ${fmtInstant(s.ledger_verify.at)}`, `${s.ledger_verify.count} ${t('systemStatus.entries')}`] : [t('systemStatus.noLedger')],
          )}
          {card(t('systemStatus.system'), s.disk ? s.disk.free_bytes > 1024 ** 3 : null, [
            s.disk ? `${t('systemStatus.disk')}: ${gb(s.disk.free_bytes)} / ${gb(s.disk.total_bytes)} GB` : '',
            s.queue_depth !== null ? `${t('systemStatus.queue')}: ${s.queue_depth}` : '',
          ].filter(Boolean))}
          <section className="rounded-[18px] border border-border bg-card shadow-card p-4 lg:col-span-2">
            <h2 className="font-semibold">{t('systemStatus.offline')}</h2>
            <p className="text-sm text-muted">{s.offline_copy ? `${t('systemStatus.last')}: ${fmtDate(s.offline_copy.on)}` : t('systemStatus.noOffline')}</p>
            <p className="mt-1 text-xs text-muted">{t('systemStatus.offlineHint')}</p>
            {isCashier && (
              <button type="button" onClick={() => setConfirmCopy(true)} className="mt-2 h-10 rounded-xl border border-border px-3 text-sm hover:bg-hover">{t('systemStatus.confirmOffline')}</button>
            )}
          </section>
        </div>
      )}

      <section className="rounded-[18px] border border-border bg-card shadow-card p-4">
        <h2 className="font-semibold">{t('systemStatus.verifyNow')}</h2>
        <p className="text-sm text-muted">{t('systemStatus.verifyHint')}</p>
        <button type="button" disabled={verify.isPending} onClick={() => verify.mutate()} className="mt-2 h-10 rounded-xl bg-primary px-4 text-primary-foreground disabled:opacity-50">
          {verify.isPending ? t('common.working') : t('systemStatus.verifyButton')}
        </button>
        {verify.error && <div className="mt-3"><LoadError error={verify.error} /></div>}
        {verify.data && (
          <p className={`mt-3 font-medium ${verify.data.ok ? 'text-ok' : 'text-bad'}`} data-testid="verify-result">
            {verify.data.ok ? t('systemStatus.verifyOk', { count: verify.data.count }) : t('systemStatus.verifyBroken', { count: verify.data.issues_total })}
          </p>
        )}
        {verify.data && <p className="mt-1 break-all font-mono text-xs text-muted">{verify.data.last_hash}</p>}
      </section>

      <ConfirmSheet
        open={confirmCopy}
        onClose={() => setConfirmCopy(false)}
        title={t('systemStatus.confirmOffline')}
        confirmLabel={t('common.confirm')}
        onConfirm={async () => {
          await api('/system/offline-copy', { method: 'POST' });
          await qc.invalidateQueries({ queryKey: ['system-status'] });
        }}
      >
        <p className="text-muted">{t('systemStatus.offlineSheet')}</p>
      </ConfirmSheet>
    </div>
  );
}
