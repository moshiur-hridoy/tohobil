import { useSyncExternalStore } from 'react';

const KEY = 'barakah.privacy';

/**
 * What an amount shows while privacy mode is on. The length is fixed, so ৳৫০০ and ৳৫,০০,০০০ look the
 * same and the size of an amount does not leak; the real digits never reach the page. `privacyBlur`
 * blurs these dots where the browser can; elsewhere they stay plain dots.
 */
export const MASK_DOTS = '•••••';
export const mask = (): string => '৳' + MASK_DOTS;

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
