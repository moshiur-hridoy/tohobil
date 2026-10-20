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
      className="h-10 shrink-0 rounded-md border border-border px-3 text-sm"
    >
      {done ? t('common.copied') : t('common.copy')}
    </button>
  );
}
