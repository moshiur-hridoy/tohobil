import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Logger } from 'pino';
import {
  bn,
  formatBDT,
  paymentRejectSchema,
  type Clock,
  type TelegramLinkCode,
  type TelegramStatus,
} from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { decryptSecret, encryptSecret, hashToken, safeEqualHex } from '../lib/crypto';
import { audit } from '../lib/audit';
import { AppError, badRequest } from '../lib/errors';
import { inTransaction, type Db } from '../lib/tx';
import { confirmPayment, rejectPayment, type PaymentDeps } from '../payments/service';
import { TelegramError, type InlineKeyboard, type TelegramApi } from './client';

/** The settings row that holds everything about the bot. It is not in the public settings whitelist. */
const SETTINGS_KEY = 'telegram';
const LINK_MINUTES = 10;
const WEBHOOK_PATH = '/api/v1/telegram/webhook';

/**
 * Stands in for a device on audit and ledger rows written from a Telegram button, so the auditor can
 * tell them from dashboard actions. It is not a row in `devices` (nothing references it).
 */
export const TELEGRAM_DEVICE_ID = '00000000-0000-0000-0000-000000007e1e';

const REJECT_REASONS = ['not_received', 'amount_mismatch', 'trx_mismatch'] as const;
type RejectReason = (typeof REJECT_REASONS)[number];

interface Config {
  /** AES-256-GCM, same key as the TOTP secrets. */
  token_enc: string;
  bot_username: string;
  /** Peppered hash of the secret Telegram sends back in a header on every webhook call. */
  secret_hash: string;
  chat_id: string | null;
  /** The cashier whose Telegram this is: the actor of every approval made from it. */
  user_id: string | null;
  enabled: boolean;
  link: { code_hash: string; user_id: string; expires_at: string } | null;
}

export interface TelegramDeps {
  pool: pg.Pool;
  clock: Clock;
  log: Logger;
  api: TelegramApi;
  payments: PaymentDeps;
  encryptionKey: string;
  pepper: string;
  publicOrigin: string;
}

interface Ctx {
  ip?: string | undefined;
}

interface Update {
  message?: { text?: string; chat: { id: number; type: string } };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const text = (path: string, vars: Record<string, string> = {}): string => {
  let node: unknown = (bn as unknown as Record<string, unknown>).tg;
  for (const part of path.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
  const raw = typeof node === 'string' ? node : path;
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? `{${k}}`);
};

const dhakaTime = (d: Date): string =>
  new Intl.DateTimeFormat('bn-BD', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);

export function createTelegramService(deps: TelegramDeps) {
  const { pool, api } = deps;

  async function load(db: Db, lock = false): Promise<Config | null> {
    const res = await db.query(`SELECT value FROM settings WHERE key = $1${lock ? ' FOR UPDATE' : ''}`, [
      SETTINGS_KEY,
    ]);
    const value = (res.rows[0] as { value: Partial<Config> } | undefined)?.value;
    // A disconnected bot leaves an empty object behind (the app role may not DELETE settings rows).
    return value?.token_enc ? (value as Config) : null;
  }

  async function save(db: Db, cfg: Config, userId: string | null): Promise<void> {
    await db.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [SETTINGS_KEY, JSON.stringify(cfg), userId],
    );
  }

  /** Read-modify-write under a row lock, so two button presses or two settings saves cannot interleave. */
  async function update<T>(fn: (db: pg.PoolClient, cfg: Config | null) => Promise<T>): Promise<T> {
    return inTransaction(pool, async (db) => {
      // The row may not exist yet; make sure there is something to lock.
      const cfg = await load(db, true);
      return fn(db, cfg);
    });
  }

  const token = (cfg: Config): string => decryptSecret(cfg.token_enc, deps.encryptionKey);

  function toStatus(cfg: Config | null): TelegramStatus {
    return {
      connected: !!cfg,
      bot_username: cfg?.bot_username ?? null,
      linked: !!cfg?.chat_id,
      enabled: !!cfg?.enabled && !!cfg.chat_id,
    };
  }

