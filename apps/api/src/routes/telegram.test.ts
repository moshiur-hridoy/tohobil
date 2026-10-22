import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { systemClock } from '@barakah/shared';
import { buildApp } from '../app';
import type { InlineKeyboard, TelegramApi } from '../telegram/client';
import { TELEGRAM_DEVICE_ID } from '../telegram/service';
import { createTestDb, type TestDb } from '../test/db-harness';
import { activateSession, seedFund, testEnv, type Fund, type TestSession } from '../test/fund-fixture';

const clock = systemClock;
const TOKEN = '123456789:AAEhBP0av18mC_oQdUuUqXn7Zr3Kf9Gt2wk';
const CHAT = 555001;

interface Sent {
  chatId: string;
  html: string;
  keyboard?: InlineKeyboard | undefined;
}

/** Records every call instead of talking to Telegram. */
function fakeTelegram() {
  const sent: Sent[] = [];
  const edits: { messageId: number; html: string; keyboard?: InlineKeyboard | undefined }[] = [];
  const answers: (string | undefined)[] = [];
  let webhook: { url: string; secret: string } | null = null;
  let deleted = 0;
  const api: TelegramApi = {
    getMe: (token) => {
      if (token !== TOKEN) return Promise.reject(new Error('Unauthorized'));
      return Promise.resolve({ username: 'barakah_test_bot' });
    },
    setWebhook: (_t, url, secret) => {
      webhook = { url, secret };
      return Promise.resolve();
    },
    deleteWebhook: () => {
      deleted++;
      return Promise.resolve();
    },
    sendMessage: (_t, chatId, html, keyboard) => {
      sent.push({ chatId, html, keyboard });
      return Promise.resolve();
    },
    editMessage: (_t, _c, messageId, html, keyboard) => {
      edits.push({ messageId, html, keyboard });
      return Promise.resolve();
    },
    answerCallback: (_t, _id, text) => {
      answers.push(text);
      return Promise.resolve();
    },
  };
  return { api, sent, edits, answers, webhook: () => webhook, deleted: () => deleted };
}

const tg = fakeTelegram();

let db: TestDb | null;
let app: FastifyInstance;
let fund: Fund;
const s = {} as Record<'M01' | 'M02' | 'M07', TestSession>;
let secret = '';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = (method: Method, url: string, who?: string, payload?: unknown, headers = {}) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const q = async (sql: string, params: unknown[] = []) => (await db!.admin.query(sql, params)).rows;

const hook = (update: unknown, secretHeader = secret) =>
  call('POST', '/telegram/webhook', undefined, update, { 'x-telegram-bot-api-secret-token': secretHeader });

const press = (data: string, from = CHAT, messageId = 77) =>
  hook({ callback_query: { id: 'cb1', from: { id: from }, data, message: { message_id: messageId, chat: { id: from } } } });

