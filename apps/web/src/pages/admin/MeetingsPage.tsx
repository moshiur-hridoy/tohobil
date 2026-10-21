import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { ListSkeleton } from '../../components/Skeleton';
import { LoadError } from '../../components/StateViews';
import {
  AdminDialog, AdminHeader, AdminPage, BTN_PRIMARY, BTN_SECONDARY, BTN_SM, BTN_SM_PRIMARY, Card, CardHead, EmptyCard, FieldLabel, ICONS,
  MemberBadge, SplitLayout,
} from '../../components/admin';
import { Chip, Icon } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtClock, fmtDate, todayDhaka } from '../../lib/dates';
import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { taka } from '../../lib/money';
import { ruleValueText } from '../../lib/ruleText';
import type { AttendanceStatus, MeetingDetail, MeetingRow, RulesResponse } from '../../lib/types';

const ATTENDANCE: AttendanceStatus[] = ['present', 'absent_excused', 'absent_unexcused'];
const ATTENDANCE_TONE: Record<AttendanceStatus, string> = {
  present: 'bg-ok-bg text-ok',
  absent_excused: 'bg-blue-bg text-blue',
  absent_unexcused: 'bg-bad-bg text-bad',
};
const STATUS_TONE: Record<MeetingRow['status'], string> = {
  draft: 'bg-warn-bg text-warn',
  scheduled: 'bg-primary-soft text-primary',
  held: 'bg-ok-bg text-ok',
  cancelled: 'bg-soft text-muted',
};
const LINK_ICON = 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1';

/**
 * Monthly meetings (constitution 9): the cashier sets the time and link of the month's meeting (a
 * draft appears on its own five days before the meeting window), everyone is reminded a day and an
 * hour before, and afterwards the cashier marks who came. That closes the meeting for good.
 */
