import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { COMPLIANCE_CHECKLIST_FIELDS, type ProposalType } from '@barakah/shared';
import { api, ApiError } from '../../lib/api';
import { fmtDate } from '../../lib/dates';
import { parseAmountInput, taka } from '../../lib/money';
import type { AssetRow, MemberRow, PartnerRow } from '../../lib/types';

/**
 * What each kind of proposal asks for, in the order it is asked. The keys are the payload keys the
 * API validates (packages/shared proposal schemas), so a field added there is added here.
 */
type Kind =
  | 'text' | 'textarea' | 'money' | 'int' | 'decimal' | 'date' | 'json'
  | 'member' | 'asset' | 'partner' | 'file' | { select: readonly string[] };

export interface Field {
  key: string;
  kind: Kind;
  optional?: boolean;
}

const ACCOUNTS = ['CASH', 'BANK', 'BKASH', 'NAGAD'] as const;
const SOURCE = { select: ACCOUNTS } as const;

export const PROPOSAL_FORMS: Partial<Record<ProposalType, Field[]>> = {
  general: [{ key: 'text', kind: 'textarea' }],
  dissolution: [{ key: 'text', kind: 'textarea' }],
  land_selection: [{ key: 'text', kind: 'textarea' }],
  project_closure: [{ key: 'text', kind: 'textarea' }],
  contribution_change: [
    { key: 'new_amount_paisa', kind: 'money' },
    { key: 'reason', kind: 'textarea' },
    { key: 'effective_from', kind: 'date' },
  ],
  expense: [
    { key: 'max_amount_paisa', kind: 'money' },
    { key: 'account', kind: { select: ['MAINTENANCE', 'OTHER_EXPENSE'] } },
    { key: 'payee', kind: 'text' },
    { key: 'purpose', kind: 'text' },
  ],
  charity_donation: [
    { key: 'recipient', kind: 'text' },
    { key: 'amount_paisa', kind: 'money' },
    { key: 'purpose', kind: 'text' },
  ],
  investment_purchase: [
    { key: 'kind', kind: { select: ['gold', 'land', 'house', 'other'] } },
    { key: 'name', kind: 'text' },
    { key: 'max_amount_paisa', kind: 'money' },
    { key: 'quantity', kind: 'decimal', optional: true },
    { key: 'unit', kind: { select: ['vori', 'gram'] }, optional: true },
    { key: 'source_account', kind: SOURCE },
    { key: 'notes', kind: 'text', optional: true },
    { key: 'partner_id', kind: 'partner', optional: true },
    { key: 'feasibility_file_id', kind: 'file', optional: true },
  ],
  asset_sale: [
    { key: 'asset_id', kind: 'asset' },
    { key: 'min_price_paisa', kind: 'money' },
  ],
  valuation_update: [
    { key: 'asset_id', kind: 'asset' },
    { key: 'value_paisa', kind: 'money' },
    { key: 'as_of', kind: 'date' },
    { key: 'basis', kind: 'text', optional: true },
  ],
  distribution: [
    { key: 'total_paisa', kind: 'money' },
    { key: 'source_account', kind: SOURCE },
  ],
  asset_cost_levy: [
    { key: 'total_paisa', kind: 'money' },
    { key: 'asset_id', kind: 'asset', optional: true },
    { key: 'due_date', kind: 'date' },
    { key: 'reason', kind: 'textarea' },
  ],
  special_contribution: [
    { key: 'per_share_paisa', kind: 'money' },
    { key: 'due_date', kind: 'date' },
    { key: 'reason', kind: 'textarea' },
  ],
  member_qard: [
    { key: 'direction', kind: { select: ['receive', 'repay'] } },
    { key: 'lender_member_id', kind: 'member' },
    { key: 'amount_paisa', kind: 'money' },
    { key: 'account', kind: SOURCE },
  ],
  financing_arrangement: [
    { key: 'asset_id', kind: 'asset' },
    { key: 'counterparty', kind: 'text' },
    { key: 'description', kind: 'textarea' },
    { key: 'total_paisa', kind: 'money' },
  ],
  wind_up: [{ key: 'distribution_plan', kind: 'textarea' }],
  role_change: [
    { key: 'role', kind: { select: ['cashier', 'auditor'] } },
    { key: 'member_id', kind: 'member' },
  ],
  new_member: [
    { key: 'name', kind: 'text' },
    { key: 'phone', kind: 'text' },
    { key: 'shares', kind: 'int' },
    { key: 'note', kind: 'text', optional: true },
  ],
  suspension: [
    { key: 'member_id', kind: 'member' },
    { key: 'reason', kind: 'textarea' },
  ],
  rule_change: [
    { key: 'key', kind: 'text' },
    { key: 'value', kind: 'json' },
    { key: 'valid_from', kind: 'date' },
  ],
  constitution_amendment: [
    { key: 'version', kind: 'text' },
    { key: 'file_id', kind: 'file' },
    { key: 'effective_from', kind: 'date' },
    { key: 'summary', kind: 'textarea' },
  ],
  member_deceased: [
    { key: 'member_id', kind: 'member' },
    { key: 'nominee_name', kind: 'text' },
    { key: 'nominee_relation', kind: 'text', optional: true },
  ],
};