  // ---- settings page ----------------------------------------------------------------------

  async function status(): Promise<TelegramStatus> {
    return toStatus(await load(pool));
  }

  async function connect(user: AuthUser, botToken: string, ctx: Ctx): Promise<TelegramStatus> {
    let username: string;
    try {
      username = (await api.getMe(botToken)).username;
    } catch {
      throw badRequest('telegram.invalid_token', 'Telegram did not accept this token');
    }
    const secret = randomBytes(32).toString('hex');
    // Replacing the bot: stop the old one from sending updates here.
    const old = await load(pool);
    if (old) await api.deleteWebhook(token(old)).catch(() => undefined);
    try {
      await api.setWebhook(botToken, `${deps.publicOrigin.replace(/\/$/, '')}${WEBHOOK_PATH}`, secret);
    } catch (err) {
      deps.log.warn({ reason: err instanceof TelegramError ? err.description : 'unknown' }, 'telegram setWebhook failed');
      throw badRequest('telegram.refused', 'Telegram refused the webhook address');
    }
    const cfg: Config = {
      token_enc: encryptSecret(botToken, deps.encryptionKey),
      bot_username: username,
      secret_hash: hashToken(secret, deps.pepper),
      chat_id: null,
      user_id: null,
      enabled: false,
      link: null,
    };
    await update(async (db, before) => {
      await save(db, cfg, user.id);
      // Never the token itself.
      await audit(db, {
        actor: user.id,
        action: 'telegram.connect',
        entityType: 'settings',
        entityId: SETTINGS_KEY,
        before: before ? { bot_username: before.bot_username, linked: !!before.chat_id } : null,
        after: { bot_username: username },
        ip: ctx.ip,
        deviceId: user.device_id,
      });
    });
    return toStatus(cfg);
  }

  async function createLinkCode(user: AuthUser, ctx: Ctx): Promise<TelegramLinkCode> {
    const code = randomBytes(12).toString('base64url');
    const expires = new Date(deps.clock.now().getTime() + LINK_MINUTES * 60_000);
    const username = await update(async (db, cfg) => {
      if (!cfg) throw badRequest('telegram.not_connected', 'Connect the bot first');
      await save(
        db,
        { ...cfg, link: { code_hash: hashToken(code, deps.pepper), user_id: user.id, expires_at: expires.toISOString() } },
        user.id,
      );
      await audit(db, {
        actor: user.id,
        action: 'telegram.link_code',
        entityType: 'settings',
        entityId: SETTINGS_KEY,
        ip: ctx.ip,
        deviceId: user.device_id,
      });
      return cfg.bot_username;
    });
    return { code, link: `https://t.me/${username}?start=${code}`, expires_at: expires.toISOString() };
  }

  async function setEnabled(user: AuthUser, enabled: boolean, ctx: Ctx): Promise<TelegramStatus> {
    return update(async (db, cfg) => {
      if (!cfg) throw badRequest('telegram.not_connected', 'Connect the bot first');
      if (enabled && !cfg.chat_id) throw badRequest('telegram.not_linked', 'Identify your Telegram first');
      const next = { ...cfg, enabled };
      await save(db, next, user.id);
      await audit(db, {
        actor: user.id,
        action: 'telegram.enabled',
        entityType: 'settings',
        entityId: SETTINGS_KEY,
        before: { enabled: cfg.enabled },
        after: { enabled },
        ip: ctx.ip,
        deviceId: user.device_id,
      });
      return toStatus(next);
    });
  }

  async function sendTest(): Promise<void> {
    const cfg = await load(pool);
    if (!cfg) throw badRequest('telegram.not_connected', 'Connect the bot first');
    if (!cfg.chat_id) throw badRequest('telegram.not_linked', 'Identify your Telegram first');
    try {
      await api.sendMessage(token(cfg), cfg.chat_id, text('test'));
    } catch {
      throw badRequest('telegram.refused', 'Telegram refused the message');
    }
  }

