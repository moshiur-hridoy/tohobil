import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, type APIRequestContext, type Page } from '@playwright/test';
import { authenticator } from 'otplib';
import { API_PORT, E2E_APP_URL, PIN } from '../env';
import { DESKTOP, MOBILE, activate, issueCode, stepUp } from '../helpers';

/**
 * Builds the data of the public UI demo (docs/DEMO.md), against the throwaway e2e database only:
 *
 *  1. fills the fictional fixture with ten months of history (dues, payments with a few members
 *     behind, a payment waiting for the cashier, proposals in every state, an asset, a partner shop
 *     and a meeting);
 *  2. signs in as the cashier (M01), the auditor (M07) and a member (M02), opens every screen and
 *     saves each GET response the screen received to apps/web/src/demo/data/<role>.json.
 *
 * The demo build (VITE_DEMO=1) answers from those files instead of an API.
 */

const API_BASE = `http://localhost:${API_PORT}/api/v1`;
const OUT_DIR = fileURLToPath(new URL('../../apps/web/src/demo/data/', import.meta.url));

/** Dhaka "YYYY-MM" of today, and every period of the year up to it. */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
const CURRENT_PERIOD = TODAY.slice(0, 7);
const YEAR = TODAY.slice(0, 4);
const PERIODS = Array.from({ length: Number(CURRENT_PERIOD.slice(5)) }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, '0')}`);

/** How many of the latest months each member leaves unpaid, so the matrix and reminders have something to show. */
const BEHIND: Record<string, number> = { M03: 1, M04: 2, M05: 1, M06: 3 };
const METHODS = ['bkash', 'cash', 'bank', 'nagad'] as const;

/** A tolerant API client: setup steps that fail are logged and skipped, so one refusal does not lose the whole recording. */
class Client {
  private token = '';
  /** The authenticator secret once enrolled, so the browser can step up with the same one. */
  totpSecret = '';
  constructor(
    private request: APIRequestContext,
    readonly ref: string,
  ) {}

  async activate(): Promise<this> {
    const s = await this.call<{ access_token: string }>('POST', '/auth/activate', {
      member_ref: this.ref,
      code: issueCode(this.ref, 'add'),
      pin: PIN,
      device: { label: 'demo-recorder', platform: 'web', install_id: `demo-${this.ref}-${Date.now()}` },
    });
    this.token = s!.access_token;
    return this;
  }

  async stepUp(): Promise<void> {
    const r = await this.call<{ secret: string }>('POST', '/auth/totp/enroll', {});
    this.totpSecret = r!.secret;
    await this.call('POST', '/auth/totp/verify', { code: authenticator.generate(r!.secret) });
  }

  get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path) as Promise<T>;
  }

  post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T | null> {
    return this.call<T>('POST', path, body);
  }

  /** Uploads a tiny PDF (a stand-in receipt) and returns its file id. */
  async uploadReceipt(): Promise<string | null> {
    const res = await this.request.post(`${API_BASE}/files`, {
      headers: { authorization: `Bearer ${this.token}`, 'idempotency-key': crypto.randomUUID() },
      multipart: { file: { name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% demo receipt\n%%EOF\n') } },
    });
    if (!res.ok()) {
      console.warn(`  skipped receipt upload: ${res.status()} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return ((await res.json()) as { id: string }).id;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    const res = await this.request.fetch(`${API_BASE}${path}`, {
      method,
      ...(body !== undefined ? { data: body } : {}),
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
    const text = await res.text();
    if (!res.ok()) {
      if (method === 'GET' || path.startsWith('/auth/')) throw new Error(`${method} ${path}: ${res.status()} ${text}`);
      console.warn(`  skipped ${method} ${path}: ${res.status()} ${text.slice(0, 200)}`);
      return null;
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

interface Due { id: string; period: string; outstanding_paisa: string }
interface Member { id: string; code: string }

/** paid_at for a period: the 5th of that month, or now if that is still ahead. */
function paidAt(period: string): string {
  const d = new Date(`${period}-05T10:00:00+06:00`);
  return (d > new Date() ? new Date() : d).toISOString();
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

/** Fills the e2e database with history; returns the cashier's authenticator secret. */
async function buildHistory(request: APIRequestContext): Promise<string> {
  const run = (args: string[]) =>
    execFileSync('pnpm', args, { env: { ...process.env, DATABASE_URL: E2E_APP_URL }, stdio: 'inherit' });
  for (const period of PERIODS) run(['--filter', '@barakah/api', 'exec', 'tsx', 'src/cli/generate-dues.ts', period]);

  const voters: Record<string, Client> = {};
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const ref = `M0${n}`;
    voters[ref] = await new Client(request, ref).activate();
  }
  const cashier = voters.M01!;
  await cashier.stepUp();
  const { items: members } = await cashier.get<{ items: Member[] }>('/members');

  // Payments: every member pays month by month, except the latest months listed in BEHIND.
  let n = 0;
  for (const m of members) {
    const { items } = await cashier.get<{ items: Due[] }>(`/dues?member_id=${m.id}&limit=60`);
    const dues = items.filter((d) => BigInt(d.outstanding_paisa) > 0n).sort((a, b) => a.period.localeCompare(b.period));
    const paid = dues.slice(0, Math.max(0, dues.length - (BEHIND[m.code] ?? 0)));
    for (const d of paid) {
      const method = METHODS[n++ % METHODS.length]!;
      await cashier.post('/payments/cashier-entry', {
        member_id: m.id,
        amount_paisa: d.outstanding_paisa,
        method,
        purpose: 'dues',
        paid_at: paidAt(d.period),
        for_periods: [d.period],
        ...(method === 'cash' ? {} : { trx_id: `DEMO${m.code}${d.period.replace('-', '')}` }),
      });
    }
  }

  // One payment waiting for the cashier: M05 says they have sent this month's money.
  const m05 = members.find((m) => m.code === 'M05')!;
  const { items: m05Dues } = await cashier.get<{ items: Due[] }>(`/dues?member_id=${m05.id}&limit=60`);
  const open = m05Dues.find((d) => BigInt(d.outstanding_paisa) > 0n);
  if (open) {
    await voters.M05!.post('/payments', {
      amount_paisa: open.outstanding_paisa,
      method: 'bkash',
      purpose: 'dues',
      trx_id: 'DEMOPENDING05',
      for_periods: [open.period],
    });
  }

  // Proposals in every state.
  const propose = async (body: Record<string, unknown>, votes: Record<string, 'yes' | 'no' | 'abstain'>, close: boolean) => {
    const p = await cashier.post<{ id: string }>('/proposals', body);
    if (!p) return null;
    await cashier.post(`/proposals/${p.id}/open`, { closes_at: `${inDays(close ? 7 : 10)}T18:00:00Z` });
    for (const [ref, choice] of Object.entries(votes)) await voters[ref]!.post(`/proposals/${p.id}/vote`, { choice });
    if (close) await cashier.post(`/proposals/${p.id}/close-early`);
    return p.id;
  };
  const majority = { M01: 'yes', M03: 'yes', M04: 'yes', M05: 'yes', M06: 'yes', M07: 'yes' } as const;

  // Open: M02 (the demo member) has not voted yet, so the vote buttons show.
  await propose(
    { type: 'general', title: 'বার্ষিক সাধারণ সভা ঢাকায় আয়োজন', description: 'আগামী বছরের বার্ষিক সভা ঢাকায় সবার সুবিধামতো একটি হলে করার প্রস্তাব।', payload: { text: 'বার্ষিক সভা ঢাকায় হবে' } },
    { M01: 'yes', M03: 'yes', M04: 'no', M05: 'abstain' },
    false,
  );
  await propose(
    { type: 'expense', title: 'দোকানের সাইনবোর্ড মেরামত', payload: { max_amount_paisa: '1500000', account: 'MAINTENANCE', payee: 'রহমান সাইন হাউস', purpose: 'দোকানের পুরনো সাইনবোর্ড বদলানো' } },
    { M01: 'yes', M07: 'yes' },
    false,
  );
  // Approved and carried out.
  const donation = await propose(
    { type: 'charity_donation', title: 'বন্যার্তদের জন্য অনুদান', payload: { recipient: 'স্থানীয় ত্রাণ কমিটি', amount_paisa: '1000000', purpose: 'বন্যার্ত পরিবারের খাদ্য সহায়তা' } },
    majority,
    true,
  );
  const receipt = donation ? await cashier.uploadReceipt() : null;
  if (donation && receipt) await cashier.post(`/proposals/${donation}/execute`, { account: 'BANK', proof_file_id: receipt, note: 'ত্রাণ কমিটির রসিদ' });
  const distribution = await propose(
    { type: 'distribution', title: 'অর্ধবার্ষিক মুনাফা বণ্টন', payload: { total_paisa: '400000', source_account: 'CASH' } },
    majority,
    true,
  );
  if (distribution) await cashier.post(`/proposals/${distribution}/execute`, {});
  // Turned down.
  await propose(
    { type: 'general', title: 'মাসিক চাঁদা দেওয়ার শেষ তারিখ ২০ তারিখে সরানো', payload: { text: 'শেষ তারিখ ১০ থেকে ২০ তারিখ' } },
    { M01: 'no', M03: 'no', M04: 'no', M05: 'no', M06: 'yes', M07: 'no' },
    true,
  );

  // An asset under consideration, a partner shop and the next meeting.
  await cashier.post('/assets', { kind: 'gold', name: 'সোনা ১০ ভরি', description: 'দীর্ঘমেয়াদি সঞ্চয়ের জন্য সোনা কেনার পরিকল্পনা', quantity: '10', unit: 'vori' });
  await cashier.post('/assets', { kind: 'land', name: 'গাজীপুরে ৫ কাঠা জমি', location: 'গাজীপুর', description: 'ভবিষ্যতে দোকান ভাড়ার জন্য' });
  await cashier.post('/partners', { kind: 'gold', name: 'আল-আমিন জুয়েলার্স', contract_date: TODAY, rate_percent: 12, period_months: 12, sharing_policy: 'মুনাফা ৬০:৪০ হারে ভাগ' });
  await cashier.post('/meetings', { date: inDays(14), time: '20:00', link: 'https://meet.google.com/', notes: 'বার্ষিক হিসাব ও নতুন বিনিয়োগ নিয়ে আলোচনা' });
  return cashier.totpSecret;
}

/** Opens each route and keeps every successful JSON GET the page made, keyed by path and query. */
async function crawl(page: Page, routes: string[], data: Record<string, unknown>): Promise<string> {
  let auth = '';
  page.on('request', (req) => {
    const h = req.headers().authorization;
    if (h && req.url().includes('/api/v1/')) auth = h;
  });
  page.on('response', async (res) => {
    const url = new URL(res.url());
    if (!url.pathname.startsWith('/api/v1/') || res.request().method() !== 'GET' || res.status() !== 200) return;
    if (!(res.headers()['content-type'] ?? '').includes('json')) return;
    try {
      data[url.pathname.slice('/api/v1'.length) + url.search] = await res.json();
    } catch {
      // Body already gone (navigation): the next visit records it.
    }
  });
  for (const route of routes) {
    await page.goto(route);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(400);
  }
  return auth;
}

/** Endpoints that only open behind a click (sheets, detail views): fetched directly, in the exact form the screens ask for them. */
async function recordExtras(request: APIRequestContext, auth: string, data: Record<string, unknown>, privileged: boolean, meId: string): Promise<void> {
  const get = async (path: string) => {
    if (path in data) return data[path];
    const res = await request.get(`${API_BASE}${path}`, { headers: { authorization: auth } });
    if (res.ok() && (res.headers()['content-type'] ?? '').includes('json')) data[path] = await res.json();
    return data[path];
  };
  const items = async <T>(path: string) => (((await get(path)) as { items?: T[] } | undefined)?.items ?? []);

  for (const p of await items<{ id: string }>('/proposals?limit=200')) await get(`/proposals/${p.id}`);
  for (const p of await items<{ id: string }>('/partners')) await get(`/partners/${p.id}`);
  for (const p of await items<{ id: string }>('/meetings')) {
    await get(`/meetings/${p.id}`);
    await get(`/meetings/${p.id}/attendance`);
  }
  for (const p of (await items<{ id: string }>('/payments')).slice(0, 30)) await get(`/payments/${p.id}`);
  for (const v of await items<{ id: string }>('/constitution/versions')) await get(`/constitution/versions/${v.id}`);
  await get(`/members/${meId}`);
  if (!privileged) return;

  for (const m of await items<{ id: string }>('/members')) {
    await get(`/members/${m.id}`);
    await get(`/members/${m.id}/status-history`);
    await get(`/members/${m.id}/contact-log`);
    await get(`/members/${m.id}/entry-quote`);
    await get(`/members/${m.id}/settlement-estimate?kind=early_exit`);
    for (const purpose of ['dues', 'levy', 'special']) await get(`/payments/entry-preview?member_id=${m.id}&purpose=${purpose}`);
  }
  for (const r of await items<{ key: string }>('/rules')) await get(`/rules?key=${r.key}&history=true`);
  for (const period of PERIODS) {
    await get(`/reconciliations?period=${period}`);
    await get(`/rent/expected?period=${period}`);
  }
  await get(`/periods?year=${YEAR}`);
  await get(`/periods/${YEAR}/audit`);
  await get('/payments?status=pending&limit=50');
  await get('/approvals?status=pending&limit=50');
}

const MEMBER_ROUTES = ['/home', '/pay', '/votes', '/assets', '/menu', '/menu/ledger', '/menu/members', '/menu/constitution', '/menu/notices', '/menu/settlement', '/menu/pin', '/menu/devices', '/menu/security'];
const ADMIN_ROUTES = ['/admin', '/admin/matrix', '/admin/payments', '/admin/ledger', '/admin/members', '/admin/proposals', '/admin/rules', '/admin/meetings', '/admin/charity', '/admin/settings', '/admin/notifications', '/admin/assets', '/admin/reconcile', '/admin/reports', '/admin/rent', '/admin/obligations', '/admin/settlements', '/admin/system'];

test('record the UI demo data', async ({ browser, request }) => {
  const cashierTotp = await buildHistory(request);
  mkdirSync(OUT_DIR, { recursive: true });

  for (const [role, ref, viewport, privileged] of [
    ['cashier', 'M01', DESKTOP, true],
    ['auditor', 'M07', DESKTOP, true],
    ['member', 'M02', MOBILE, false],
  ] as const) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await activate(page, ref, issueCode(ref, 'add'));
    // stepUp() reuses a secret kept on the context when the authenticator is already enrolled.
    if (ref === 'M01') (context as unknown as { _totp?: string })._totp = cashierTotp;
    // Only the cashier has an authenticator; the auditor confirms each action with their PIN (ASSUMPTIONS.md 117).
    if (ref === 'M01') await stepUp(page);

    const data: Record<string, unknown> = {};
    const proposalIds = ((await (await request.get(`${API_BASE}/proposals?limit=200`, { headers: { authorization: await bearer(page) } })).json()) as { items: Array<{ id: string }> }).items.map((p) => p.id);
    const routes = [...MEMBER_ROUTES, ...proposalIds.map((id) => `/votes/${id}`), ...(privileged ? ADMIN_ROUTES : [])];
    // Mobile and desktop ask for slightly different data, so privileged roles are crawled at both sizes.
    const auth = await crawl(page, routes, data);
    if (privileged) {
      await page.setViewportSize(MOBILE);
      await crawl(page, MEMBER_ROUTES, data);
    }
    const me = data['/me'] as { member_id: string };
    await recordExtras(request, auth, data, privileged, me.member_id);

    const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(`${OUT_DIR}${role}.json`, `${JSON.stringify(sorted, null, 1)}\n`);
    console.log(`  ${role}: ${Object.keys(sorted).length} responses`);
    await context.close();
  }
});

/** The page's current bearer token, taken from its next API call. */
async function bearer(page: Page): Promise<string> {
  const req = page.waitForRequest((r) => r.url().includes('/api/v1/') && !!r.headers().authorization);
  await page.goto('/home');
  return (await req).headers().authorization!;
}
