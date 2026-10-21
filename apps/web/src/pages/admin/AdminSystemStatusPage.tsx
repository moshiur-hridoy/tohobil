import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { LoadError } from '../../components/StateViews';
import { Skeleton } from '../../components/Skeleton';
import { AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, Card, CardHead, ICONS } from '../../components/admin';
import { Chip } from '../../components/ui';
import { formatCount } from '../../lib/format';
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

  const s = status.data;
  const checks: Array<boolean | null> = s
    ? [s.backup ? s.backup.ok : null, s.restore_test ? s.restore_test.ok : null, s.ledger_verify ? s.ledger_verify.ok : null, s.disk ? s.disk.free_bytes > 1024 ** 3 : null]
    : [];
  const overall = !s ? null : checks.every((c) => c === true) ? 'ok' : checks.some((c) => c === false) ? 'bad' : 'warn';

  return (
    <AdminPage>
      <AdminHeader
        title={t('systemStatus.title')}
        subtitle={t('adminUi.sub.system')}
        actions={overall && (
          <span className={`inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold ${overall === 'ok' ? 'bg-ok-bg text-ok' : overall === 'bad' ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn'}`}>
            <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${overall === 'ok' ? 'bg-ok' : overall === 'bad' ? 'bg-bad' : 'bg-warn'}`} />
            {overall === 'ok' ? t('adminUi.system.allOk') : t('adminUi.system.attention')}
          </span>
        )}
      />

      {status.error ? (
        <LoadError error={status.error} onRetry={() => void status.refetch()} />
      ) : !s ? (
        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 w-full rounded-[18px]" />)}</div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <Health
            icon={ICONS.server}
            title={t('systemStatus.backup')}
            ok={s.backup ? s.backup.ok : null}
            value={s.backup?.finished ? fmtInstant(s.backup.finished) : null}
            lines={s.backup ? [s.backup.size ? `${t('systemStatus.size')}: ${mb(s.backup.size)} MB` : '', s.backup.error ?? ''] : [t('systemStatus.noBackup')]}
          />
          <Health
            icon={ICONS.undo}
            title={t('systemStatus.restore')}
            ok={s.restore_test ? s.restore_test.ok : null}
            value={s.restore_test?.finished ? fmtInstant(s.restore_test.finished) : null}
            lines={s.restore_test ? [s.restore_test.error ?? ''] : [t('systemStatus.noRestore')]}
          />
          <Health
            icon={ICONS.shield}
            title={t('systemStatus.ledger')}
            ok={s.ledger_verify ? s.ledger_verify.ok : null}
            value={s.ledger_verify ? `${formatCount(s.ledger_verify.count)} ${t('systemStatus.entries')}` : null}
            lines={s.ledger_verify ? [`${t('systemStatus.last')}: ${fmtInstant(s.ledger_verify.at)}`] : [t('systemStatus.noLedger')]}
          />
          <Health
            icon={ICONS.server}
            title={t('systemStatus.system')}
            ok={s.disk ? s.disk.free_bytes > 1024 ** 3 : null}
            value={s.disk ? `${gb(s.disk.free_bytes)} GB` : null}
            lines={[
              s.disk ? `${t('systemStatus.disk')}: ${gb(s.disk.free_bytes)} / ${gb(s.disk.total_bytes)} GB` : '',
              s.queue_depth !== null ? `${t('systemStatus.queue')}: ${formatCount(s.queue_depth)}` : '',
            ]}
          />
        </div>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card className="p-5">
          <CardHead
            icon={ICONS.download}
            tone={s?.offline_copy ? 'bg-ok-bg text-ok' : 'bg-warn-bg text-warn'}
            title={t('systemStatus.offline')}
            sub={s ? (s.offline_copy ? `${t('systemStatus.last')}: ${fmtDate(s.offline_copy.on)}` : t('systemStatus.noOffline')) : undefined}
          />
          <p className="text-sm text-ink2">{t('systemStatus.offlineHint')}</p>
          {isCashier && (
            <button type="button" onClick={() => setConfirmCopy(true)} className={`${BTN_SECONDARY} mt-3`}>{t('systemStatus.confirmOffline')}</button>
          )}
        </Card>

        <Card className="p-5">
          <CardHead icon={ICONS.shield} title={t('systemStatus.verifyNow')} sub={t('systemStatus.verifyHint')} />
          <button type="button" disabled={verify.isPending} onClick={() => verify.mutate()} className={BTN_PRIMARY}>
            {verify.isPending ? t('common.working') : t('systemStatus.verifyButton')}
          </button>
          {verify.error && <div className="mt-3"><LoadError error={verify.error} /></div>}
          {verify.data && (
            <p className={`mt-3 rounded-xl px-4 py-2.5 text-sm font-medium ${verify.data.ok ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad'}`} data-testid="verify-result">
              {verify.data.ok ? t('systemStatus.verifyOk', { count: verify.data.count }) : t('systemStatus.verifyBroken', { count: verify.data.issues_total })}
            </p>
          )}
          {verify.data && <p className="mt-2 break-all font-mono text-xs text-muted">{verify.data.last_hash}</p>}
        </Card>
      </div>

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
    </AdminPage>
  );
}

/** One health check: a tinted status word, the headline figure and its detail lines. */
function Health({ icon, title, ok, value, lines }: { icon: string; title: string; ok: boolean | null; value: string | null; lines: string[] }) {
  const { t } = useTranslation();
  const tone = ok === null ? 'bg-soft text-muted' : ok ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad';
  return (
    <Card className="flex flex-col p-[18px]">
      <div className="flex items-center gap-2.5">
        <Chip tone={tone} d={icon} size={32} iconSize={18} />
        <p className="flex-1 text-sm font-semibold text-ink2">{title}</p>
      </div>
      <p className={`mt-3 text-lg font-bold ${ok === false ? 'text-bad' : ''}`}>
        <span aria-hidden="true">{ok === null ? '– ' : ok ? '✓ ' : '! '}</span>
        {ok === null ? t('systemStatus.unknown') : ok ? t('systemStatus.ok') : t('systemStatus.problem')}
      </p>
      {value && <p className="text-sm tabular-nums">{value}</p>}
      <ul className="mt-auto space-y-0.5 pt-2 text-xs text-muted">{lines.filter(Boolean).map((l) => <li key={l}>{l}</li>)}</ul>
    </Card>
  );
}
