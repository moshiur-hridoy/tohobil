import { useTranslation } from 'react-i18next';
import { setPrivate, usePrivacy } from '../lib/privacy';
import { Icon } from './ui';

const EYE = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';
const EYE_OFF = 'M3 3l18 18 M10.6 6.1A9.6 9.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9 M6.5 6.9A17 17 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4-.9 M9.9 9.9a3 3 0 0 0 4.2 4.2';

/** Eye button: hides every taka amount on screen (shown as a wave, longer for bigger amounts) and shows them again. */
export function PrivacyToggle({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const hidden = usePrivacy();
  const label = t(hidden ? 'privacy.show' : 'privacy.hide');
  return (
    <button
      type="button"
      onClick={() => setPrivate(!hidden)}
      aria-label={label}
      aria-pressed={hidden}
      title={label}
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      <Icon d={hidden ? EYE_OFF : EYE} />
    </button>
  );
}
