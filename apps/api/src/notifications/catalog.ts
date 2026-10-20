import { bn } from '@barakah/shared';

/**
 * Notification templates and channel policy (Doc.md section 10).
 *
 * Each template declares:
 *   - channels: which channels to queue at creation time
 *   - pushFallback: when true, a push that is sent but not opened within
 *     `push_to_sms_fallback_hours` gets an SMS via the sms_fallback job
 *   - ignoreSmsOptOut: SMS is sent even when the member disabled SMS
 *   - ignoreQuietHours: can be sent between 21:00 and 08:00 Asia/Dhaka
 *
 * All user-facing text is Bengali. Placeholders are rendered with the key set
 * the caller provides.
 */

export type NotificationTemplate =
  | 'due_reminder'
  | 'fine_notice'
  | 'member_onboarded'
  | 'payment_submitted_ack'
  | 'payment_confirmed'
  | 'payment_rejected'
  | 'vote_opened'
  | 'vote_closing'
  | 'vote_result'
  | 'suspension_notice'
  | 'reinstatement_notice'
  | 'entry_quote'
  | 'settlement_payout'
  | 'constitution_updated'
  | 'cashier_daily_summary'
  | 'pending_payment_alert'
  | 'rent_overdue'
  | 'reconciliation_mismatch'
  | 'backup_failed'
  | 'final_notice'
  | 'meeting_reminder'
  | 'absence_fine'
  | 'charity_year_end'
  | 'zakat_info'
  | 'device_event';

interface TemplateMeta {
  channels: readonly ('push' | 'sms')[];
  pushFallback?: boolean;
  ignoreSmsOptOut?: boolean;
  ignoreQuietHours?: boolean;
  /** Some templates target only privileged roles; the caller filters recipients. */
  roleRecipients?: readonly ('cashier' | 'auditor' | 'member')[];
}

export const TEMPLATE_META: Record<NotificationTemplate, TemplateMeta> = {
  due_reminder: { channels: ['push', 'sms'], pushFallback: true, roleRecipients: ['member'] },
  fine_notice: {
    channels: ['push', 'sms'],
    ignoreSmsOptOut: true,
    roleRecipients: ['member'],
  },
  member_onboarded: { channels: ['push', 'sms'], roleRecipients: ['member'] },
  payment_submitted_ack: { channels: ['push'], roleRecipients: ['member'] },
  payment_confirmed: { channels: ['push', 'sms'], pushFallback: true, roleRecipients: ['member'] },
  payment_rejected: { channels: ['push', 'sms'], roleRecipients: ['member'] },
  vote_opened: { channels: ['push'], roleRecipients: ['member'] },
  vote_closing: { channels: ['push'], roleRecipients: ['member'] },
  vote_result: { channels: ['push'], roleRecipients: ['member'] },
  suspension_notice: {
    channels: ['push', 'sms'],
    ignoreSmsOptOut: true,
    roleRecipients: ['member'],
  },
  reinstatement_notice: {
    channels: ['push', 'sms'],
    roleRecipients: ['member'],
  },
  entry_quote: { channels: ['push', 'sms'], roleRecipients: ['member'] },
  settlement_payout: {
    channels: ['push', 'sms'],
    ignoreSmsOptOut: true,
    roleRecipients: ['member'],
  },
  constitution_updated: { channels: ['push'], roleRecipients: ['member'] },
  cashier_daily_summary: { channels: ['push'], roleRecipients: ['cashier', 'auditor'] },
  pending_payment_alert: { channels: ['push'], roleRecipients: ['cashier'] },
  rent_overdue: { channels: ['push'], roleRecipients: ['cashier'] },
  reconciliation_mismatch: { channels: ['push'], roleRecipients: ['cashier', 'auditor'] },
  backup_failed: {
    channels: ['push', 'sms'],
    ignoreSmsOptOut: true,
    ignoreQuietHours: true,
    roleRecipients: ['cashier', 'auditor'],
  },
  final_notice: {
    channels: ['push', 'sms'],
    ignoreSmsOptOut: true,
    roleRecipients: ['member'],
  },
  meeting_reminder: { channels: ['push'], roleRecipients: ['member'] },
  absence_fine: {
    channels: ['push', 'sms'],
    ignoreSmsOptOut: true,
    roleRecipients: ['member'],
  },
  charity_year_end: { channels: ['push'], roleRecipients: ['cashier', 'auditor'] },
  zakat_info: { channels: ['push'], roleRecipients: ['member'] },
  device_event: { channels: ['push'], roleRecipients: ['auditor'] },
};

function dhakaDateParts(date: Date): { hour: number; date: Date } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const local = new Date(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
  return { hour: Number(get('hour')), date: local };
}

/** Quiet hours are 21:00 to 08:00 Asia/Dhaka (spec 10, assumption 10). */
export function isInQuietHours(date: Date): boolean {
  return dhakaDateParts(date).hour >= 21 || dhakaDateParts(date).hour < 8;
}

/** Round a time up to 08:00 Asia/Dhaka if it falls inside quiet hours for non-exempt templates. */
export function nextAllowedSendTime(date: Date): Date {
  const { hour, date: local } = dhakaDateParts(date);
  if (!isInQuietHours(date)) return date;
  local.setHours(8, 0, 0, 0);
  local.setDate(local.getDate() + (hour >= 21 ? 1 : 0));
  // Asia/Dhaka is UTC+6. Convert the local Dhaka wall time back to a real UTC timestamp.
  return new Date(local.getTime() - 6 * 60 * 60 * 1000);
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? `{${key}}`);
}

export interface RenderResult {
  body: string;
  title?: string;
}

export function renderNotification(
  template: NotificationTemplate,
  vars: Record<string, string | undefined>,
): RenderResult {
  const catalog = (bn as unknown as Record<string, Record<string, string> | undefined>).notif;
  const text = catalog?.[template as string] ?? `{${template as string}}`;
  const definedVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) definedVars[k] = v;
  }
  const body = render(text, definedVars);
  const title: string | undefined =
    template === 'cashier_daily_summary'
      ? ((bn as unknown as { app?: { shortName?: string } }).app?.shortName)
      : undefined;
  return { title, body };
}

/** Build a stable dedupe key from template, member and an optional entity/date label. */
export function dedupeKey(
  template: NotificationTemplate,
  memberId: string,
  label?: string,
): string {
  return label ? `${template}:${memberId}:${label}` : `${template}:${memberId}`;
}