/** Types created elsewhere (member screens) or that need no form of their own. */
export const FORM_TYPES = Object.keys(PROPOSAL_FORMS) as ProposalType[];

export interface FormState {
  values: Record<string, string>;
  files: Record<string, File | null>;
  compliance: Record<string, boolean>;
  instalments: Array<{ due_on: string; amount: string }>;
  windUpAssets: string[];
}

export const emptyForm = (): FormState => ({
  values: {},
  files: {},
  compliance: Object.fromEntries(COMPLIANCE_CHECKLIST_FIELDS.map((f) => [f, false])),
  instalments: [{ due_on: '', amount: '' }],
  windUpAssets: [],
});

function parseJsonOrString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Turns what was typed into the API payload; throws a 400 `ApiError` naming what is missing. */
export async function buildPayload(type: ProposalType, form: FormState): Promise<{ payload: Record<string, unknown>; subject?: string }> {
  const bad = (what: string) => new ApiError(400, 'request.invalid', what);
  const out: Record<string, unknown> = {};
  for (const f of PROPOSAL_FORMS[type] ?? []) {
    const raw = (form.values[f.key] ?? '').trim();
    const file = form.files[f.key];
    if (f.kind === 'file') {
      if (!file) {
        if (f.optional) continue;
        throw bad(f.key);
      }
      const body = new FormData();
      body.append('file', file);
      out[f.key] = (await api<{ id: string }>('/files', { method: 'POST', body })).id;
      continue;
    }
    if (raw === '') {
      if (f.optional) continue;
      throw bad(f.key);
    }
    if (f.kind === 'money') {
      const paisa = parseAmountInput(raw);
      if (!paisa) throw bad(f.key);
      out[f.key] = paisa;
    } else if (f.kind === 'int') out[f.key] = Number.parseInt(raw, 10);
    else if (f.kind === 'decimal') out[f.key] = Number(raw);
    else if (f.kind === 'json') out[f.key] = parseJsonOrString(raw);
    else out[f.key] = raw;
  }

  if (type === 'investment_purchase') out.compliance = form.compliance;
  if (type === 'valuation_update') {
    const { asset_id, value_paisa, as_of, basis } = out;
    return { payload: { items: [{ asset_id, value_paisa, as_of, ...(basis ? { basis } : {}) }] } };
  }
  if (type === 'financing_arrangement') {
    const rows = form.instalments.filter((i) => i.due_on && i.amount.trim());
    if (rows.length === 0) throw bad('instalments');
    out.instalments = rows.map((i) => {
      const paisa = parseAmountInput(i.amount);
      if (!paisa) throw bad('instalments');
      return { due_on: i.due_on, amount_paisa: paisa };
    });
  }
  if (type === 'wind_up') out.asset_ids_to_sell = form.windUpAssets;
  const subject = type === 'suspension' || type === 'member_deceased' ? (out.member_id as string) : undefined;
  return { payload: out, ...(subject ? { subject } : {}) };
}

const inputClass = 'field mt-1 w-full';