export function MeetingsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const isCashier = me?.roles.includes('cashier') ?? false;
  const [editing, setEditing] = useState<MeetingRow | 'new' | null>(null);
  const [cancelling, setCancelling] = useState<MeetingRow | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const meetings = useQuery({ queryKey: ['meetings'], queryFn: () => api<{ items: MeetingRow[] }>('/meetings') });
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api<RulesResponse>('/rules') });

  const items = meetings.data?.items ?? [];
  const open = items.filter((m) => m.status === 'draft' || m.status === 'scheduled')
    .sort((a, b) => (a.scheduled_for ?? '9').localeCompare(b.scheduled_for ?? '9'));
  const past = items.filter((m) => m.status === 'held' || m.status === 'cancelled');
  const rule = (key: string) => rules.data?.items.find((r) => r.key === key);
  const now = Date.now();

  return (
    <AdminPage>
      <AdminHeader
        title={t('meetings.title')}
        subtitle={t('meetings.subtitle')}
        actions={isCashier && (
          <button type="button" className={BTN_PRIMARY} onClick={() => setEditing('new')}>
            <Icon d={ICONS.plus} size={18} sw={2} />
            {t('meetings.new')}
          </button>
        )}
      />

      {meetings.error ? (
        <LoadError error={meetings.error} onRetry={() => void meetings.refetch()} />
      ) : (
        <SplitLayout
          main={
            <>
              <Card className="p-5 sm:p-6">
                <CardHead icon={ICONS.clock} title={t('meetings.upcoming')} />
                {!meetings.data ? (
                  <ListSkeleton rows={2} />
                ) : open.length === 0 ? (
                  <EmptyCard text={t('meetings.noUpcoming')} icon={ICONS.users} />
                ) : (
                  <ul className="space-y-3">
                    {open.map((m) => {
                      const started = m.scheduled_for !== null && new Date(m.scheduled_for).getTime() <= now;
                      return (
                        <li key={m.id} className={`rounded-2xl border p-4 ${m.status === 'draft' ? 'border-warn bg-warn-bg' : 'border-border'}`}>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              {m.date && m.time ? (
                                <>
                                  <p className="text-lg font-bold">{fmtDate(m.date)}</p>
                                  <p className="text-sm text-ink2">{fmtClock(t, m.time)}</p>
                                </>
                              ) : (
                                <>
                                  <p className="text-lg font-bold">{t('meetings.draftTitle')}</p>
                                  <p className="text-sm text-ink2">{t('meetings.draftHint')}</p>
                                </>
                              )}
                            </div>
                            <MeetingStatus status={m.status} />
                          </div>
                          {m.link && (
                            <a href={m.link} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1.5 break-all text-sm font-semibold text-primary hover:underline">
                              <Icon d={LINK_ICON} size={15} />{m.link}
                            </a>
                          )}
                          {m.notes && <p className="mt-2 whitespace-pre-line text-sm text-ink2">{m.notes}</p>}
                          {isCashier && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {started && (
                                <button type="button" className={BTN_SM_PRIMARY} onClick={() => setMarking(m.id)}>
                                  <Icon d={ICONS.check} size={14} sw={2.2} />{t('meetings.markAttendance')}
                                </button>
                              )}
                              <button type="button" className={m.status === 'draft' ? BTN_SM_PRIMARY : BTN_SM} onClick={() => setEditing(m)}>
                                {m.status === 'draft' ? t('meetings.setTime') : t('meetings.change')}
                              </button>
                              <button type="button" className={BTN_SM} onClick={() => setCancelling(m)}>{t('meetings.cancel')}</button>
                            </div>
                          )}
                          {isCashier && m.status === 'scheduled' && !started && (
                            <p className="mt-2 text-xs text-muted">{t('meetings.attendanceLater')}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>

              <Card className="px-5 pb-3 pt-5 sm:px-6">
                <CardHead icon={ICONS.book} tone="bg-soft text-ink2" title={t('meetings.past')} />
                {!meetings.data ? (
                  <ListSkeleton rows={3} />
                ) : past.length === 0 ? (
                  <EmptyCard text={t('meetings.noPast')} icon={ICONS.book} />
                ) : (
                  <ul>
                    {past.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => setViewing(m.id)}
                          className="flex w-full items-center gap-3 border-t border-border py-3 text-left first:border-t-0 hover:bg-hover"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold">{m.date ? fmtDate(m.date) : '—'}</p>
                            <p className="text-xs text-muted">
                              {m.status === 'held'
                                ? t('meetings.counts', { present: formatCount(m.present_count), absent: formatCount(m.absent_count) })
                                : m.notes ?? ''}
                            </p>
                          </div>
                          <MeetingStatus status={m.status} />
                          <span className="text-muted"><Icon d={ICONS.chevron} size={16} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          }
          side={
            <Card className="p-5">
              <CardHead icon={ICONS.sliders} title={t('meetings.rulesTitle')} />
              <ul className="space-y-2.5 text-sm text-ink2">
                <li>
                  {rule('meeting_window_start_day') && rule('meeting_window_end_day')
                    ? t('meetings.ruleWindow', {
                      from: ruleValueText(t, 'meeting_window_start_day', rule('meeting_window_start_day')!.value),
                      to: ruleValueText(t, 'meeting_window_end_day', rule('meeting_window_end_day')!.value),
                    })
                    : '…'}
                </li>
                <li>{t('meetings.ruleDraft')}</li>
                <li>{t('meetings.ruleReminders')}</li>
                <li>
                  {rule('absence_fine_after_consecutive') && rule('absence_fine_paisa')
                    ? t('meetings.ruleFine', {
                      times: ruleValueText(t, 'absence_fine_after_consecutive', rule('absence_fine_after_consecutive')!.value),
                      amount: ruleValueText(t, 'absence_fine_paisa', rule('absence_fine_paisa')!.value),
                    })
                    : '…'}
                </li>
                <li>{t('meetings.ruleExcused')}</li>
              </ul>
            </Card>
          }
        />
      )}

      {editing !== null && (
        <ScheduleDialog
          meeting={editing === 'new' ? null : editing}
          defaultDay={rule('meeting_window_start_day')?.value}
          onClose={() => setEditing(null)}
        />
      )}
      <CancelSheet meeting={cancelling} onClose={() => setCancelling(null)} />
      {marking && <AttendanceDialog meetingId={marking} onClose={() => setMarking(null)} />}
      {viewing && <MeetingDetailDialog meetingId={viewing} onClose={() => setViewing(null)} />}
    </AdminPage>
  );
}

function MeetingStatus({ status }: { status: MeetingRow['status'] }) {
  const { t } = useTranslation();
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_TONE[status]}`}>{t(`meetings.status.${status}`)}</span>;
}

/** The day of the month the meeting window starts, in this or next month, as the form's first guess. */
function suggestedDate(day: unknown): string {
  const today = todayDhaka();
  const d = typeof day === 'number' ? day : Number(day);
  if (!Number.isInteger(d) || d < 1 || d > 28) return today;
  const [y, m] = today.split('-').map(Number) as [number, number];
  const thisMonth = `${today.slice(0, 7)}-${String(d).padStart(2, '0')}`;
  if (thisMonth >= today) return thisMonth;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return `${next}-${String(d).padStart(2, '0')}`;
}

function ScheduleDialog({ meeting, defaultDay, onClose }: { meeting: MeetingRow | null; defaultDay: unknown; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [date, setDate] = useState(meeting?.date ?? suggestedDate(defaultDay));
  const [time, setTime] = useState(meeting?.time ?? '21:00');
  const [link, setLink] = useState(meeting?.link ?? '');
  const [notes, setNotes] = useState(meeting?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { date, time, ...(link.trim() ? { link: link.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };
      await api(meeting ? `/meetings/${meeting.id}` : '/meetings', { method: meeting ? 'PATCH' : 'POST', body });
      void qc.invalidateQueries({ queryKey: ['meetings'] });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminDialog open onClose={onClose} title={meeting ? t('meetings.editTitle') : t('meetings.newTitle')}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label={t('common.date')}><input type="date" className="field w-full" value={date} onChange={(e) => setDate(e.target.value)} /></FieldLabel>
          <FieldLabel label={t('meetings.time')}><input type="time" className="field w-full" value={time} onChange={(e) => setTime(e.target.value)} /></FieldLabel>
        </div>
        <FieldLabel label={t('meetings.link')}>
          <input type="url" inputMode="url" placeholder="https://meet.google.com/…" className="field w-full" value={link} onChange={(e) => setLink(e.target.value)} />
        </FieldLabel>
        <FieldLabel label={t('meetings.notes')}>
          <textarea className="field min-h-20 w-full" placeholder={t('meetings.notesPlaceholder')} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FieldLabel>
        <p className="text-xs text-muted">{t('meetings.remindNote')}</p>
        {error != null && <p className="text-sm text-bad">{errorMessage(t, error).message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className={BTN_PRIMARY} disabled={busy || !date || !time} onClick={() => void save()}>{t('common.save')}</button>
        </div>
      </div>
    </AdminDialog>
  );
}

function CancelSheet({ meeting, onClose }: { meeting: MeetingRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  return (
    <ConfirmSheet
      open={meeting !== null}
      onClose={() => { setReason(''); onClose(); }}
      title={t('meetings.cancelTitle')}
      confirmLabel={t('meetings.cancel')}
      tone="danger"
      onConfirm={async () => {
        await api(`/meetings/${meeting!.id}/cancel`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} });
        void qc.invalidateQueries({ queryKey: ['meetings'] });
      }}
    >
      <p className="text-sm text-ink2">{t('meetings.cancelBody')}</p>
      <label className="mt-2 block text-sm text-muted">
        {t('meetings.cancelReason')}
        <input className="field mt-1 w-full" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
    </ConfirmSheet>
  );
}

/** Mark everyone once: all start as present, the cashier changes the few who were not there. */
function AttendanceDialog({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['meetings', meetingId], queryFn: () => api<MeetingDetail>(`/meetings/${meetingId}`) });
  const [marks, setMarks] = useState<Record<string, AttendanceStatus>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const people = detail.data?.attendance ?? [];
  const statusOf = (id: string): AttendanceStatus => marks[id] ?? 'present';
  const count = (s: AttendanceStatus) => people.filter((p) => statusOf(p.member_id) === s).length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/meetings/${meetingId}/attendance`, {
        method: 'POST',
        body: {
          items: people.map((p) => ({
            member_id: p.member_id,
            status: statusOf(p.member_id),
            ...(reasons[p.member_id]?.trim() ? { reason: reasons[p.member_id]!.trim() } : {}),
          })),
        },
      });
      void qc.invalidateQueries({ queryKey: ['meetings'] });
      onClose();
    } catch (err) {
      setError(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminDialog open wide onClose={onClose} title={t('meetings.attendanceTitle')}>
      {detail.error ? <LoadError error={detail.error} /> : !detail.data ? <ListSkeleton rows={4} /> : (
        <>
          <p className="mb-3 text-sm text-ink2">
            {detail.data.date && fmtDate(detail.data.date)} · {t('meetings.attendanceHint')}
          </p>
          <ul>
            {people.map((p) => (
              <li key={p.member_id} className="border-t border-border py-2.5 first:border-t-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <MemberBadge code={p.member_code} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{p.member_name}</span>
                  <div role="group" aria-label={p.member_name} className="flex gap-1">
                    {ATTENDANCE.map((s) => {
                      const active = statusOf(p.member_id) === s;
                      return (
                        <button
                          key={s}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setMarks((m) => ({ ...m, [p.member_id]: s }))}
                          className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${active ? ATTENDANCE_TONE[s] : 'bg-soft text-muted hover:text-foreground'}`}
                        >
                          {t(`meetings.attendance.${s}`)}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {statusOf(p.member_id) !== 'present' && (
                  <input
                    className="field mt-2 w-full"
                    placeholder={t('meetings.reasonPlaceholder')}
                    value={reasons[p.member_id] ?? ''}
                    onChange={(e) => setReasons((r) => ({ ...r, [p.member_id]: e.target.value }))}
                  />
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-ink2">
            {t('meetings.summary', {
              present: formatCount(count('present')),
              excused: formatCount(count('absent_excused')),
              unexcused: formatCount(count('absent_unexcused')),
            })}
          </p>
          {error != null && <p className="mt-2 text-sm text-bad">{errorMessage(t, error).message}</p>}
          {confirming ? (
            <div className="mt-3 rounded-xl bg-warn-bg p-3 text-sm text-warn">
              <p>{t('meetings.finalWarning')}</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className={BTN_SECONDARY} onClick={() => setConfirming(false)}>{t('common.back')}</button>
                <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void save()}>{t('meetings.saveFinal')}</button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className={BTN_SECONDARY} onClick={onClose}>{t('common.cancel')}</button>
              <button type="button" className={BTN_PRIMARY} disabled={people.length === 0} onClick={() => setConfirming(true)}>{t('common.save')}</button>
            </div>
          )}
        </>
      )}
    </AdminDialog>
  );
}

function MeetingDetailDialog({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useQuery({ queryKey: ['meetings', meetingId], queryFn: () => api<MeetingDetail>(`/meetings/${meetingId}`) });
  const m = detail.data;
  const fineOf = (memberId: string) => m?.absence_fines.find((f) => f.member_id === memberId);
  return (
    <AdminDialog open wide onClose={onClose} title={m?.date ? `${t('meetings.title')} · ${fmtDate(m.date)}` : t('meetings.title')}>
      {detail.error ? <LoadError error={detail.error} /> : !m ? <ListSkeleton rows={4} /> : (
        <>
          {m.time && <p className="text-sm text-ink2">{fmtClock(t, m.time)}</p>}
          {m.notes && <p className="mt-2 whitespace-pre-line text-sm text-ink2">{m.notes}</p>}
          {m.status === 'held' ? (
            <ul className="mt-3">
              {m.attendance.map((p) => {
                const fine = fineOf(p.member_id);
                return (
                  <li key={p.member_id} className="flex flex-wrap items-center gap-2.5 border-t border-border py-2.5 first:border-t-0">
                    <MemberBadge code={p.member_code} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{p.member_name}</p>
                      {p.reason && <p className="text-xs text-muted">{p.reason}</p>}
                    </div>
                    {fine && <span className="rounded-full bg-bad-bg px-2.5 py-1 text-xs font-semibold text-bad">{t('meetings.fined', { amount: taka(fine.amount_paisa) })}</span>}
                    {p.status && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${ATTENDANCE_TONE[p.status]}`}>{t(`meetings.attendance.${p.status}`)}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-3 flex items-center gap-2.5">
              <Chip tone="bg-soft text-muted" d={ICONS.alert} size={32} iconSize={18} />
              <p className="text-sm text-muted">{t('meetings.wasCancelled')}</p>
            </div>
          )}
        </>
      )}
    </AdminDialog>
  );
}
