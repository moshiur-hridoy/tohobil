import type { TFunction } from 'i18next';
import { fmtDate } from './dates';
import { formatCount, localDigits } from './format';
import { taka } from './money';

/**
 * How a rule's stored value reads to a person. The rule keys and raw values stay as they are in the
 * database; this only decides how they are shown ("৳৫০০" instead of 50000, "হ্যাঁ" instead of true).
 */
export type RuleKind =
  | 'paisa'
  | 'dayOfMonth'
  | 'days'
  | 'hours'
  | 'months'
  | 'percent'
  | 'times'
  | 'count'
  | 'bool'
  | 'date'
  | 'time'
  | 'choice';

const KINDS: Record<string, RuleKind> = {
  monthly_due_per_share_paisa: 'paisa',
  start_boost_per_share_paisa: 'paisa',
  fine_per_share_paisa: 'paisa',
  absence_fine_paisa: 'paisa',
  exit_fee_paisa: 'paisa',
  feasibility_threshold_paisa: 'paisa',
  big_financial_threshold_paisa: 'paisa',
  due_day: 'dayOfMonth',
  dues_generation_day: 'dayOfMonth',
  reminder_start_day: 'dayOfMonth',
  reminder_end_day: 'dayOfMonth',
  fine_day: 'dayOfMonth',
  meeting_window_start_day: 'dayOfMonth',
  meeting_window_end_day: 'dayOfMonth',
  final_notice_days: 'days',
  proposal_execution_window_days: 'days',
  rent_grace_days: 'days',
  valuation_max_age_days: 'days',
  inactive_wait_days_after_letter: 'days',
  push_to_sms_fallback_hours: 'hours',
  default_vote_duration_hours: 'hours',
  payment_pending_alert_hours: 'hours',
  warning_after_months: 'months',
  suspension_after_consecutive_unpaid_months: 'months',
  inactive_after_months_no_contact: 'months',
  early_exit_service_charge_percent: 'percent',
  absence_fine_after_consecutive: 'times',
  max_devices_per_member: 'count',
  max_devices_privileged: 'count',
  auto_suspend: 'bool',
  'compliance.interest_free': 'bool',
  reinstatement_charges_fines: 'bool',
  fund_term_start: 'date',
  fund_term_end: 'date',
  reminder_time: 'time',
  allocation_order: 'choice',
};

export const ruleKind = (key: string): RuleKind | undefined => KINDS[key];

// i18next treats "." as nesting, so "compliance.interest_free" is looked up as "compliance_interest_free".
const i18nKey = (key: string) => key.replace(/\./g, '_');

/** "প্রতি শেয়ারে মাসিক চাঁদা"; an unknown key falls back to itself. */
export const ruleName = (t: TFunction, key: string): string =>
  t(`rulesPage.names.${i18nKey(key)}`, { defaultValue: key });

/** One plain sentence on what the rule does, or "" when there is none. */
export const ruleHint = (t: TFunction, key: string): string =>
  t(`rulesPage.hints.${i18nKey(key)}`, { defaultValue: '' });

/** The value as a person reads it. Anything unexpected is shown raw rather than guessed at. */
export function ruleValueText(t: TFunction, key: string, value: unknown): string {
  const kind = KINDS[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
  switch (kind) {
    case 'paisa':
      if (n !== null) return taka(String(value));
      break;
    case 'dayOfMonth':
      if (n !== null) return t('rulesPage.units.dayOfMonth', { n: formatCount(n) });
      break;
    case 'days':
    case 'hours':
    case 'months':
    case 'times':
      if (n !== null) return t(`rulesPage.units.${kind}`, { n: formatCount(n) });
      break;
    case 'percent':
      if (n !== null) return `${formatCount(n)}%`;
      break;
    case 'count':
      if (n !== null) return formatCount(n);
      break;
    case 'bool':
      if (typeof value === 'boolean') return value ? t('rulesPage.units.yes') : t('rulesPage.units.no');
      break;
    case 'date':
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return fmtDate(value);
      break;
    case 'time':
      if (typeof value === 'string') return localDigits(value);
      break;
    case 'choice':
      if (typeof value === 'string') return t(`rulesPage.choices.${value}`, { defaultValue: value });
      break;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The sections of the rules page, in reading order. A rule not listed here goes under "other". */
export const RULE_GROUPS: ReadonlyArray<{ id: string; icon: string; keys: readonly string[] }> = [
  {
    id: 'dues',
    icon: 'M3 7h18v12H3zM3 11h18M16 15h2',
    keys: ['monthly_due_per_share_paisa', 'start_boost_per_share_paisa', 'dues_generation_day', 'due_day', 'reminder_start_day', 'reminder_end_day', 'reminder_time', 'allocation_order'],
  },
  {
    id: 'fines',
    icon: 'M12 3l10 18H2zM12 10v5M12 18v.01',
    keys: ['fine_day', 'fine_per_share_paisa', 'warning_after_months', 'suspension_after_consecutive_unpaid_months', 'final_notice_days', 'auto_suspend', 'reinstatement_charges_fines'],
  },
  {
    id: 'meetings',
    icon: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 5a3.5 3.5 0 0 1 0 6.5M18 14.5c2 .7 3.5 2.4 3.5 5.5',
    keys: ['meeting_window_start_day', 'meeting_window_end_day', 'absence_fine_after_consecutive', 'absence_fine_paisa'],
  },
  {
    id: 'votes',
    icon: 'M4 4h16v16H4zM9 12l2 2 4-4',
    keys: ['default_vote_duration_hours', 'proposal_execution_window_days', 'big_financial_threshold_paisa'],
  },
  {
    id: 'investment',
    icon: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    keys: ['compliance.interest_free', 'feasibility_threshold_paisa', 'valuation_max_age_days', 'rent_grace_days'],
  },
  {
    id: 'membership',
    icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
    keys: ['exit_fee_paisa', 'early_exit_service_charge_percent', 'inactive_after_months_no_contact', 'inactive_wait_days_after_letter', 'fund_term_start', 'fund_term_end'],
  },
  {
    id: 'system',
    icon: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
    keys: ['push_to_sms_fallback_hours', 'payment_pending_alert_hours', 'max_devices_per_member', 'max_devices_privileged'],
  },
];
