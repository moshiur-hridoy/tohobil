import { useTranslation } from 'react-i18next';
import { formatTaka } from '../../lib/format';

export function HomePage() {
  const { t } = useTranslation();

  // Placeholder figures: Phase 1 computes these from the API.
  const zero = formatTaka(0n);

  return (
    <div className="space-y-4 p-4">
      {/* Outstanding card */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-muted">{t('home.myOutstanding')}</h2>
        <p className="text-2xl font-bold text-bad">{zero}</p>
        <div className="mt-2 flex gap-4">
          <span>
            {t('home.principal')}: {zero}
          </span>
          <span>
            {t('home.fines')}: {zero}
          </span>
        </div>
        <button
          type="button"
          className="mt-3 w-full rounded-md bg-primary py-3 font-medium text-primary-foreground"
        >
          {t('home.payNow')}
        </button>
      </div>

      {/* Fund summary */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-muted">{t('home.fundNetAssets')}</h2>
        <p className="text-xl font-semibold">{zero}</p>
        <p className="mt-1 text-muted">
          {t('home.myShareValue')}: {zero}
        </p>
      </div>

      {/* Charity balance (18.2): fines and riba are donated at year end, never fund income */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-1 text-muted">{t('home.charityToDonate')}</h2>
        <p className="text-lg font-semibold text-warn">{zero}</p>
      </div>
    </div>
  );
}
