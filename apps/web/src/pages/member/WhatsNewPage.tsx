import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';
import { APP_VERSION, RELEASES } from '../../lib/changelog';
import { fmtDate } from '../../lib/dates';
import { localDigits } from '../../lib/format';
import { markVersionSeen } from '../../components/WhatsNewBanner';

/** "কী নতুন": every released version with what changed, from CHANGELOG.md (newest first). */
export function WhatsNewPage() {
  const { t } = useTranslation();
  useEffect(markVersionSeen, []);
  return (
    <div>
      <PageHeader title={t('whatsNew.title')} subtitle={t('whatsNew.current', { version: localDigits(APP_VERSION) })} back="/menu" />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        {RELEASES.map((r) => (
          <section key={r.version} className="rounded-[18px] border border-border bg-card p-4">
            <h2 className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-lg font-bold">{t('whatsNew.version', { version: localDigits(r.version) })}</span>
              <span className="text-sm text-muted">{fmtDate(r.date)}</span>
            </h2>
            {r.version === APP_VERSION && <span className="mt-1 inline-block rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-semibold text-primary">{t('whatsNew.thisOne')}</span>}
            {r.sections.map((s) => (
              <div key={s.title} className="mt-3">
                <h3 className="text-sm font-semibold text-muted">{s.title}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[0.9375rem]">
                  {s.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
