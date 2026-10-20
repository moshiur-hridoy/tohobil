import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const THRESHOLD = 70;

/**
 * Pull-to-refresh for mobile lists (spec 8). Only starts when the page is scrolled to the top, and
 * only shows a hint; the data itself is refetched by `onRefresh`.
 */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown>; children: ReactNode }) {
  const { t } = useTranslation();
  const startY = useRef<number | null>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);

  const end = () => {
    const armed = pull >= THRESHOLD;
    startY.current = null;
    setPull(0);
    if (armed && !busy) {
      setBusy(true);
      void onRefresh().finally(() => setBusy(false));
    }
  };

  return (
    <div
      onTouchStart={(e) => {
        startY.current = window.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      }}
      onTouchMove={(e) => {
        if (startY.current === null) return;
        const dy = (e.touches[0]?.clientY ?? 0) - startY.current;
        setPull(dy > 0 ? Math.min(dy, THRESHOLD * 1.5) : 0);
      }}
      onTouchEnd={end}
    >
      {(pull > 0 || busy) && (
        <p role="status" className="py-2 text-center text-sm text-muted">
          {busy ? t('common.refreshing') : pull >= THRESHOLD ? t('common.refresh') : t('common.pulling')}
        </p>
      )}
      {children}
    </div>
  );
}
