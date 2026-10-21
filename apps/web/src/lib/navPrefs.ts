import { useSyncExternalStore } from 'react';

const KEY = 'barakah.hiddenNav';
const EVENT = 'barakah:hidden-nav';

/** Pages that can never be hidden: the dashboard, and settings (where hidden pages are shown again). */
export const ALWAYS_SHOWN = ['/admin', '/admin/settings'];

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? '[]';
  } catch {
    return '[]';
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * Side-panel links the cashier chose to hide on this device. Only the menu changes: a hidden page
 * still opens from its address, and nothing about the page itself is switched off.
 */
export function useHiddenNav(): [Set<string>, (route: string, hidden: boolean) => void] {
  const raw = useSyncExternalStore(subscribe, read, () => '[]');
  let list: string[] = [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.filter((r): r is string => typeof r === 'string' && !ALWAYS_SHOWN.includes(r));
  } catch {
    // a broken value hides nothing
  }
  const set = (route: string, hidden: boolean) => {
    const next = hidden ? [...new Set([...list, route])] : list.filter((r) => r !== route);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // blocked storage: the choice cannot be kept
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return [new Set(list), set];
}
