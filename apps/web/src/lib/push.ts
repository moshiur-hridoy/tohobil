/**
 * Browser (PWA) push: ask permission, subscribe through the service worker and tell the server.
 * A sign-in creates a new device row on the server, so `useSyncPush` re-sends an existing
 * subscription whenever the app opens signed in.
 */
import { useEffect } from 'react';
import { api } from './api';

export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on' | 'not-configured';

const isIos = (): boolean => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

export const pushSupported = (): boolean =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function publicKey(): Promise<string | null> {
  return (await api<{ key: string | null }>('/push/public-key')).key;
}

async function send(sub: PushSubscription): Promise<void> {
  await api('/devices', { method: 'POST', body: { web_push: sub.toJSON(), push_enabled: true } });
}

export async function pushState(): Promise<PushState> {
  // iPhones only allow push for an app that was added to the Home Screen.
  if (isIos() && !isStandalone()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if ((await publicKey()) === null) return 'not-configured';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Must run from a tap: asks permission, subscribes and registers this device. */
export async function enablePush(): Promise<PushState> {
  const key = await publicKey();
  if (!key) return 'not-configured';
  if ((await Notification.requestPermission()) !== 'granted') return pushState();
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await send(sub);
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  await sub?.unsubscribe();
  await api('/devices', { method: 'POST', body: { push_enabled: false } });
  return pushState();
}

/** Keeps the server's copy of this device's subscription current. Call once while signed in. */
export function useSyncPush(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn || !pushSupported() || Notification.permission !== 'granted') return;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) await send(sub);
      } catch {
        // Offline or not configured: the next app start tries again.
      }
    })();
  }, [signedIn]);
}
