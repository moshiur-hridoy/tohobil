export type Theme = 'light' | 'dark';

const KEY = 'barakah.theme';

/** The theme in force: the saved choice, else what the device prefers. */
export function currentTheme(): Theme {
  const set = document.documentElement.dataset['theme'];
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies and remembers the choice (storage may be blocked: the choice then lasts until reload). */
export function setTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private window or blocked storage
  }
}
