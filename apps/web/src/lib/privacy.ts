import { useSyncExternalStore } from 'react';

const KEY = 'barakah.privacy';

/** What an amount shows while privacy mode is on: one wave per digit, so a bigger amount is a longer wave. */
export const mask = (formatted: string): string => '৳' + '∿'.repeat(formatted.replace(/[^\d০-৯]/g, '').length);

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let on = read();

/** Privacy mode: every taka amount on screen is hidden until the member switches it off again. */
export const isPrivate = (): boolean => on;

export function setPrivate(value: boolean): void {
  on = value;
  try {
    localStorage.setItem(KEY, value ? '1' : '0');
  } catch {
    // private window or blocked storage: the choice lasts until reload
  }
  listeners.forEach((l) => l());
}

export function usePrivacy(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    isPrivate,
  );
}
