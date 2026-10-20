import type pg from 'pg';
import { formatBDT, type Clock, type NotificationChannel } from '@barakah/shared';
import type { Logger } from 'pino';
import type { Db } from '../lib/tx';
import type { AuthUser } from '../auth/service';
import {
  TEMPLATE_META,
  type NotificationTemplate,
  renderNotification,
  dedupeKey,
  nextAllowedSendTime,
  isInQuietHours,
} from './catalog';
import * as repo from './repo';
import type { PushSender } from './providers/push';
import type { SmsProvider } from './providers/sms';

/** Money and date helpers for template rendering. */
interface RenderVars {
  name?: string;
  month?: string;
  amount?: string;
  outstanding?: string;
  due_date?: string;
  fine?: string;
  total?: string;
  reason?: string;
  title?: string;
  closes_at?: string;
  result?: string;
  yes?: string;
  no?: string;
  date?: string;
  time?: string;
  count?: string;
  hours?: string;
  period?: string;
  account?: string;
  diff?: string;
  job?: string;
  days?: string;
  shares?: string;
  price?: string;
  expires?: string;
  stream?: string;
  [key: string]: string | undefined;
}

export interface NotificationDeps {
  pool: pg.Pool;
  clock: Clock;
  log: Logger;
  pushSender: PushSender;
  smsProvider: SmsProvider;
}

async function memberSMSOptOut(db: Db, memberId: string): Promise<boolean> {
  const res = await db.query(`SELECT notify_prefs FROM members WHERE id = $1`, [memberId]);
  const prefs = (res.rows[0] as { notify_prefs: { sms?: boolean } } | undefined)?.notify_prefs;
  return prefs?.sms === false;
}

async function memberDevices(db: Db, memberId: string): Promise<{ id: string; token: string }[]> {
  const res = await db.query(
    `SELECT d.id, d.fcm_token
     FROM devices d
     JOIN users u ON u.id = d.user_id
     WHERE u.member_id = $1
       AND d.revoked_at IS NULL
       AND d.push_enabled = true
       AND d.fcm_token IS NOT NULL
       AND d.fcm_token <> ''`,
    [memberId],
  );
  return (res.rows as { id: string; fcm_token: string }[]).map((r) => ({ id: r.id, token: r.fcm_token }));
}

function normalizePayload(vars: RenderVars, clock: Clock): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) out[key] = value;
  }
  out.sent_on = clock.todayDhaka();
  return out;
}

/**
 * Queue notifications for one member according to the template's channel policy.
 * Returns the ids that were actually inserted. If SMS opt-out applies and is not
 * overridden, no SMS row is queued. Quiet hours delay non-exempt notifications.
 */
export async function notifyMember(
  deps: NotificationDeps,
  db: Db,
  input: {
    memberId: string;
    template: NotificationTemplate;
    vars: RenderVars;
    dedupeLabel?: string;
    scheduledFor?: Date;
    actor?: AuthUser;
  },
): Promise<string[]> {
  const meta = TEMPLATE_META[input.template];
  if (!meta) throw new Error(`Unknown notification template ${input.template}`);

  const now = deps.clock.now();
  const rendered = renderNotification(input.template, input.vars);
  const payload = normalizePayload(input.vars, deps.clock);
  payload._body = rendered.body;
  if (rendered.title) payload._title = rendered.title;

  const baseDedupe = dedupeKey(input.template, input.memberId, input.dedupeLabel);
  let scheduledFor = input.scheduledFor ?? now;
  if (!meta.ignoreQuietHours && isInQuietHours(scheduledFor)) {
    scheduledFor = nextAllowedSendTime(scheduledFor);
  }

  const channels: NotificationChannel[] = [];
  const wantsPush = meta.channels.includes('push');
  const wantsSms = meta.channels.includes('sms');
  if (wantsPush) channels.push('push');

  if (wantsSms) {
    const smsOptOut = await memberSMSOptOut(db, input.memberId);
    if (!smsOptOut || meta.ignoreSmsOptOut) channels.push('sms');
  }

  return repo.queueForMember(
    db,
    input.memberId,
    input.template,
    channels,
    payload,
    baseDedupe,
    scheduledFor,
  );
}

interface PushGroup {
  rowId: string;
  body: string;
  title?: string;
  memberId: string;
  tokens: { deviceId: string; token: string }[];
}

/**
 * Send a batch of queued notifications. Called by the worker job.
 * For push, marks the row sent if at least one device accepted; on FCM UNREGISTERED
 * the token is cleared so future sends skip it.
 */