let trxCounter = 0;
const submit = async (body: Record<string, unknown> = {}) => {
  const res = await call('POST', '/payments', s.M02.access_token, {
    amount_paisa: '500000',
    method: 'bkash',
    trx_id: `TGTRX${String(++trxCounter).padStart(5, '0')}`,
    ...body,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
};
/** The bot's message is sent in the background; wait until it shows up. */
async function nextSent(before: number): Promise<Sent> {
  for (let i = 0; i < 50 && tg.sent.length <= before; i++) await new Promise((r) => setTimeout(r, 20));
  return tg.sent[before] as Sent;
}

beforeAll(async () => {
  db = await createTestDb();
  if (!db) return;
  app = await buildApp({ env: testEnv, db: db.app, clock, telegramApi: tg.api });
  fund = await seedFund(db.admin);
  for (const code of ['M01', 'M02', 'M07'] as const) s[code] = await activateSession(app, db, clock, fund, code);
  const enrol = await call('POST', '/auth/totp/enroll', s.M01.access_token);
  const totp = (enrol.json() as { secret: string }).secret;
  const ok = await call('POST', '/auth/totp/verify', s.M01.access_token, { code: authenticator.generate(totp) });
  if (ok.statusCode !== 200) throw new Error(`step-up failed: ${ok.body}`);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

function dbIt(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!db) return ctx.skip();
    await fn();
  });
}

describe('telegram approvals', () => {
  dbIt('only the cashier may look at or change the settings', async () => {
    expect((await call('GET', '/telegram')).statusCode).toBe(401);
    expect((await call('GET', '/telegram', s.M02.access_token)).statusCode).toBe(403);
    expect((await call('POST', '/telegram/token', s.M02.access_token, { token: TOKEN })).statusCode).toBe(403);
    expect((await call('GET', '/telegram', s.M01.access_token)).json()).toMatchObject({ connected: false });
  });

  dbIt('rejects a token Telegram does not know, and one that is malformed', async () => {
    const bad = await call('POST', '/telegram/token', s.M01.access_token, { token: '999999999:AAEhBP0av18mC_oQdUuUqXn7Zr3Kf9Gt2zz' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'telegram.invalid_token' });
    expect((await call('POST', '/telegram/token', s.M01.access_token, { token: 'nonsense' })).statusCode).toBe(400);
  });

  dbIt('connecting registers the webhook and never stores or returns the token in the clear', async () => {
    const res = await call('POST', '/telegram/token', s.M01.access_token, { token: TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, bot_username: 'barakah_test_bot', linked: false, enabled: false });
    const w = tg.webhook()!;
    expect(w.url).toBe('https://fund.example/api/v1/telegram/webhook');
    secret = w.secret;
    const rows = await q(`SELECT value::text AS v FROM settings WHERE key = 'telegram'`);
    expect(rows[0].v).not.toContain(TOKEN);
    expect(rows[0].v).not.toContain(secret);
    const log = await q(`SELECT before::text AS b, after::text AS a FROM audit_log WHERE action = 'telegram.connect'`);
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    // The public settings read does not leak it either.
    expect(JSON.stringify((await call('GET', '/settings', s.M02.access_token)).json())).not.toContain('telegram');
  });

  dbIt('a webhook call without the right secret is refused', async () => {
    expect((await hook({}, 'wrong')).statusCode).toBe(401);
    expect((await call('POST', '/telegram/webhook', undefined, {})).statusCode).toBe(401);
  });

  dbIt('cannot be enabled before the cashier has identified their Telegram', async () => {
    const res = await call('PATCH', '/telegram', s.M01.access_token, { enabled: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'telegram.not_linked' });
  });

  dbIt('a stranger sending /start with a wrong code is not linked', async () => {
    const before = tg.sent.length;
    await hook({ message: { text: '/start guessed', chat: { id: 999, type: 'private' } } });
    expect(tg.sent.length).toBe(before + 1);
    expect(tg.sent[before]!.chatId).toBe('999');
    expect((await call('GET', '/telegram', s.M01.access_token)).json()).toMatchObject({ linked: false });
  });

  dbIt('the link code connects the chat once, as the cashier who asked for it', async () => {
    const code = (await call('POST', '/telegram/link-code', s.M01.access_token)).json() as { code: string; link: string };
    expect(code.link).toBe(`https://t.me/barakah_test_bot?start=${code.code}`);
    await hook({ message: { text: `/start ${code.code}`, chat: { id: CHAT, type: 'private' } } });
    expect((await call('GET', '/telegram', s.M01.access_token)).json()).toMatchObject({ linked: true, enabled: false });
    // The code is single use.
    await hook({ message: { text: `/start ${code.code}`, chat: { id: 4242, type: 'private' } } });
    expect(tg.sent.at(-1)!.chatId).toBe('4242');
    const row = await q(`SELECT value->>'chat_id' AS chat, value->>'user_id' AS u FROM settings WHERE key = 'telegram'`);
    expect(row[0]).toEqual({ chat: String(CHAT), u: fund.users.M01 });
  });

  dbIt('while switched off, a payment sends nothing and the buttons do nothing', async () => {
    const before = tg.sent.length;
    const id = await submit();
    await new Promise((r) => setTimeout(r, 150));
    expect(tg.sent.length).toBe(before);
    await press(`a:${id}`);
    expect((await q(`SELECT status FROM payments WHERE id = $1`, [id]))[0].status).toBe('pending');
  });

  dbIt('switched on: a new payment reaches the cashier with the facts and two buttons', async () => {
    expect((await call('PATCH', '/telegram', s.M01.access_token, { enabled: true })).json()).toMatchObject({ enabled: true });
    const before = tg.sent.length;
    const id = await submit({ note: 'last 4: 4321', trx_id: 'ABC123XYZ' });
    const msg = await nextSent(before);
    expect(msg.chatId).toBe(String(CHAT));
    expect(msg.html).toContain('ABC123XYZ');
    expect(msg.html).toContain('৫,০০০');
    expect(msg.html).toContain('last 4: 4321');
    expect(msg.keyboard![0]!.map((b) => b.callback_data)).toEqual([`a:${id}`, `r:${id}`]);
  });

  dbIt('Approve confirms the payment through the normal path and says so in the message', async () => {
    const before = tg.sent.length;
    const id = await submit();
    await nextSent(before);
    const res = await press(`a:${id}`);
    expect(res.statusCode).toBe(200);
    const pay = (await q(`SELECT status, confirmed_by FROM payments WHERE id = $1`, [id]))[0];
    expect(pay).toEqual({ status: 'confirmed', confirmed_by: fund.users.M01 });
    expect((await q(`SELECT 1 FROM ledger_entries WHERE ref_type = 'payment' AND ref_id = $1`, [id])).length).toBeGreaterThan(0);
    const audited = await q(`SELECT device_id FROM audit_log WHERE action = 'payment.confirm' AND entity_id = $1`, [id]);
    expect(audited[0].device_id).toBe(TELEGRAM_DEVICE_ID);
    const edit = tg.edits.at(-1)!;
    expect(edit.html).toContain('✅');
    expect(edit.keyboard).toBeUndefined();
    // A second press is harmless: no second ledger entry.
    const count = async () =>
      (await q(`SELECT count(*)::int AS n FROM ledger_entries WHERE ref_type = 'payment' AND ref_id = $1`, [id]))[0].n as number;
    const once = await count();
    await press(`a:${id}`);
    expect(await count()).toBe(once);
    expect(tg.answers.at(-1)).toContain('আগেই');
  });

  dbIt('Reject asks for a reason, then rejects with it so the member can read it', async () => {
    const before = tg.sent.length;
    const id = await submit();
    await nextSent(before);
    await press(`r:${id}`);
    const menu = tg.edits.at(-1)!;
    expect(menu.keyboard!.flat().map((b) => b.callback_data)).toContain(`x:${id}:0`);
    expect((await q(`SELECT status FROM payments WHERE id = $1`, [id]))[0].status).toBe('pending');
    await press(`x:${id}:2`);
    const pay = (await q(`SELECT status, reject_reason FROM payments WHERE id = $1`, [id]))[0];
    expect(pay.status).toBe('rejected');
    expect(pay.reject_reason).toBe('ট্রান্সেকশন আইডি মিলছে না');
    expect((await q(`SELECT 1 FROM notifications WHERE template = 'payment_rejected' AND payload->>'payment_id' = $1`, [id])).length).toBe(1);
  });

  dbIt('a button pressed from any other chat is ignored', async () => {
    const id = await submit();
    await press(`a:${id}`, 31337);
    expect((await q(`SELECT status FROM payments WHERE id = $1`, [id]))[0].status).toBe('pending');
  });

  dbIt('a cashier who lost the role can no longer approve from Telegram', async () => {
    const id = await submit();
    await db!.admin.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [fund.users.M01]);
    try {
      await press(`a:${id}`);
      expect((await q(`SELECT status FROM payments WHERE id = $1`, [id]))[0].status).toBe('pending');
    } finally {
      await db!.admin.query(`UPDATE users SET status = 'active' WHERE id = $1`, [fund.users.M01]);
    }
  });

  dbIt('the test message reaches the linked chat', async () => {
    const before = tg.sent.length;
    expect((await call('POST', '/telegram/test', s.M01.access_token)).statusCode).toBe(204);
    expect(tg.sent[before]!.chatId).toBe(String(CHAT));
  });

  dbIt('disconnecting deletes the stored token and the webhook stops being accepted', async () => {
    const before = tg.deleted();
    expect((await call('DELETE', '/telegram', s.M01.access_token)).statusCode).toBe(204);
    expect(tg.deleted()).toBe(before + 1);
    expect((await q(`SELECT value::text AS v FROM settings WHERE key = 'telegram'`))[0].v).toBe('{}');
    expect((await hook({})).statusCode).toBe(401);
    expect((await call('GET', '/telegram', s.M01.access_token)).json()).toMatchObject({ connected: false });
  });
});
