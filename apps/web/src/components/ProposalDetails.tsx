import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { COMPLIANCE_CHECKLIST_FIELDS, type ProposalType } from '@barakah/shared';
import { api, apiBlob } from '../lib/api';
import { fmtDate } from '../lib/dates';
import { formatCount, localDigits } from '../lib/format';
import { taka } from '../lib/money';
import { ruleName, ruleValueText } from '../lib/ruleText';
import type { AssetRow, MemberRow, PartnerRow } from '../lib/types';

/** Proposal types whose whole payload is one piece of text. */
const TEXT_TYPES: readonly string[] = ['general', 'dissolution', 'land_selection', 'project_closure'];

/** Keys whose value is one of a fixed set of words, translated through `proposalOptions`. */
const OPTION_KEYS = new Set(['kind', 'unit', 'source_account', 'account', 'category', 'direction', 'role']);

const MEMBER_KEYS = new Set(['member_id', 'lender_member_id']);
const FILE_KEYS = new Set(['feasibility_file_id', 'file_id', 'document_file_id']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

/**
 * A proposal's details in plain words, the same for the member's vote screen and the cashier's
 * proposals page: Bengali labels, amounts in taka, names instead of ids, a button to open an attached
 * file, and the investment checklist as ticks. Nothing is shown as raw JSON or an id.
 */
export function ProposalDetails({ type, payload }: { type: ProposalType; payload: Record<string, unknown> }) {
  if (TEXT_TYPES.includes(type)) {
    const text = payload.text as string | undefined;
    return text ? <p className="whitespace-pre-line rounded-xl bg-soft p-3 text-sm [overflow-wrap:anywhere]">{text}</p> : null;
  }
  return (
    <div className="space-y-3 text-sm">
      <ComplianceChecklist type={type} payload={payload} />
      <DetailRows type={type} payload={payload} />
    </div>
  );
}

function ComplianceChecklist({ type, payload }: { type: ProposalType; payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  if (type !== 'investment_purchase') return null;
  const compliance = (payload.compliance ?? {}) as Record<string, boolean>;
  const allTrue = COMPLIANCE_CHECKLIST_FIELDS.every((f) => compliance[f] === true);
  return (
    <div className={`rounded-xl p-3 ${allTrue ? 'bg-ok-bg' : 'bg-warn-bg'}`}>
      <p className="mb-1 font-medium">{t('proposalsPage.compliance')}</p>
      <ul className="space-y-1">
        {COMPLIANCE_CHECKLIST_FIELDS.map((f) => (
          <li key={f} className="flex items-center gap-2">
            <span className={compliance[f] ? 'text-ok' : 'text-bad'}>{compliance[f] ? '✓' : '✗'}</span>
            <span>{t(`compliance.${f}`)}</span>
          </li>
        ))}
      </ul>
      {!allTrue && <p className="mt-2 text-bad">{t('proposalsPage.complianceIncomplete')}</p>}
    </div>
  );
}

function DetailRows({ type, payload }: { type: ProposalType; payload: Record<string, unknown> }) {
  const { t } = useTranslation();
  const keys = Object.keys(payload).filter((k) => k !== 'compliance' && hasValue(payload[k]));

  // Look names up only when this proposal points at a member, a shop or an asset.
  const needsMembers = keys.some((k) => MEMBER_KEYS.has(k));
  const needsPartners = keys.includes('partner_id');
  const needsAssets = keys.some((k) => k === 'asset_id' || k === 'asset_ids_to_sell' || k === 'items');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api<{ items: MemberRow[] }>('/members'), enabled: needsMembers });
  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<{ items: PartnerRow[] }>('/partners'), enabled: needsPartners });
  const assets = useQuery({ queryKey: ['assets'], queryFn: () => api<{ items: AssetRow[] }>('/assets?limit=200'), enabled: needsAssets });

  if (keys.length === 0) return null;

  const memberName = (id: string) => {
    const m = members.data?.items.find((x) => x.id === id);
    return m ? `${m.code} ${m.full_name}` : '…';
  };
  const partnerName = (id: string) => partners.data?.items.find((x) => x.id === id)?.name ?? '…';
  const assetName = (id: string) => assets.data?.items.find((x) => x.id === id)?.name ?? '…';
  const dateAndAmount = (row: { due_on?: string; amount_paisa?: string }) =>
    [row.due_on ? fmtDate(row.due_on) : null, row.amount_paisa ? taka(row.amount_paisa) : null].filter(Boolean).join(' · ');

  const value = (k: string, v: unknown): ReactNode => {
    if (FILE_KEYS.has(k) && typeof v === 'string') return <FileButton fileId={v} />;
    if (MEMBER_KEYS.has(k)) return memberName(String(v));
    if (k === 'partner_id') return partnerName(String(v));
    if (k === 'asset_id') return assetName(String(v));
    if (k === 'asset_ids_to_sell' && Array.isArray(v)) return <List items={v.map((id) => assetName(String(id)))} />;
    if (k === 'fine_ids' && Array.isArray(v)) return t('proposalFields.fineCount', { n: formatCount(v.length) });
    if ((k === 'payout_plan' || k === 'instalments') && Array.isArray(v)) {
      return <List items={(v as Array<{ due_on?: string; amount_paisa?: string }>).map(dateAndAmount)} />;
    }
    if (k === 'items' && Array.isArray(v)) {
      const rows = v as Array<{ asset_id?: string; value_paisa?: string; as_of?: string; basis?: string }>;
      return (
        <List
          items={rows.map((r) =>
            [r.asset_id ? assetName(r.asset_id) : null, r.value_paisa ? taka(r.value_paisa) : null, r.as_of ? fmtDate(r.as_of) : null, r.basis ?? null]
              .filter(Boolean)
              .join(' · '),
          )}
        />
      );
    }
    if (k === 'nominees' && Array.isArray(v)) {
      return <List items={(v as Array<{ name: string; relation?: string }>).map((n) => (n.relation ? `${n.name} (${n.relation})` : n.name))} />;
    }
    if (type === 'rule_change' && k === 'key') return ruleName(t, String(v));
    if (type === 'rule_change' && k === 'value') return ruleValueText(t, String(payload.key ?? ''), v);
    if (type === 'settlement' && k === 'kind') return t(`settlementKind.${String(v)}`, { defaultValue: String(v) });
    if (OPTION_KEYS.has(k)) return t(`proposalOptions.${String(v)}`, { defaultValue: String(v) });
    if (typeof v === 'boolean') return v ? t('common.yes') : t('common.no');
    if (typeof v === 'number') return k === 'quantity' ? localDigits(String(v)) : formatCount(v);
    if (k.endsWith('_paisa') && typeof v === 'string' && /^-?\d+$/.test(v)) return taka(v);
    if (typeof v === 'string' && DAY.test(v)) return fmtDate(v);
    if (typeof v === 'string') return v;
    // Anything else new: a short readable line rather than raw JSON.
    if (Array.isArray(v)) return formatCount(v.length);
    return '—';
  };

  return (
    <div className="rounded-xl bg-soft p-3">
      <p className="mb-1 font-medium">{t('proposal.payload')}</p>
      <dl>
        {keys.map((k) => (
          <div key={k} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-3 border-t border-border py-2 first:border-t-0">
            <dt className="text-muted">{t(`proposalFields.${k}`, { defaultValue: k.replace(/_/g, ' ') })}</dt>
            <dd className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{value(k, payload[k])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 tabular-nums">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function FileButton({ fileId }: { fileId: string }) {
  const { t } = useTranslation();
  const open = async () => {
    window.open(URL.createObjectURL(await apiBlob(`/files/${fileId}`)), '_blank', 'noopener');
  };
  return (
    <button type="button" onClick={() => void open()} className="h-9 rounded-xl border border-border bg-card px-3 text-sm font-semibold text-primary">
      {t('proposalFields.viewFile')}
    </button>
  );
}
