import { existsSync, readFileSync } from 'node:fs';
import { initializeApp, cert, type ServiceAccount, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
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
