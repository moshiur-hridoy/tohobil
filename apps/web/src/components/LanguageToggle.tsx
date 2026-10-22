import { useTranslation } from 'react-i18next';
import { setLanguage } from '../lib/i18n';

/** Bengali / English switch for the cashier screens. Shows the language it will switch to. */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const toEnglish = i18n.language !== 'en';
  const label = t(toEnglish ? 'language.toEnglish' : 'language.toBengali');
  return (
    <button
      type="button"
      onClick={() => setLanguage(toEnglish ? 'en' : 'bn')}
      aria-label={label}
      title={label}
      lang={toEnglish ? 'en' : 'bn'}
      className={`grid h-10 min-w-10 shrink-0 place-items-center rounded-xl px-2 text-sm font-semibold text-muted outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {t(toEnglish ? 'language.shortEn' : 'language.shortBn')}
    </button>
  );
}
