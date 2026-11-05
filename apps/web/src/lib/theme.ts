import { useEffect } from 'react';

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
  syncStatusBar();
}

/** Which colour token is at the top of the screen: the page background, or the dark brand band of the sign-in screens. */
type StatusBarTop = 'background' | 'hero';
let statusBarTop: StatusBarTop = 'background';

/**
 * Colours the phone's status bar like the top of the screen, in the theme in force. The Android app
 * (a Trusted Web Activity on a verified origin) and the installed PWA take the status bar colour from
 * `<meta name="theme-color">`; a fixed brand lime there clashed with both themes (owner report).
 * Reads the CSS token, so the colours stay defined once, in styles/theme.css.
 */
export function syncStatusBar(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  const color = getComputedStyle(document.documentElement).getPropertyValue(`--${statusBarTop}`).trim();
  if (meta && color) meta.setAttribute('content', color);
}

/** Keeps the status bar in step from start-up on, also when the device switches between light and dark. */
export function watchStatusBar(): void {
  syncStatusBar();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncStatusBar);
}

/** For a screen whose top is the dark brand band: the status bar takes that colour while it is shown. */
export function useHeroStatusBar(): void {
  useEffect(() => {
    statusBarTop = 'hero';
    syncStatusBar();
    return () => {
      statusBarTop = 'background';
      syncStatusBar();
    };
  }, []);
}
