import { execFileSync } from 'node:child_process';
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import pg from 'pg';
import bn from '../packages/shared/src/i18n/bn.json' with { type: 'json' };
import { API_PORT, E2E_APP_URL, PIN } from './env';

const API_BASE = `http://localhost:${API_PORT}/api/v1`;

export const MOBILE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };

/** A Bengali UI string by i18n key, with {placeholders} filled. The app runs in Bengali by default. */
export function tr(key: string, params: Record<string, string | number> = {}): string {
  let node: unknown = bn;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)?.[part];
  if (typeof node !== 'string') throw new Error(`Missing i18n key ${key}`);
  return node.replace(/\{\{?(\w+)\}?\}/g, (_m, name: string) => String(params[name] ?? `{${name}}`));
}

export async function newPage(browser: Browser, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  return { context, page: await context.newPage() };
}

const LS = {
  device: 'barakah.device_id',
  refresh: 'barakah.refresh_token',
  ref: 'barakah.member_ref',
  install: 'barakah.install_id',
} as const;

/** Plant a server-issued session into the page so the PWA resumes as if the PIN was entered. */
export async function resumeSession(page: Page, ref: string, session: Session): Promise<void> {
  await page.context().addInitScript(
    ({ keys, values }) => {
      for (const [k, v] of Object.entries(values)) {
        if (v === null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }
    },
    {
      values: {
        [LS.device]: session.device_id,
        [LS.refresh]: session.refresh_token,
        [LS.ref]: ref.toUpperCase(),
        [LS.install]: `e2e-${ref}`,
      },
    },
  );
}

/** Activation screen: member id and code, choose the PIN, confirm it. Lands on the app. */
export async function activate(page: Page, ref: string, code: string): Promise<Session> {
  await page.goto('/activate');
  await page.getByLabel(tr('auth.memberRef')).fill(ref);
  await page.getByLabel(tr('auth.activateCode')).fill(code);
  await page.getByRole('button', { name: tr('common.next') }).click();
  await expect(page.getByRole('heading', { name: tr('auth.setPinTitle') })).toBeVisible();
  await page.keyboard.type(PIN);
  await expect(page.getByRole('heading', { name: tr('auth.confirmPinTitle') })).toBeVisible();
  await page.keyboard.type(PIN);
  await expect(page).not.toHaveURL(/\/activate/);
  const session = await page.evaluate(() => ({
    access_token: (window as unknown as { __accessToken?: string }).__accessToken ?? '',
    refresh_token: localStorage.getItem('barakah.refresh_token') ?? '',
    device_id: localStorage.getItem('barakah.device_id') ?? '',
  }));
  return session;
}

/** Cashier and auditor: enrol the authenticator (or enter a code) and open the 12 h step-up window. */
export async function stepUp(page: Page): Promise<void> {
  await page.goto('/totp');
  const start = page.getByRole('button', { name: tr('totp.startEnrol') });
  await expect(start.or(page.getByLabel(tr('totp.code')))).toBeVisible();
  if (await start.isVisible()) {
    await start.click();
    const secret = (await page.locator('p.font-mono').innerText()).replace(/\s/g, '');
    await page.getByLabel(tr('totp.code')).fill(authenticator.generate(secret));
    await page.getByRole('button', { name: tr('totp.verify') }).click();
    await expect(page).not.toHaveURL(/\/totp/);
    // remember the secret for a later step-up in the same run
    (page.context() as unknown as { _totp?: string })._totp = secret;
  } else {
    const secret = (page.context() as unknown as { _totp?: string })._totp;
    if (!secret) throw new Error('no authenticator secret known for this context');
    await page.getByLabel(tr('totp.code')).fill(authenticator.generate(secret));
    await page.getByRole('button', { name: tr('totp.verify') }).click();
    await expect(page).not.toHaveURL(/\/totp/);
  }
}

/** Today's date in Asia/Dhaka as DD/MM/YYYY (the form bKash writes in its messages). */
export function todayDdMmYyyy(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}

/** Set E2E_SHOTS=1 to save full-page screenshots to e2e/test-results/shots for a visual check. */
export async function shot(page: Page, name: string): Promise<void> {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `e2e/test-results/shots/${name}.png`, fullPage: true });
}

