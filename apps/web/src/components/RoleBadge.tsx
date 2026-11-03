import { useTranslation } from 'react-i18next';

/** "ক্যাশিয়ার" / "অডিটর" beside a name, so every member can see who holds each role. Plain members get nothing. */
export function RoleBadges({ roles }: { roles: readonly string[] | undefined }) {
  const { t } = useTranslation();
  const shown = (roles ?? []).filter((r) => r === 'cashier' || r === 'auditor');
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((r) => (
        <span key={r} className={`shrink-0 rounded-full px-2 py-px text-[0.6875rem] font-semibold ${r === 'cashier' ? 'bg-primary-soft text-primary' : 'bg-blue-bg text-blue'}`}>
          {t(`roles.${r}`)}
        </span>
      ))}
    </>
  );
}
