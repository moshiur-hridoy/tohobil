import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { bn, en } from '@barakah/shared/i18n';

// Resources are bundled, so initialise synchronously: translations are ready before the first
// render and users never see raw keys flash. Bengali is the default; English is the fallback.
void i18n.use(initReactI18next).init({
  resources: {
    bn: { translation: bn },
    en: { translation: en },
  },
  lng: 'bn',
  fallbackLng: 'en',
  initAsync: false,
  interpolation: {
    escapeValue: false, // React already escapes
  },
});

export { i18n };
