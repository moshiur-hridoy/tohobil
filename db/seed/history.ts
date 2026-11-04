/**
 * Fill the LOCAL dev fund with fictional history, so every screen has something to show:
 * dues for every month this year, payments (a few members behind, one waiting for the cashier),
 * proposals open, approved and turned down, two gold shops with purchases and a value update
 * (one up, one down), a planned land asset and the next meeting.
 *
 * Everything goes through the running API, the same way the cashier and members would do it, so the
 * ledger, hash chain, votes and audit log are all real. Nothing is written to financial tables directly.
 *
 *   pnpm dev              # in another terminal: the API must be running
 *   pnpm seed:history
 *
 * Side effect, local only: every member (M01 to M08) gets the PIN below, and M01 gets a fresh
 * authenticator key, printed at the end. Refuses to run against anything but this computer, and
 * refuses a second run once there are payments (so nothing is ever doubled).
 */

import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { authenticator } from 'otplib';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file: rely on the process environment.
}

const PIN = '483917';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://barakah_app:barakah_app@localhost:5432/barakah';
const API = process.env.SEED_API_URL ?? `http://localhost:${process.env.PORT ?? '3000'}/api/v1`;
const LOCAL = ['localhost', '127.0.0.1', '::1'];

const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
const YEAR = TODAY.slice(0, 4);
const PERIODS = Array.from({ length: Number(TODAY.slice(5, 7)) }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, '0')}`);

/** How many of the latest months each member leaves unpaid, so reminders and the matrix have something to show. */
const BEHIND: Record<string, number> = { M03: 1, M04: 2, M05: 1, M06: 3 };
/** Mostly bank, so one account holds enough for the purchases. */
const METHODS = ['bank', 'bkash', 'bank', 'cash', 'bank', 'nagad'] as const;
const ALL_TICKED = {
  interest_free_instrument: true,
  not_conventional_fixed_deposit: true,
  not_conventional_insurance: true,
  not_speculative_trading: true,
  permissible_business: true,
  liquidatable_within_term: true,
  no_fixed_profit_promised: true,
};

function assertLocal(): void {
  const dbHost = new URL(DATABASE_URL).hostname;
  const apiHost = new URL(API).hostname;
  if (process.env.NODE_ENV === 'production' || !LOCAL.includes(dbHost) || !LOCAL.includes(apiHost)) {
    throw new Error(`Refusing to run: this fills a LOCAL dev fund only (database ${dbHost}, API ${apiHost}).`);
  }
}

class Client {
  private token = '';
  totpSecret = '';
  constructor(readonly ref: string) {}

  async activate(): Promise<this> {
    const out = execFileSync('pnpm', ['--silent', 'activation-code', this.ref, '--add'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, DATABASE_URL },
    });
    const code = out.match(/Code\s+([0-9A-HJKMNP-TV-Z]{8})/)?.[1];
    if (!code) throw new Error(`Could not read the activation code for ${this.ref}`);
    const s = await this.call<{ access_token: string }>('POST', '/auth/activate', {
      member_ref: this.ref,
      code,
      pin: PIN,
      device: { label: 'seed-history', platform: 'web', install_id: `seed-${this.ref}-${Date.now()}` },
    }, true);
    this.token = s.access_token;
    return this;
  }

  async stepUp(): Promise<void> {
    const r = await this.call<{ secret: string }>('POST', '/auth/totp/enroll', {}, true);
    this.totpSecret = r.secret;
    await this.call('POST', '/auth/totp/verify', { code: authenticator.generate(r.secret) }, true);
  }

  /** Uploads a tiny stand-in PDF (feasibility report) and returns its file id. */
  async uploadPdf(name: string): Promise<string | null> {
    const form = new FormData();
    form.append('file', new Blob([`%PDF-1.4\n% ${name}\n%%EOF\n`], { type: 'application/pdf' }), `${name}.pdf`);
    const res = await fetch(`${API}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'idempotency-key': crypto.randomUUID() },
      body: form,
    });
    if (!res.ok) {
      console.warn(`  skipped file upload: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return ((await res.json()) as { id: string }).id;
  }

  get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path, undefined, true);
  }

  /** A write that may be refused: logged and skipped, so one refusal does not stop the rest. */
  async post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T | null> {
    try {
      return await this.call<T>('POST', path, body, true);
    } catch (err) {
      console.warn(`  skipped: ${(err as Error).message.slice(0, 240)}`);
      return null;
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, strict: boolean): Promise<T> {
    let res: Response;
    // The dev API allows 120 requests a minute per member: wait it out instead of failing.
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status !== 429 || attempt >= 30) break;
      if (attempt === 0) console.log('  (the API asked to slow down; waiting a little)');
      await new Promise((r) => setTimeout(r, 5000));
    }
    const text = await res.text();
    if (!res.ok && strict) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

interface Due { id: string; period: string; outstanding_paisa: string }
interface Member { id: string; code: string }
interface Balance { code: string; is_cash: boolean; balance_paisa: string }

function paidAt(period: string): string {
  const d = new Date(`${period}-05T10:00:00+06:00`);
  return (d > new Date() ? new Date() : d).toISOString();
}

const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  assertLocal();

  // Refuse a second run: payments would be doubled.
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM payments');
    if (Number(rows[0]?.n) > 0) {
      console.log('This local fund already has payments, so the history is not added again.');
      console.log('To start over: drop the local database, then `pnpm migrate && pnpm seed && pnpm seed:history`.');
      return;
    }
  } finally {
    await db.end();
  }

  try {
    await fetch(`${API}/health`);
  } catch {
    throw new Error(`The API is not running at ${API}. Start it first with \`pnpm dev\` in another terminal.`);
  }

  console.log(`Dues for ${PERIODS[0]} to ${PERIODS.at(-1)}...`);
  for (const period of PERIODS) {
    execFileSync('pnpm', ['--silent', '--filter', '@barakah/api', 'exec', 'tsx', 'src/cli/generate-dues.ts', period], {
      env: { ...process.env, DATABASE_URL },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }

  console.log('Signing in M01 to M08...');
  const as: Record<string, Client> = {};
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) as[`M0${n}`] = await new Client(`M0${n}`).activate();
  const cashier = as.M01!;
  await cashier.stepUp();
  const { items: members } = await cashier.get<{ items: Member[] }>('/members');

  console.log('Payments...');
  let n = 0;
  for (const m of members) {
    const { items } = await cashier.get<{ items: Due[] }>(`/dues?member_id=${m.id}&limit=60`);
    const dues = items.filter((d) => BigInt(d.outstanding_paisa) > 0n).sort((a, b) => a.period.localeCompare(b.period));
    for (const d of dues.slice(0, Math.max(0, dues.length - (BEHIND[m.code] ?? 0)))) {
      const method = METHODS[n++ % METHODS.length]!;
      await cashier.post('/payments/cashier-entry', {
        member_id: m.id,
        amount_paisa: d.outstanding_paisa,
        method,
        purpose: 'dues',
        paid_at: paidAt(d.period),
        for_periods: [d.period],
        ...(method === 'cash' ? {} : { trx_id: `SEED${m.code}${d.period.replace('-', '')}` }),
      });
    }
  }
  // One payment waiting for the cashier: M05 says they have sent the money.
  const m05 = members.find((m) => m.code === 'M05')!;
  const open = (await cashier.get<{ items: Due[] }>(`/dues?member_id=${m05.id}&limit=60`)).items.find((d) => BigInt(d.outstanding_paisa) > 0n);
  if (open) {
    await as.M05!.post('/payments', { amount_paisa: open.outstanding_paisa, method: 'bkash', purpose: 'dues', trx_id: 'SEEDPENDING05', for_periods: [open.period] });
  }

  /** Create, open, vote and (when `close`) close a proposal; returns its id. */
  const propose = async (body: Record<string, unknown>, votes: Record<string, 'yes' | 'no' | 'abstain'>, close: boolean) => {
    const p = await cashier.post<{ id: string }>('/proposals', body);
    if (!p) return null;
    const opened = await cashier.post(`/proposals/${p.id}/open`, { closes_at: `${inDays(close ? 7 : 10)}T18:00:00Z` });
    if (opened === null) return null;
    for (const [ref, choice] of Object.entries(votes)) await as[ref]!.post(`/proposals/${p.id}/vote`, { choice });
    if (close && (await cashier.post(`/proposals/${p.id}/close-early`)) === null) return null;
    return p.id;
  };
  const everyone = { M01: 'yes', M02: 'yes', M03: 'yes', M04: 'yes', M05: 'yes', M06: 'yes', M07: 'yes', M08: 'yes' } as const;

  /** The cash account with the most money in it right now. */
  const richest = async () => {
    const { items } = await cashier.get<{ items: Balance[] }>('/accounts/balances');
    return items.filter((a) => a.is_cash).sort((a, b) => (BigInt(b.balance_paisa) > BigInt(a.balance_paisa) ? 1 : -1))[0]!.code;
  };

  console.log('Gold shops, purchases and a value update...');
  const shops = [
    { name: 'নূর গোল্ড হাউস', rate: 12, buys: [['সোনা ৩ ভরি', 3, 21000000], ['সোনা ২ ভরি', 2, 14500000]], change: 3 },
    { name: 'রহমান জুয়েলার্স', rate: 10, buys: [['সোনা ১.৫ ভরি', 1.5, 10500000]], change: -2 },
  ] as const;
  for (const shop of shops) {
    // The API answers with the shop's page: { partner: { id, ... }, assets, ... }.
    const created = await cashier.post<{ partner: { id: string } }>('/partners', {
      kind: 'gold', name: shop.name, contract_date: `${YEAR}-03-01`, rate_percent: shop.rate, period_months: 12, sharing_policy: 'মুনাফা ৬০:৪০ হারে ভাগ',
    });
    const partner = created?.partner;
    if (!partner) continue;
    const bought: Array<{ id: string; cost: bigint }> = [];
    for (const [name, quantity, cost] of shop.buys) {
      const feasibility = await cashier.uploadPdf('feasibility');
      if (!feasibility) continue;
      const id = await propose(
        {
          type: 'investment_purchase',
          title: `${shop.name} থেকে ${name} কেনা`,
          payload: { kind: 'gold', name, quantity, unit: 'vori', max_amount_paisa: String(cost), source_account: 'BANK', compliance: ALL_TICKED, feasibility_file_id: feasibility, partner_id: partner.id },
        },
        everyone,
        true,
      );
      if (!id) continue;
      const done = await cashier.post<{ asset_id?: string }>(`/proposals/${id}/execute`, { actual_amount_paisa: String(cost), account: await richest() });
      if (done) {
        const asset = (await cashier.get<{ items: Array<{ id: string; proposal_id: string | null }> }>('/assets?limit=200')).items.find((a) => a.proposal_id === id);
        if (asset) bought.push({ id: asset.id, cost: BigInt(cost) });
      }
    }
    if (bought.length > 0) {
      const id = await propose(
        {
          type: 'valuation_update',
          title: `${shop.name}: সোনার নতুন বাজারদর`,
          payload: { items: bought.map((b) => ({ asset_id: b.id, value_paisa: String((b.cost * BigInt(100 + shop.change)) / 100n), basis: 'বাজুসের আজকের দর', as_of: TODAY })) },
        },
        everyone,
        true,
      );
      if (id) await cashier.post(`/proposals/${id}/execute`, {});
    }
  }

  console.log('Other proposals, a planned asset and a meeting...');
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
  await propose(
    { type: 'general', title: 'মাসিক চাঁদা দেওয়ার শেষ তারিখ ২৫ তারিখে সরানো', payload: { text: 'শেষ তারিখ ২০ থেকে ২৫ তারিখ' } },
    { M01: 'no', M02: 'no', M03: 'no', M04: 'no', M05: 'no', M06: 'yes', M07: 'no' },
    true,
  );
  await cashier.post('/assets', { kind: 'land', name: 'গাজীপুরে ৫ কাঠা জমি', location: 'গাজীপুর', description: 'ভবিষ্যতে দোকান ভাড়ার জন্য' });
  await cashier.post('/meetings', { date: inDays(14), time: '20:00', link: 'https://meet.google.com/', notes: 'বার্ষিক হিসাব ও নতুন বিনিয়োগ নিয়ে আলোচনা' });

  const nav = await cashier.get<{ net_assets_paisa: string }>('/nav');
  console.log('');
  console.log('Done. Net assets now:', (BigInt(nav.net_assets_paisa) / 100n).toString(), 'taka');
  console.log('');
  console.log(`Sign in on this computer with any member ID (M01 to M08) and PIN ${PIN}.`);
  console.log('M01 is the cashier, M07 the auditor.');
  console.log(`M01 authenticator key (add it in Google Authenticator, "Enter a setup key"): ${cashier.totpSecret}`);
}

main().catch((err: unknown) => {
  console.error((err as Error).message ?? err);
  process.exit(1);
});
