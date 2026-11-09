import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { localDigits } from '../lib/format';

interface Clause {
  clause_no: string;
  title: string | null;
}

/** Above this many clauses a search box filters the list. */
const SEARCH_FROM = 12;

/** The clauses of the newest constitution version (the one the constitution page shows first). */
export function useConstitutionClauses(): { clauses: Clause[]; loading: boolean } {
  const versions = useQuery({
    queryKey: ['constitution-versions'],
    queryFn: () => api<{ items: Array<{ id: string }> }>('/constitution/versions'),
    staleTime: 10 * 60_000,
  });
  const versionId = versions.data?.items[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ['constitution-version', versionId],
    queryFn: () => api<{ clauses: Clause[] }>(`/constitution/versions/${versionId}`),
    enabled: versionId !== null,
    staleTime: 10 * 60_000,
  });
  return {
    clauses: detail.data?.clauses ?? [],
    loading: versions.isLoading || (versionId !== null && detail.isLoading),
  };
}

/** The clause a proposal type rests on (proposal_policies), or null. */
export function usePolicyClause(type: string): string | null {
  const policies = useQuery({
    queryKey: ['proposal-policies'],
    queryFn: () => api<{ items: Array<{ type: string; clause_ref: string | null }> }>('/proposals/policies'),
    staleTime: 10 * 60_000,
  });
  return policies.data?.items.find((p) => p.type === type)?.clause_ref ?? null;
}

const clauseLabel = (c: Clause): string => `${localDigits(c.clause_no)}${c.title ? ` — ${c.title}` : ''}`;

/**
 * Picks a clause of the constitution for a proposal. `suggested` (the clause the proposal type rests on)
 * is selected until the user picks something themselves, and only if that clause exists. Without a
 * loaded constitution the list holds only the suggested clause.
 */
export function ClauseSelect({
  value,
  onChange,
  suggested,
  className = '',
}: {
  value: string;
  onChange: (next: string) => void;
  /** Leave out to keep whatever `value` the caller set (a rule's own clause). */
  suggested?: string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const { clauses, loading } = useConstitutionClauses();
  const [query, setQuery] = useState('');
  const touched = useRef(false);

  useEffect(() => {
    if (suggested === undefined || touched.current || clauses.length === 0) return;
    const next = suggested && clauses.some((c) => c.clause_no === suggested) ? suggested : '';
    if (next !== value) onChange(next);
    // value/onChange are left out on purpose: this follows the suggestion, not the user's own choice
  }, [suggested, clauses]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clauses;
    return clauses.filter((c) => c.clause_no.includes(q) || localDigits(c.clause_no).includes(q) || (c.title ?? '').toLowerCase().includes(q));
  }, [clauses, query]);

  const pick = (next: string) => {
    touched.current = true;
    onChange(next);
  };

  // No constitution loaded yet: still a dropdown, offering only the suggested clause (or the one
  // already set), with a line saying why the list is short.
  if (!loading && clauses.length === 0) {
    const known = [...new Set([value, suggested ?? ''].filter(Boolean))];
    return (
      <div className={className}>
        <label className="field-label">
          {t('proposal.clauseRef')}
          <select className="field mt-1 w-full" value={value} onChange={(e) => pick(e.target.value)}>
            <option value="">{t('proposal.clauseNone')}</option>
            {known.map((c) => <option key={c} value={c}>{localDigits(c)}</option>)}
          </select>
        </label>
        <p className="mt-1 text-xs text-muted">{t('proposal.clauseNoConstitution')}</p>
      </div>
    );
  }

  // A clause chosen earlier (a rule's own clause) that this version does not list stays selectable.
  const missing = value && !clauses.some((c) => c.clause_no === value) ? value : null;
  const selected = clauses.find((c) => c.clause_no === value);
  return (
    <div className={className}>
      <label className="field-label">
        {t('proposal.clauseRef')}
        {clauses.length > SEARCH_FROM && (
          <input
            type="search"
            className="field mt-1 w-full"
            placeholder={t('proposal.clauseSearch')}
            aria-label={t('proposal.clauseSearch')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <select className="field mt-1 w-full" value={value} disabled={loading} onChange={(e) => pick(e.target.value)}>
          <option value="">{loading ? t('common.loading') : t('proposal.clauseNone')}</option>
          {missing && <option value={missing}>{localDigits(missing)}</option>}
          {selected && !shown.includes(selected) && <option value={selected.clause_no}>{clauseLabel(selected)}</option>}
          {shown.map((c) => (
            <option key={c.clause_no} value={c.clause_no}>{clauseLabel(c)}</option>
          ))}
        </select>
      </label>
      {query.trim() !== '' && shown.length === 0 && <p className="mt-1 text-xs text-muted">{t('proposal.clauseNoMatch')}</p>}
      {value && <ClauseLink clause={value} className="mt-1 inline-block text-xs" />}
    </div>
  );
}

/** "Read clause 4.2": opens the constitution page at that clause. */
export function ClauseLink({ clause, className = '' }: { clause: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <Link to={`/menu/constitution?clause=${encodeURIComponent(clause)}`} className={`font-semibold text-primary hover:underline ${className}`}>
      {t('rulesPage.readClause', { clause: localDigits(clause) })}
    </Link>
  );
}