export async function sendQueuedNotifications(deps: NotificationDeps, batchSize = 100): Promise<number> {
  const now = deps.clock.now();
  const rows = await repo.fetchDueNotifications(deps.pool, now, batchSize);
  if (!rows.length) return 0;

  const pushByMember = new Map<string, PushGroup[]>();
  const smsRows: { rowId: string; memberId: string; body: string }[] = [];

  for (const row of rows) {
    const body = (row.payload._body as string) ?? '';
    const title = (row.payload._title as string) ?? undefined;
    if (row.channel === 'push') {
      const devices = await memberDevices(deps.pool, row.member_id);
      if (!devices.length) {
        await repo.markNotificationStatus(deps.pool, row.id, 'skipped', { error: 'no_push_tokens' });
        continue;
      }
      const list = pushByMember.get(row.member_id) ?? [];
      list.push({ rowId: row.id, body, title, memberId: row.member_id, tokens: devices.map((d) => ({ deviceId: d.id, token: d.token })) });
      pushByMember.set(row.member_id, list);
    } else if (row.channel === 'sms') {
      smsRows.push({ rowId: row.id, memberId: row.member_id, body });
    }
  }

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');

    for (const groups of pushByMember.values()) {
      for (const group of groups) {
        const tokens = group.tokens.map((t) => t.token);
        const results = await deps.pushSender.send(tokens, group.title, group.body);
        let anyOk = false;
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          if (r.ok) {
            anyOk = true;
          } else if (r.unregistered) {
            await client.query(
              `UPDATE devices SET fcm_token = NULL, push_enabled = false WHERE fcm_token = $1`,
              [group.tokens[i]!.token],
            );
          }
        }
        await repo.markNotificationStatus(client, group.rowId, anyOk ? 'sent' : 'failed');
      }
    }

    for (const sms of smsRows) {
      const phoneRes = await client.query(`SELECT phone FROM members WHERE id = $1`, [sms.memberId]);
      const phone = (phoneRes.rows[0] as { phone: string } | undefined)?.phone;
      if (!phone) {
        await repo.markNotificationStatus(client, sms.rowId, 'skipped', { error: 'no_phone' });
        continue;
      }
      const result = await deps.smsProvider.send(phone, sms.body);
      await repo.markNotificationStatus(
        client,
        sms.rowId,
        result.ok ? 'sent' : 'failed',
        result.ok ? undefined : { error: result.error },
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return rows.length;
}

/**
 * SMS fallback job: for every push that was sent but not opened within
 * `push_to_sms_fallback_hours`, queue an SMS if the template allows fallback.
 */
export async function runSmsFallback(deps: NotificationDeps): Promise<number> {
  const hours = await getRuleInt(deps, 'push_to_sms_fallback_hours', 6);
  const now = deps.clock.now();
  const before = new Date(now.getTime() - hours * 3600_000);
  const candidates = await repo.selectFallbackCandidates(deps.pool, before);
  let queued = 0;
  for (const row of candidates) {
    const meta = TEMPLATE_META[row.template];
    if (!meta?.pushFallback) continue;
    const payload = { ...row.payload, fallbackFrom: row.id };
    const ids = await repo.queueForMember(
      deps.pool,
      row.member_id,
      row.template,
      ['sms'],
      payload,
      `${dedupeKey(row.template, row.member_id)}:sms-fallback:${row.id}`,
      now,
    );
    queued += ids.length;
  }
  return queued;
}

async function getRuleInt(deps: NotificationDeps, key: string, fallback: number): Promise<number> {
  const res = await deps.pool.query(
    `SELECT value FROM rules WHERE key = $1 AND valid_from <= $2 ORDER BY valid_from DESC LIMIT 1`,
    [key, deps.clock.todayDhaka()],
  );
  const value = (res.rows[0] as { value: string | number } | undefined)?.value;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

/** Helper: format a paisa amount as a Bengali-digit BDT string for SMS/push bodies. */
export function fmtBn(paisa: bigint): string {
  return formatBDT(paisa, { digits: 'bn' });
}

/** Helper: month label in YYYY-MM for templates. */
export function fmtMonth(period: string): string {
  const [y, m] = period.split('-');
  // Bengali month names short list; used only when a real date context is missing.
  const names = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];
  const name = names[Number(m) - 1] ?? m;
  return `${name} ${y}`;
}
