import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { BTN_PRIMARY, Card, CardHead, FieldLabel, ICONS, Notice, Segmented } from '../../components/admin';
import { api } from '../../lib/api';
import { formatCount } from '../../lib/format';
import type { MemberRow } from '../../lib/types';

/** Members who can still read a notice (the server uses the same rule). */
const REACHABLE = new Set(['active', 'warning', 'suspended']);
const TITLE_MAX = 60;
const MESSAGE_MAX = 500;

/** Cashier: write a notice and push it to every member or the ones picked; SMS if ticked. */
export function NoticeComposer({ members, onSent }: { members: MemberRow[]; onSent: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState<'all' | 'selected'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sms, setSms] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  const reachable = members.filter((m) => REACHABLE.has(m.status));
  const count = audience === 'all' ? reachable.length : picked.size;
  const ready = title.trim().length > 0 && message.trim().length > 0 && count > 0;

  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card className="px-5 pb-5 pt-5">
      <CardHead icon={ICONS.message} title={t('noticeCompose.title')} sub={t('noticeCompose.sub')} />
      <div className="space-y-4">
        <FieldLabel label={t('noticeCompose.heading')}>
          <input className="field w-full" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder={t('noticeCompose.headingHint')} />
        </FieldLabel>
        <FieldLabel label={t('noticeCompose.message')}>
          <textarea className="field min-h-28 w-full" value={message} maxLength={MESSAGE_MAX} onChange={(e) => setMessage(e.target.value)} placeholder={t('noticeCompose.messageHint')} />
          <p className="mt-1 text-right text-xs text-muted">{formatCount(message.length)}/{formatCount(MESSAGE_MAX)}</p>
        </FieldLabel>

        <div>
          <p className="field-label mb-1.5">{t('noticeCompose.to')}</p>
          <Segmented
            label={t('noticeCompose.to')}
            value={audience}
            onChange={setAudience}
            options={[
              { value: 'all', label: t('noticeCompose.toAll'), count: formatCount(reachable.length) },
              { value: 'selected', label: t('noticeCompose.toSelected'), count: audience === 'selected' ? formatCount(picked.size) : undefined },
            ]}
          />
        </div>
        {audience === 'selected' && (
          <ul className="max-h-60 overflow-y-auto rounded-xl border border-border">
            {reachable.map((m) => (
              <li key={m.id} className="border-t border-border first:border-t-0">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
                  <span className="font-semibold">{m.code}</span>
                  <span className="truncate">{m.full_name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={sms} onChange={(e) => setSms(e.target.checked)} />
          <span>
            <span className="font-medium">{t('noticeCompose.sms')}</span>
            <span className="block text-xs text-muted">{t('noticeCompose.smsHint')}</span>
          </span>
        </label>
        <p className="text-xs text-muted">{t('noticeCompose.quietHours')}</p>

        <Notice text={done !== null ? t('noticeCompose.sent', { n: formatCount(done) }) : null} />
        <button type="button" disabled={!ready} onClick={() => setConfirm(true)} className={`${BTN_PRIMARY} w-full`}>
          {t('noticeCompose.send')}
        </button>
      </div>

      <ConfirmSheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('noticeCompose.confirmTitle')}
        confirmLabel={t('noticeCompose.send')}
        onConfirm={async () => {
          const res = await api<{ recipients: number }>('/notifications/notice', {
            method: 'POST',
            body: { title: title.trim(), message: message.trim(), audience, member_ids: audience === 'selected' ? [...picked] : [], sms },
          });
          setDone(res.recipients);
          setTitle('');
          setMessage('');
          setPicked(new Set());
          setSms(false);
          onSent();
        }}
      >
        <p className="text-muted">{t(sms ? 'noticeCompose.confirmBodySms' : 'noticeCompose.confirmBody', { n: formatCount(count) })}</p>
        <div className="mt-3 rounded-xl border border-border p-3">
          <p className="font-semibold">{title.trim()}</p>
          <p className="mt-1 whitespace-pre-line text-sm">{message.trim()}</p>
        </div>
      </ConfirmSheet>
    </Card>
  );
}
