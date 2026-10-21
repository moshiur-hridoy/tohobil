import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentTheme, setTheme, type Theme } from '../lib/theme';
import { Icon } from './ui';

const SUN = 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4';
const MOON = 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z';

/** Light / dark switch. Shows the icon of the theme it will switch to. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const [theme, setCurrent] = useState<Theme>(currentTheme);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => { setTheme(next); setCurrent(next); }}
      aria-label={t(next === 'dark' ? 'theme.toDark' : 'theme.toLight')}
      title={t(next === 'dark' ? 'theme.toDark' : 'theme.toLight')}
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      <Icon d={next === 'dark' ? MOON : SUN} />
    </button>
  );
}