/** The fields for one proposal type. Pure input: the owner of `form` decides when to submit. */
export function ProposalFields({ type, form, onChange }: { type: ProposalType; form: FormState; onChange: (next: FormState) => void }) {
  const { t } = useTranslation();
  const fields = PROPOSAL_FORMS[type] ?? [];
  const needsMembers = fields.some((f) => f.kind === 'member');
  const needsAssets = fields.some((f) => f.kind === 'asset') || type === 'wind_up';
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members'), enabled: needsMembers });
  const assets = useQuery({ queryKey: ['assets-admin'], queryFn: () => api<{ items: AssetRow[] }>('/assets?limit=100'), enabled: needsAssets });

  const needsPartners = fields.some((f) => f.kind === 'partner');
  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<{ items: PartnerRow[] }>('/partners'), enabled: needsPartners });

  const set = (key: string, value: string) => onChange({ ...form, values: { ...form.values, [key]: value } });
  const label = (key: string, optional?: boolean) => `${t(`proposalFields.${key}`)}${optional ? ` (${t('proposalFields.optional')})` : ''}`;
  const activeAssets = assets.data?.items.filter((a) => a.status !== 'sold') ?? [];

  return (
    <>
      {fields.map((f) => (
        <label key={f.key} className="block text-sm text-muted">
          {label(f.key, f.optional)}
          {f.kind === 'textarea' ? (
            <textarea className="field mt-1 min-h-20 w-full" value={form.values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
          ) : f.kind === 'file' ? (
            <input type="file" accept="image/*,application/pdf" className="mt-1 block" onChange={(e) => onChange({ ...form, files: { ...form.files, [f.key]: e.target.files?.[0] ?? null } })} />
          ) : f.kind === 'member' ? (
            <select className={inputClass} value={form.values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">{t('membersAdmin.chooseMember')}</option>
              {members.data?.items.map((m) => <option key={m.id} value={m.id}>{m.code} {m.full_name}</option>)}
            </select>
          ) : f.kind === 'asset' ? (
            <select className={inputClass} value={form.values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">{t('proposalFields.chooseAsset')}</option>
              {activeAssets.map((a) => <option key={a.id} value={a.id}>{[a.name, a.acquired_on ? fmtDate(a.acquired_on) : null, taka(a.cost_paisa)].filter(Boolean).join(' · ')} ({t(`assetsAdmin.status.${a.status}`)})</option>)}
            </select>
          ) : f.kind === 'partner' ? (
            <select className={inputClass} value={form.values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">—</option>
              {partners.data?.items.filter((p) => !form.values['kind'] || p.kind === form.values['kind']).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : typeof f.kind === 'object' ? (
            <select className={inputClass} value={form.values[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)}>
              <option value="">—</option>
              {f.kind.select.map((o) => <option key={o} value={o}>{t(`proposalOptions.${o}`, { defaultValue: o })}</option>)}
            </select>
          ) : (
            <input
              className={inputClass}
              type={f.kind === 'date' ? 'date' : 'text'}
              inputMode={f.kind === 'money' || f.kind === 'decimal' || f.kind === 'int' ? 'decimal' : undefined}
              value={form.values[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
            />
          )}
        </label>
      ))}

      {type === 'investment_purchase' && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('proposalsPage.compliance')}</legend>
          {COMPLIANCE_CHECKLIST_FIELDS.map((c) => (
            <label key={c} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" checked={form.compliance[c] === true} onChange={(e) => onChange({ ...form, compliance: { ...form.compliance, [c]: e.target.checked } })} />
              {t(`compliance.${c}`)}
            </label>
          ))}
        </fieldset>
      )}

      {type === 'financing_arrangement' && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('proposalFields.instalments')}</legend>
          {form.instalments.map((row, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input type="date" aria-label={t('proposalFields.due_on')} className="field flex-1" value={row.due_on} onChange={(e) => onChange({ ...form, instalments: form.instalments.map((r, j) => (j === i ? { ...r, due_on: e.target.value } : r)) })} />
              <input aria-label={t('common.amount')} placeholder={t('common.amount')} inputMode="decimal" className="field flex-1" value={row.amount} onChange={(e) => onChange({ ...form, instalments: form.instalments.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)) })} />
            </div>
          ))}
          <button type="button" className="h-9 rounded-xl border border-border px-3 text-sm" onClick={() => onChange({ ...form, instalments: [...form.instalments, { due_on: '', amount: '' }] })}>
            {t('proposalFields.addInstalment')}
          </button>
        </fieldset>
      )}

      {type === 'wind_up' && (
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('proposalFields.asset_ids_to_sell')}</legend>
          {activeAssets.map((a) => (
            <label key={a.id} className="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" checked={form.windUpAssets.includes(a.id)} onChange={(e) => onChange({ ...form, windUpAssets: e.target.checked ? [...form.windUpAssets, a.id] : form.windUpAssets.filter((x) => x !== a.id) })} />
              {a.name}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
}
