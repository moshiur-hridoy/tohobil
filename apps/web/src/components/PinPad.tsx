import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

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

/** Six dots and a numeric keypad (keys always show 0-9, whatever the language). Also accepts a hardware keyboard on desktop. */
export function PinPad({ value, onChange, onComplete, disabled, invalid }: PinPadProps) {
  const { t } = useTranslation();

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
        className={`flex gap-3.5 ${invalid ? 'motion-safe:animate-shake' : ''}`}
      >
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full border-2 transition-all duration-150 ${
              invalid ? 'border-bad' : i < value.length ? 'border-primary' : 'border-input'
            } ${i < value.length ? (invalid ? 'scale-110 bg-bad' : 'scale-110 bg-primary') : 'bg-transparent'}`}
          />
        ))}
      </div>
      <div className="grid w-full max-w-[19rem] grid-cols-3 gap-2.5">
        {KEYS.map((k, i) =>
          k === '' ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => (k === 'back' ? back() : press(k))}
              aria-label={k === 'back' ? t('auth.pinDelete') : k}
              className={`h-[3.75rem] rounded-2xl text-2xl font-semibold outline-none transition-[background-color,transform] duration-100 focus-visible:ring-2 focus-visible:ring-ring active:scale-95 disabled:opacity-50 ${
                k === 'back' ? 'text-muted hover:bg-soft' : 'bg-soft hover:bg-hover active:bg-primary-soft'
              }`}
            >
              {k === 'back' ? '⌫' : k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
