import type { Logger } from 'pino';

export interface SmsResult {
  ok: boolean;
  error?: string;
}

export interface SmsProvider {
  send(phone: string, text: string): Promise<SmsResult>;
}

export interface SmsConfig {
  provider: 'console' | 'http';
  httpUrl?: string;
  apiKey?: string;
  senderId?: string;
  bodyTemplate?: string;
}

/** Logs SMS to stdout; default dev provider (spec 19.1). */
export class ConsoleSmsProvider implements SmsProvider {
  constructor(private readonly log: Logger) {}

  async send(phone: string, text: string): Promise<SmsResult> {
    const masked = phone.slice(0, 7) + '****' + phone.slice(-4);
    this.log.info({ to: masked, text: text.slice(0, 160) }, '[sms] console provider');
    return { ok: true };
  }
}

/**
 * Generic HTTP SMS gateway adapter.
 * The template is a POST body string with placeholders:
 *   {{phone}}   - recipient number (E.164)
 *   {{text}}    - Unicode message text
 *   {{sender}}  - configured sender id
 *
 * The actual URL, API key/header and body shape differ by gateway; this adapter covers the
 * common pattern. A new gateway that needs a different shape should get its own adapter.
 */
export class HttpSmsProvider implements SmsProvider {
  constructor(private readonly config: SmsConfig, private readonly log: Logger) {}

  async send(phone: string, text: string): Promise<SmsResult> {
    const url = this.config.httpUrl;
    if (!url) return { ok: false, error: 'SMS_HTTP_URL not configured' };
    const body = (this.config.bodyTemplate ?? '{{phone}}&message={{text}}')
      .replace(/\{\{phone\}\}/g, encodeURIComponent(phone))
      .replace(/\{\{text\}\}/g, encodeURIComponent(text))
      .replace(/\{\{sender\}\}/g, encodeURIComponent(this.config.senderId ?? 'Barakah'));

    try {
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
      if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey;
      const res = await fetch(url, { method: 'POST', headers, body });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }
}

export function createSmsProvider(config: SmsConfig, log: Logger): SmsProvider {
  if (config.provider === 'http') return new HttpSmsProvider(config, log);
  return new ConsoleSmsProvider(log);
}