  async function disconnect(user: AuthUser, ctx: Ctx): Promise<void> {
    const cfg = await load(pool);
    if (!cfg) return;
    // Best effort: with the token gone the webhook is useless anyway (its secret is deleted too).
    await api.deleteWebhook(token(cfg)).catch(() => undefined);
    await update(async (db) => {
      await db.query(`UPDATE settings SET value = '{}'::jsonb, updated_by = $2, updated_at = now() WHERE key = $1`, [
        SETTINGS_KEY,
        user.id,
      ]);
      await audit(db, {
        actor: user.id,
        action: 'telegram.disconnect',
        entityType: 'settings',
        entityId: SETTINGS_KEY,
        before: { bot_username: cfg.bot_username },
        ip: ctx.ip,
        deviceId: user.device_id,
      });
    });
  }

  // ---- the message about a payment ---------------------------------------------------------

  interface PaymentView {
    id: string;
    status: string;
    html: string;
  }

  async function paymentView(paymentId: string): Promise<PaymentView | null> {
    const res = await pool.query(
      `SELECT p.id, p.status, p.amount_paisa, p.method, p.purpose, p.trx_id, p.paid_at, p.for_periods,
              p.note, p.proof_file_id, m.code AS member_code, m.full_name, m.id AS member_id
       FROM payments p JOIN members m ON m.id = p.member_id WHERE p.id = $1`,
      [paymentId],
    );
    const p = res.rows[0] as
      | {
          id: string;
          status: string;
          amount_paisa: unknown;
          method: string;
          purpose: string;
          trx_id: string | null;
          paid_at: Date;
          for_periods: string[] | null;
          note: string | null;
          proof_file_id: string | null;
          member_code: string;
          full_name: string;
          member_id: string;
        }
      | undefined;
    if (!p) return null;
    const methodName = (bn as unknown as { payment: { methods: Record<string, string> } }).payment.methods[p.method] ?? p.method;
    const lines = [
      `<b>${text('title')}</b>`,
      '',
      `${text('member')}: <b>${esc(p.full_name)}</b> (${esc(p.member_code)})`,
      `${text('amount')}: <b>৳${formatBDT(BigInt(String(p.amount_paisa)))}</b>`,
      `${text('method')}: ${esc(methodName)}`,
      `${text('purpose')}: ${esc(text(`purposes.${p.purpose}`))}`,
    ];
    if (p.for_periods?.length) lines.push(`${text('periods')}: ${esc(p.for_periods.join(', '))}`);
    if (p.trx_id) lines.push(`${text('trx')}: <code>${esc(p.trx_id)}</code>`);
    if (p.note) lines.push(`${text('note')}: ${esc(p.note)}`);
    lines.push(`${text('paidAt')}: ${dhakaTime(new Date(p.paid_at))}`);
    if (p.proof_file_id) lines.push(text('proof'));
    return { id: p.id, status: p.status, html: lines.join('\n') };
  }

  const mainKeyboard = (id: string): InlineKeyboard => [
    [
      { text: text('approve'), callback_data: `a:${id}` },
      { text: text('reject'), callback_data: `r:${id}` },
    ],
  ];

  /** After a payment is submitted. Never throws: a Telegram outage must not fail the member's payment. */
  async function notifyPending(paymentId: string): Promise<void> {
    try {
      const cfg = await load(pool);
      if (!cfg?.enabled || !cfg.chat_id) return;
      const view = await paymentView(paymentId);
      if (!view || view.status !== 'pending') return;
      let html = view.html;
      // The cashier approving their own payment is allowed, but they should see that it is theirs.
      const own = await pool.query(
        `SELECT 1 FROM payments p JOIN users u ON u.member_id = p.member_id WHERE p.id = $1 AND u.id = $2`,
        [paymentId, cfg.user_id],
      );
      if ((own.rowCount ?? 0) > 0) html += `\n\n${text('self')}`;
      await api.sendMessage(token(cfg), cfg.chat_id, html, mainKeyboard(paymentId));
    } catch (err) {
      deps.log.warn({ err: err instanceof TelegramError ? err.description : String(err), paymentId }, 'telegram notify failed');
    }
  }

