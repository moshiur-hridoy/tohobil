import { useTranslation } from 'react-i18next';
import { formatCount } from '../lib/format';

/** "★ N months ahead" next to a member's name: everyone in the group sees who has paid in advance. */
export function AheadBadge({ months }: { months: number | undefined }) {
  const { t } = useTranslation();
  if (!months || months <= 0) return null;
  return (
    <span title={t('matrixPage.aheadTitle')} className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-primary-soft px-2 py-0.5 text-[0.6875rem] font-bold text-primary">
      ★ {t('matrixPage.ahead', { n: formatCount(months) })}
    </span>
  );
}
