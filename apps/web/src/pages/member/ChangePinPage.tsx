import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isValidPin } from '@barakah/shared';
import { LoadError } from '../../components/StateViews';
import { api } from '../../lib/api';

/** A member changes their own PIN. Their other devices are signed out and use the new PIN. */
export function ChangePinPage() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');

  const change = useMutation({
    mutationFn: () => api('/auth/pin/change', { method: 'POST', body: { current_pin: current, new_pin: next } }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setAgain('');
    },
  });

  const problem = next.length === 6 && !isValidPin(next) ? t('auth.pinTooWeak') : again.length === 6 && again !== next ? t('auth.pinMismatch') : null;
  const ready = /^\d{6}$/.test(current) && isValidPin(next) && again === next && !change.isPending;

  const field = (label: string, value: string, set: (v: string) => void, autoComplete: string) => (
    <label className="block text-sm text-muted">
      {label}
      <input
        type="password"
        inputMode="numeric"
        autoComplete={autoComplete}
        maxLength={6}
        value={value}
        onChange={(e) => set(e.target.value.replace(/\D/g, ''))}
        className="field field-lg mt-1 w-full text-lg tracking-widest"
      />
    </label>
  );

  return (
    <div className="space-y-4 p-4">
      <Link to="/menu" className="text-sm text-primary">{t('common.back')}</Link>
      <h1 className="text-xl font-semibold">{t('pinChange.title')}</h1>
      {field(t('pinChange.current'), current, setCurrent, 'current-password')}
      {field(t('pinChange.new'), next, setNext, 'new-password')}
      {field(t('pinChange.again'), again, setAgain, 'new-password')}
      {problem && <p className="text-bad">{problem}</p>}
      {change.error && <LoadError error={change.error} />}
      {change.isSuccess && <p className="text-ok">{t('pinChange.done')}</p>}
      <button
        type="button"
        disabled={!ready}
        onClick={() => change.mutate()}
        className="h-12 w-full rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50"
      >
        {t('pinChange.submit')}
      </button>
    </div>
  );
}