// -----------------------------------------------------------------------------------------------
// Server-side activation codes for the e2e database. Only works against a local Postgres.
// -----------------------------------------------------------------------------------------------

/** Issue a fresh activation code via the server CLI (replaces any existing devices by default). */
export function issueCode(ref: string, mode: 'replace' | 'add' = 'replace'): string {
  const out = execFileSync('pnpm', ['activation-code', ref.toUpperCase(), `--mode=${mode}`], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, DATABASE_URL: E2E_APP_URL },
  });
  const match = out.match(/Code\s+([0-9A-HJKMNP-TV-Z]{8})/);
  if (!match) throw new Error(`Could not parse activation code output for ${ref}`);
  return match[1]!;
}

// -----------------------------------------------------------------------------------------------
// Headless API client: activates and uses bearer tokens so scenarios can drive the backend
// without depending on UI state left behind by earlier tests.
// -----------------------------------------------------------------------------------------------

export interface Session {
  access_token: string;
  refresh_token: string;
  device_id: string;
}

/** Dev-only TOTP reset so each scenario can enrol the cashier's device deterministically. */
export async function resetTotp(ref: string): Promise<void> {
  const db = new pg.Client({ connectionString: E2E_APP_URL });
  await db.connect();
  try {
    await db.query(
      `UPDATE users u SET totp_enabled = false, totp_secret_enc = NULL
       FROM members m WHERE m.id = u.member_id AND m.code = $1`,
      [ref.toUpperCase()],
    );
  } finally {
    await db.end();
  }
}

/** Authenticated HTTP API client with helper methods for the governance scenarios. */
export class Api {
  private token: string | null = null;
  private totpSecret: string | null = null;

  constructor(private request: APIRequestContext) {}

  /** Activate a device and store the access token. `code` may be obtained with `issueCode`. */
  async activate(memberRef: string, code: string): Promise<Session> {
    const session = await this.post<Session>('/auth/activate', {
      member_ref: memberRef,
      code,
      pin: PIN,
      device: { label: 'e2e-api', platform: 'web', install_id: `e2e-${memberRef}-${Date.now()}` },
    }, false);
    this.token = session.access_token;
    return session;
  }

  /** Enrol and verify TOTP, opening the 12 h privileged step-up window. */
  async stepUp(): Promise<void> {
    const { secret } = await this.post<{ secret: string }>('/auth/totp/enroll', {});
    this.totpSecret = secret;
    await this.post('/auth/totp/verify', { code: authenticator.generate(secret) });
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.request.get(`${API_BASE}${path}`, { headers: this.headers() });
    expect(res.ok(), `GET ${path} failed: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  }

  async post<T = unknown>(path: string, body: Record<string, unknown>, auth = true): Promise<T> {
    const res = await this.request.post(`${API_BASE}${path}`, {
      data: body,
      headers: auth ? this.headers() : undefined,
    });
    expect(res.ok(), `POST ${path} failed: ${await res.text()}`).toBeTruthy();
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  async patch<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.request.patch(`${API_BASE}${path}`, { data: body, headers: this.headers() });
    expect(res.ok(), `PATCH ${path} failed: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as T;
  }

  private headers(): Record<string, string> {
    if (!this.token) throw new Error('Api client is not activated');
    return { authorization: `Bearer ${this.token}` };
  }
}

/** Resolve a member UUID from their public code (e.g. M02). */
export async function memberIdByCode(api: Api, code: string): Promise<string> {
  const { items } = await api.get<{ items: Array<{ id: string; code: string }> }>('/members');
  const found = items.find((m) => m.code === code.toUpperCase());
  if (!found) throw new Error(`Member ${code} not found`);
  return found.id;
}
