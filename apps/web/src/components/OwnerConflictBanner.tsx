import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { OwnerConflict } from '../lib/types';

/**
 * Prominent owner-decision conflict banner for cashier/auditor users (spec 18.12).
 * Fetches a simulated endpoint that currently returns an empty list, so the banner
 * auto-hides until the conflict list is persisted in a later phase.
 */
export function OwnerConflictBanner() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  const visible = (me?.roles.includes('cashier') || me?.roles.includes('auditor')) && !dismissed;

  const conflicts = useQuery({
    queryKey: ['owner-conflicts'],
    queryFn: () => api<{ items: OwnerConflict[] }>('/owner-conflicts'),
    enabled: visible,
  });

  const open = conflicts.data?.items.filter((c) => c.status === 'open') ?? [];

  if (!visible) return null;
  if (open.length === 0) return null;

  return (
    <div role="status" className="border-b border-warn bg-warn/10 p-3 text-warn">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{t('ownerConflict.title', { count: open.length })}</p>
          <ul className="mt-1 list-inside list-disc text-sm">
            {open.map((c) => (
              <li key={c.id}>{c.title}</li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="h-9 shrink-0 rounded-md border border-warn px-3 text-sm"
        >
          {t('ownerConflict.dismiss')}
        </button>
      </div>
    </div>
  );
}