  // ---- the webhook -------------------------------------------------------------------------

  /** True when the header is the secret we gave Telegram for the connected bot. */
  async function verifySecret(header: string | undefined): Promise<boolean> {
    const cfg = await load(pool);
    if (!cfg || !header) return false;
    const given = hashToken(header, deps.pepper);
    return safeEqualHex(given, cfg.secret_hash);
  }

  async function loadActor(userId: string | null): Promise<AuthUser | null> {
    if (!userId) return null;
    const res = await pool.query(
      `SELECT u.id, u.member_id, u.roles, u.status AS user_status, u.totp_enabled,
              m.code AS member_code, m.full_name, m.status AS member_status
       FROM users u JOIN members m ON m.id = u.member_id WHERE u.id = $1`,
      [userId],
    );
    const r = res.rows[0] as
      | {
          id: string;
          member_id: string;
          roles: string[];
          user_status: AuthUser['user_status'];
          totp_enabled: boolean;
          member_code: string;
          full_name: string;
          member_status: string;
        }
      | undefined;
    // A cashier who lost the role (or was disabled) can no longer approve from Telegram.
    if (!r || r.user_status !== 'active' || !r.roles.includes('cashier')) return null;
    return {
      id: r.id,
      member_id: r.member_id,
      member_code: r.member_code,
      full_name: r.full_name,
      roles: r.roles,
      user_status: r.user_status,
      member_status: r.member_status,
      totp_enabled: r.totp_enabled,
      device_id: TELEGRAM_DEVICE_ID,
      step_up_at: null,
    };
  }

  async function handleStart(cfg: Config, chatId: string, payload: string): Promise<void> {
    const tk = token(cfg);
    const link = cfg.link;
    const valid =
      !!link &&
      payload !== '' &&
      new Date(link.expires_at).getTime() > deps.clock.now().getTime() &&
      safeEqualHex(hashToken(payload, deps.pepper), link.code_hash);
    if (!valid) {
      await api.sendMessage(tk, chatId, text(cfg.chat_id === chatId ? 'linked' : payload ? 'badCode' : 'notYours'));
      return;
    }
    await update(async (db, fresh) => {
      if (!fresh?.link) return;
      await save(db, { ...fresh, chat_id: chatId, user_id: fresh.link.user_id, link: null }, fresh.link.user_id);
      await audit(db, {
        actor: fresh.link.user_id,
        action: 'telegram.linked',
        entityType: 'settings',
        entityId: SETTINGS_KEY,
        deviceId: TELEGRAM_DEVICE_ID,
      });
    });
    await api.sendMessage(tk, chatId, text('linked'));
  }

  async function finish(cfg: Config, chatId: string, messageId: number, paymentId: string, extra: string): Promise<void> {
    const view = await paymentView(paymentId);
    const html = `${view?.html ?? ''}\n\n${extra}`.trim();
    await api.editMessage(token(cfg), chatId, messageId, html);
  }

