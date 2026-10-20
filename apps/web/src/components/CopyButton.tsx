import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="h-11 min-w-11 shrink-0 rounded-xl border border-border bg-card px-3 text-sm font-medium text-primary"
    >
      {done ? t('common.copied') : t('common.copy')}
    </button>
  );
}
