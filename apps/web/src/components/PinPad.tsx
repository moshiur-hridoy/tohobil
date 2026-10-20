import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toBengaliDigits } from '@barakah/shared';
import { getDigits } from '../lib/format';

const PIN_LENGTH = 6;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'] as const;

interface PinPadProps {
  value: string;
  onChange(next: string): void;
  /** Called once when the sixth digit is entered. */
  onComplete?(pin: string): void;
  disabled?: boolean;
  invalid?: boolean;
}

/** Six dots and a numeric keypad. Also accepts a hardware keyboard on desktop. */
export function PinPad({ value, onChange, onComplete, disabled, invalid }: PinPadProps) {
  const { t } = useTranslation();
  const show = (d: string) => (getDigits() === 'bn' ? toBengaliDigits(d) : d);

  const press = (digit: string) => {
    if (disabled || value.length >= PIN_LENGTH) return;
    const next = value + digit;
    onChange(next);
    if (next.length === PIN_LENGTH) onComplete?.(next);
  };
  const back = () => !disabled && onChange(value.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="flex flex-col items-center gap-6">
      <div
        role="img"
        aria-label={t('auth.pinEntered', { count: value.length })}
        className="flex gap-3"
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full border-2 ${
              invalid ? 'border-bad' : 'border-primary'
            } ${i < value.length ? (invalid ? 'bg-bad' : 'bg-primary') : 'bg-transparent'}`}
          />
        ))}
      </div>
      <div className="grid w-full max-w-[18rem] grid-cols-3 gap-3">
        {KEYS.map((k, i) =>
          k === '' ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => (k === 'back' ? back() : press(k))}
              aria-label={k === 'back' ? t('auth.pinDelete') : show(k)}
              className="h-16 rounded-2xl border border-border bg-background text-2xl font-semibold active:bg-hover disabled:opacity-50"
            >
              {k === 'back' ? '⌫' : show(k)}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