  async function handleCallback(cfg: Config, cb: NonNullable<Update['callback_query']>): Promise<void> {
    const tk = token(cfg);
    const chatId = cfg.chat_id;
    const msg = cb.message;
    // Only the linked chat, and only a button on a message in that same chat.
    if (!chatId || String(cb.from.id) !== chatId || !msg || String(msg.chat.id) !== chatId) {
      await api.answerCallback(tk, cb.id, text('noRole'));
      return;
    }
    if (!cfg.enabled) {
      await api.answerCallback(tk, cb.id, text('off'));
      return;
    }
    const [action, paymentId, arg] = (cb.data ?? '').split(':');
    if (!paymentId || !/^[0-9a-f-]{36}$/.test(paymentId)) {
      await api.answerCallback(tk, cb.id);
      return;
    }
    const actor = await loadActor(cfg.user_id);
    if (!actor) {
      await api.answerCallback(tk, cb.id, text('noRole'));
      return;
    }
    const view = await paymentView(paymentId);
    if (!view) {
      await api.answerCallback(tk, cb.id);
      return;
    }
    if (view.status !== 'pending') {
      const label = (bn as unknown as { payment: { status: Record<string, string> } }).payment.status[view.status] ?? view.status;
      await api.answerCallback(tk, cb.id, text('alreadyDone', { status: label }));
      await api.editMessage(tk, chatId, msg.message_id, `${view.html}\n\n${text('alreadyDone', { status: label })}`);
      return;
    }

    if (action === 'r') {
      await api.answerCallback(tk, cb.id);
      const rows: InlineKeyboard = REJECT_REASONS.map((k) => [
        { text: text(`reasons.${k}`), callback_data: `x:${paymentId}:${REJECT_REASONS.indexOf(k)}` },
      ]);
      rows.push([{ text: text('back'), callback_data: `b:${paymentId}` }]);
      await api.editMessage(tk, chatId, msg.message_id, `${view.html}\n\n${text('rejectWhy')}`, rows);
      return;
    }
    if (action === 'b') {
      await api.answerCallback(tk, cb.id);
      await api.editMessage(tk, chatId, msg.message_id, view.html, mainKeyboard(paymentId));
      return;
    }

    const now = dhakaTime(deps.clock.now());
    try {
      if (action === 'a') {
        await confirmPayment(deps.payments, actor, paymentId, {}, {});
        await api.answerCallback(tk, cb.id, text('confirmed', { time: now }));
        await finish(cfg, chatId, msg.message_id, paymentId, text('confirmed', { time: now }));
      } else if (action === 'x') {
        const key: RejectReason | undefined = REJECT_REASONS[Number(arg)];
        if (!key) {
          await api.answerCallback(tk, cb.id);
          return;
        }
        const reason = paymentRejectSchema.parse({ reason: text(`reasons.${key}`) }).reason;
        await rejectPayment(deps.payments, actor, paymentId, { reason }, {});
        await api.answerCallback(tk, cb.id, text('rejected', { time: now, reason }));
        await finish(cfg, chatId, msg.message_id, paymentId, text('rejected', { time: now, reason }));
      } else {
        await api.answerCallback(tk, cb.id);
      }
    } catch (err) {
      const reason =
        err instanceof AppError
          ? (((bn as unknown as { errors: Record<string, Record<string, string>> }).errors[err.code.split('.')[0] ?? '']?.[
              err.code.split('.')[1] ?? ''
            ]) ?? err.message)
          : 'অজানা সমস্যা';
      deps.log.warn({ code: err instanceof AppError ? err.code : 'unknown', paymentId }, 'telegram action failed');
      await api.answerCallback(tk, cb.id, text('failed', { reason }));
      await finish(cfg, chatId, msg.message_id, paymentId, text('failed', { reason }));
    }
  }

  /** Called by the route after the secret header checked out. Errors are logged, never returned to Telegram. */
  async function handleUpdate(upd: Update): Promise<void> {
    const cfg = await load(pool);
    if (!cfg) return;
    try {
      if (upd.callback_query) {
        await handleCallback(cfg, upd.callback_query);
      } else if (upd.message && upd.message.chat.type === 'private') {
        const chatId = String(upd.message.chat.id);
        const m = /^\/start(?:\s+(\S+))?/.exec(upd.message.text ?? '');
        if (m) await handleStart(cfg, chatId, m[1] ?? '');
        else if (chatId !== cfg.chat_id) await api.sendMessage(token(cfg), chatId, text('notYours'));
      }
    } catch (err) {
      deps.log.warn({ err: err instanceof TelegramError ? err.description : String(err) }, 'telegram update failed');
    }
  }

  return { status, connect, createLinkCode, setEnabled, sendTest, disconnect, notifyPending, verifySecret, handleUpdate };
}

export type TelegramService = ReturnType<typeof createTelegramService>;
