import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListSkeleton } from '../../components/Skeleton';
import { Empty, LoadError } from '../../components/StateViews';
import { api, apiBlob } from '../../lib/api';
import { fmtDate } from '../../lib/dates';

interface Clause {
  id: string;
  clause_no: string;
  title: string | null;
  summary: string | null;
  body: string | null;
}

interface VersionSummary {
  id: string;
  version: string;
  file_id: string | null;
  effective_from: string;
  summary: string | null;
}

interface VersionDetail extends VersionSummary {
  clauses: Clause[];
  acked_at?: string;
}

export function ConstitutionPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [params] = useSearchParams();
  const wantedClause = params.get('clause');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const versions = useQuery({
    queryKey: ['constitution-versions'],
    queryFn: () => api<{ items: VersionSummary[] }>('/constitution/versions'),
  });
  const versionId = selected ?? versions.data?.items[0]?.id ?? null;

  const detail = useQuery({
    queryKey: ['constitution-version', versionId],
    queryFn: () => api<VersionDetail>(`/constitution/versions/${versionId}`),
    enabled: versionId !== null,
  });

  // A rule's clause link (/menu/constitution?clause=2.4) opens that clause in the shown version.
  useEffect(() => {
    const hit = detail.data?.clauses.find((c) => c.clause_no === wantedClause);
    if (hit) setOpen(hit.id);
  }, [detail.data, wantedClause]);

  const search = useQuery({
    queryKey: ['constitution-search', versionId, debounced],
    queryFn: () => api<{ items: Clause[] }>(`/constitution/versions/${versionId}/search?q=${encodeURIComponent(debounced)}`),
    enabled: versionId !== null && debounced.length > 0,
  });

  const ack = useMutation({
    mutationFn: () => api(`/constitution/versions/${versionId}/ack`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['constitution-version', versionId] }),
  });

  const pdf = useMutation({
    mutationFn: async (fileId: string) => {
      const url = URL.createObjectURL(await apiBlob(`/files/${fileId}`));
      window.open(url, '_blank', 'noopener');
    },
  });

  const items = versions.data?.items ?? [];
  const current = detail.data;
  const clauses = debounced ? search.data?.items : current?.clauses;
  const isLatest = versionId !== null && versionId === items[0]?.id;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center gap-2 px-3 py-2">
        <Link
          to="/menu"
          aria-label={t('common.back')}
          className="grid h-11 w-11 place-items-center rounded-[14px] border border-border bg-card text-foreground"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </Link>
        <div className="flex-1 pl-1 text-[19px] font-bold">{t('constitutionPage.title')}</div>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-1 pb-4">
        {versions.error ? (
          <LoadError error={versions.error} onRetry={() => void versions.refetch()} />
        ) : !versions.data ? (
          <ListSkeleton rows={4} />
        ) : items.length === 0 ? (
          <Empty text={t('constitutionPage.noVersions')} />
        ) : detail.error ? (
          <LoadError error={detail.error} onRetry={() => void detail.refetch()} />
        ) : !current ? (
          <ListSkeleton rows={4} />
        ) : (
          <>
            {!current.acked_at && (
              <section className="flex items-center gap-3 rounded-[18px] border border-[#F0DDAE] bg-warn-bg p-3">
                <div className="flex-1">
                  <div className="text-[15px] font-bold text-warn">{t('constitutionPage.newVersion')}</div>
                  <div className="text-[13px] text-foreground">{t('constitutionPage.newVersionHint')}</div>
                </div>
                <button
                  type="button"
                  disabled={ack.isPending}
                  onClick={() => ack.mutate()}
                  className="h-11 rounded-xl bg-primary px-4 text-[15px] font-bold text-primary-foreground disabled:opacity-60"
                >
                  {t('constitutionPage.ack')}
                </button>
              </section>
            )}
            {ack.error && <LoadError error={ack.error} />}

            <section className="flex items-center gap-3.5 rounded-[20px] border border-border bg-card p-4 shadow-sm">
              <div className="flex-1">
                <div className="text-[17px] font-bold">
                  {t('constitutionPage.version')} {current.version}
                  {isLatest && <span className="ml-2 text-xs font-semibold text-primary">{t('constitutionPage.current')}</span>}
                </div>
                <div className="text-xs text-muted">
                  {t('constitutionPage.effectiveFrom')} {fmtDate(current.effective_from)}
                  {current.acked_at && ` · ${t('constitutionPage.acked')}`}
                </div>
                {current.summary && <div className="mt-1 text-[13px]">{current.summary}</div>}
              </div>
              {current.file_id && (
                <button
                  type="button"
                  disabled={pdf.isPending}
                  onClick={() => pdf.mutate(current.file_id as string)}
                  className="h-11 text-[13px] font-bold text-primary"
                >
                  {t('constitutionPage.pdf')}
                </button>
              )}
            </section>
            {pdf.error && <LoadError error={pdf.error} />}

            <label className="flex h-[52px] items-center gap-2.5 rounded-2xl border-[1.5px] border-border bg-card px-3.5 text-muted">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('constitutionPage.search')}
                aria-label={t('constitutionPage.search')}
                className="flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted"
              />
            </label>

            <section className="rounded-[20px] border border-border bg-card px-4 py-1 shadow-sm">
              {search.error && debounced ? (
                <LoadError error={search.error} onRetry={() => void search.refetch()} />
              ) : !clauses ? (
                <ListSkeleton rows={3} />
              ) : clauses.length === 0 ? (
                <p className="py-6 text-center text-muted">{debounced ? t('constitutionPage.noMatches') : t('constitutionPage.noVersions')}</p>
              ) : (
                <ul>
                  {clauses.map((c) => (
                    <li key={c.id} id={`clause-${c.clause_no}`} className="border-b border-border py-2 last:border-b-0">
                      <button
                        type="button"
                        aria-expanded={open === c.id}
                        onClick={() => setOpen(open === c.id ? null : c.id)}
                        className="flex min-h-[54px] w-full items-center gap-3 text-left"
                      >
                        <span className="grid h-11 min-w-11 flex-none place-items-center rounded-[13px] bg-primary-soft px-2 text-sm font-bold text-primary">
                          {c.clause_no}
                        </span>
                        <span className="flex-1">
                          <span className="block text-base font-semibold">{c.title ?? c.clause_no}</span>
                          {c.summary && <span className="block text-[13px] text-muted">{c.summary}</span>}
                        </span>
                      </button>
                      {open === c.id && c.body && <p className="whitespace-pre-line pb-2 pl-14 text-[14px]">{c.body}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {items.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowOlder(!showOlder)}
                  className="flex min-h-11 items-center gap-1.5 text-sm font-bold text-primary"
                >
                  {showOlder ? t('constitutionPage.hideOlder') : t('constitutionPage.olderVersions')}
                </button>
                {showOlder && (
                  <ul className="rounded-[20px] border border-border bg-card px-4 shadow-sm">
                    {items.map((v) => (
                      <li key={v.id} className="border-b border-border last:border-b-0">
                        <button
                          type="button"
                          onClick={() => {
                            setSelected(v.id);
                            setOpen(null);
                          }}
                          className={`flex min-h-11 w-full items-center justify-between py-2 text-left ${v.id === versionId ? 'font-bold text-primary' : ''}`}
                        >
                          <span>
                            {t('constitutionPage.version')} {v.version}
                          </span>
                          <span className="text-xs text-muted">{fmtDate(v.effective_from)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
