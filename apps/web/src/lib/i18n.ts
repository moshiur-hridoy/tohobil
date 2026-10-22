import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bn, en } from '@barakah/shared/i18n';
import { formatCount, setDigits } from './format';

export type Language = 'bn' | 'en';

const LANG_KEY = 'barakah.lang';

/** The saved choice. Only the cashier screens offer a switch, so a member's phone stays Bengali. */
function storedLanguage(): Language {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'bn';
  } catch {
    return 'bn';
  }
}

// Resources are bundled, so initialise synchronously: translations are ready before the first
// render and users never see raw keys flash. Bengali is the default; English is the fallback.
void i18n.use(initReactI18next).init({
  resources: {
    bn: { translation: bn },
    en: { translation: en },
  },
  lng: storedLanguage(),
  fallbackLng: 'en',
  initAsync: false,
  interpolation: {
    escapeValue: false, // React already escapes
    // A number put into a sentence (`{{count}}`) follows the language's numerals, so "মোট {{count}}টি"
    // never shows "মোট 2টি". Strings pass through untouched: member codes, phones and TrxIDs keep their digits.
    alwaysFormat: true,
    format: (value: unknown, _format: string | undefined, lng: string | undefined) =>
      (typeof value === 'number' ? formatCount(value, lng === 'en' ? 'en' : 'bn') : value) as string,
  },
});
document.documentElement.lang = i18n.language;

/** Switch the language on this device. Numerals follow it: Bengali digits with Bengali text (assumption 102). */
export function setLanguage(lang: Language): void {
  setDigits(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  document.documentElement.lang = lang;
  void i18n.changeLanguage(lang);
}

export { i18n };
