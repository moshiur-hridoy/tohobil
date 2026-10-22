import { existsSync, readFileSync } from 'node:fs';
import { initializeApp, cert, type ServiceAccount, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import webpush from 'web-push';
import type { Logger } from 'pino';

export interface PushResult {
  ok: boolean;
  unregistered?: boolean;
  error?: string;
}

export interface PushSender {
  send(
    tokens: string[],
    title: string | undefined,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushResult[]>;
}

/** No-op sender for tests and environments without FCM credentials. */
export class ConsolePushSender implements PushSender {
  constructor(private readonly log: Logger) {}

  async send(tokens: string[], title: string | undefined, body: string): Promise<PushResult[]> {
    this.log.info({ tokens: tokens.length, title, body: body.slice(0, 160) }, '[push] console sender');
    return tokens.map(() => ({ ok: true }));
  }
}

/**
 * FCM HTTP v1 sender. Requires FCM_SERVICE_ACCOUNT_JSON_PATH pointing to a service account JSON.
 * If initialization fails, every send returns ok=false so the worker can retry later.
 */
export class FcmPushSender implements PushSender {
  private initPromise: Promise<App | undefined> | undefined;

  private async app(): Promise<App | undefined> {
    this.initPromise ??= this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<App | undefined> {
    try {
      const path = process.env.FCM_SERVICE_ACCOUNT_JSON_PATH;
      if (!path) return undefined;
      if (!existsSync(path)) return undefined;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as ServiceAccount;
      const { getApps } = await import('firebase-admin/app');
      if (getApps().length > 0) return getApps()[0];
      return initializeApp({ credential: cert(raw) });
    } catch {
      return undefined;
    }
  }

  async send(
    tokens: string[],
    title: string | undefined,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushResult[]> {
    const app = await this.app();
    if (!app) {
      return tokens.map(() => ({ ok: false, error: 'FCM not configured' }));
    }
    const messaging = getMessaging(app);
    const results: PushResult[] = [];
    const batch = 500;
    for (let i = 0; i < tokens.length; i += batch) {
      const slice = tokens.slice(i, i + batch);
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: slice,
          notification: { title, body },
          data,
          android: { priority: 'high' },
        });
        response.responses.forEach((r) => {
          if (r.success) {
            results.push({ ok: true });
            return;
          }
          const code = r.error?.code as string | undefined;
          const unregistered = code === 'messaging/registration-token-not-registered';
          results.push({ ok: false, unregistered, error: r.error?.message });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push(...slice.map(() => ({ ok: false, error: message })));
      }
    }
    return results;
  }
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Browser (PWA) push. A subscription is stored as its JSON text in `devices.fcm_token`, so a token
 * that starts with `{` is a web subscription and anything else is an FCM token (Android app).
 */
export class WebPushSender implements PushSender {
  constructor(private readonly vapid: VapidConfig) {}

  async send(
    tokens: string[],
    title: string | undefined,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushResult[]> {
    const payload = JSON.stringify({ title: title ?? '', body, data: data ?? {} });
    return Promise.all(
      tokens.map(async (token): Promise<PushResult> => {
        try {
          const subscription = JSON.parse(token) as webpush.PushSubscription;
          await webpush.sendNotification(subscription, payload, {
            vapidDetails: {
              subject: this.vapid.subject,
              publicKey: this.vapid.publicKey,
              privateKey: this.vapid.privateKey,
            },
            TTL: 24 * 60 * 60,
            urgency: 'high',
          });
          return { ok: true };
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, unregistered: status === 404 || status === 410, error: message };
        }
      }),
    );
  }
}

const isWebSubscription = (token: string): boolean => token.startsWith('{');

/** Sends web subscriptions through `web` and everything else through `native`, keeping the result order. */
export class RoutingPushSender implements PushSender {
  constructor(
    private readonly native: PushSender,
    private readonly web: PushSender | undefined,
  ) {}

  async send(
    tokens: string[],
    title: string | undefined,
    body: string,
    data?: Record<string, string>,
  ): Promise<PushResult[]> {
    const webIdx: number[] = [];
    const nativeIdx: number[] = [];
    tokens.forEach((t, i) => (isWebSubscription(t) ? webIdx : nativeIdx).push(i));
    const results: PushResult[] = new Array<PushResult>(tokens.length);
    if (nativeIdx.length) {
      const r = await this.native.send(nativeIdx.map((i) => tokens[i]!), title, body, data);
      nativeIdx.forEach((i, k) => (results[i] = r[k] ?? { ok: false, error: 'no result' }));
    }
    if (webIdx.length) {
      const r = this.web
        ? await this.web.send(webIdx.map((i) => tokens[i]!), title, body, data)
        : webIdx.map(() => ({ ok: false, error: 'Web push not configured' }));
      webIdx.forEach((i, k) => (results[i] = r[k] ?? { ok: false, error: 'no result' }));
    }
    return results;
  }
}

/** FCM when its key file exists, browser push when the VAPID keys are set, else the console sender. */
export function createPushSender(opts: {
  fcmFile?: string;
  vapid?: VapidConfig;
  log: Logger;
}): PushSender {
  const native: PushSender =
    opts.fcmFile && existsSync(opts.fcmFile) ? new FcmPushSender() : new ConsolePushSender(opts.log);
  if (!opts.vapid) return native;
  return new RoutingPushSender(native, new WebPushSender(opts.vapid));
}

/** The VAPID settings from the environment, or undefined when browser push is not set up. */
export function vapidFromEnv(env: {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT: string;
}): VapidConfig | undefined {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return undefined;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}
