import { useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtDate } from '../lib/dates';

/** Small building blocks shared by the screens (design: icon chips, outline icons). */
export function Icon({ d, size = 20, sw = 1.8 }: { d: string; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Rounded icon tile; `tone` is a bg + text colour pair such as `bg-warn-bg text-warn`. */
export function Chip({ tone, d, size = 36, iconSize = 20 }: { tone: string; d: string; size?: number; iconSize?: number }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-xl ${tone}`} style={{ width: size, height: size }}>
      <Icon d={d} size={iconSize} />
    </span>
  );
}

/** Page heading used at the top of every member tab (design: 24px title + muted subtitle). */
export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="px-4 pb-2 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h1 className="text-2xl font-bold">{title}</h1>
        {action}
      </div>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
    </header>
  );
}

/** The muted "(ঐচ্ছিক)" after an optional field's label. Required fields carry no mark. */
export function Optional() {
  const { t } = useTranslation();
  return <span className="field-optional"> ({t('common.optional')})</span>;
}

// Classes that place the field in its row stay on the wrapper; the look stays on the input.
const LAYOUT_CLASS = /^(?:[a-z]+:)?(?:w-|flex-|m[trblxy]?-|col-span-|min-w-|max-w-|self-|grow|shrink)/;

/**
 * A date field that reads "২২ অক্টো ২০২৬" whatever the phone's region is. The browser's own date
 * input stays underneath for its picker, with its text hidden (it would show "10/22/2026" on most
 * phones); tapping anywhere on the field opens the picker. The value is still YYYY-MM-DD.
 */
export function DateInput({ className = 'field w-full', value, onClick, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & { value: string }) {
  const { t } = useTranslation();
  const classes = className.split(/\s+/).filter(Boolean);
  const outer = classes.filter((c) => LAYOUT_CLASS.test(c) && c !== 'w-full');
  const inner = classes.filter((c) => !outer.includes(c));
  const large = inner.includes('field-lg');
  return (
    <span className={`relative block ${outer.join(' ')}`}>
      <input
        {...rest}
        type="date"
        value={value}
        className={`${inner.join(' ')} w-full text-transparent caret-transparent`}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker();
          } catch {
            // Older browsers: their own tap behaviour still opens the picker.
          }
          onClick?.(e);
        }}
      />
      <span aria-hidden="true" className={`pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 ${large ? 'text-[1.0625rem]' : 'text-[0.9375rem]'} ${value ? '' : 'text-muted'}`}>
        {value ? fmtDate(value) : t('common.pickDate')}
      </span>
    </span>
  );
}

/**
 * Pick a photo or a PDF, in Bengali throughout: the browser's own file input would say "Choose File /
 * No file chosen" in the phone's language. The real input stays hidden; once a file is picked its
 * name is shown with "বদলান" (change) and "সরান" (remove).
 */
export function FilePicker({ file, onChange, accept = 'image/*,application/pdf', label, className = '' }: { file: File | null; onChange: (file: File | null) => void; accept?: string; label?: string; className?: string }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const pick = () => input.current?.click();
  const hidden = (
    <input
      ref={input}
      type="file"
      accept={accept}
      aria-label={label ?? t('file.add')}
      className="sr-only"
      tabIndex={-1}
      onChange={(e) => {
        onChange(e.target.files?.[0] ?? null);
        // Cleared so picking the same file again after "সরান" still fires a change.
        e.target.value = '';
      }}
    />
  );
  if (!file) {
    return (
      <div className={className}>
        {hidden}
        <button type="button" onClick={pick} className="flex w-full items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-input p-3 text-left hover:border-primary">
          <span aria-hidden="true" className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-primary-soft text-primary">
            <Icon d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-primary">{t('file.add')}</span>
            <span className="block text-xs text-muted">{t('file.hint')}</span>
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className={`flex items-center gap-3 rounded-[14px] border-[1.5px] border-primary bg-primary-soft p-3 ${className}`}>
      {hidden}
      <span aria-hidden="true" className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-card text-primary">
        <Icon d="M20 6L9 17l-5-5" size={20} sw={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">{t('file.attached')}</span>
        <span className="block truncate text-sm font-semibold">{file.name}</span>
      </span>
      <button type="button" onClick={pick} className="min-h-11 rounded-xl px-2 text-sm font-semibold text-primary hover:bg-hover">{t('file.change')}</button>
      <button type="button" onClick={() => onChange(null)} className="min-h-11 rounded-xl px-2 text-sm font-semibold text-bad hover:bg-hover">{t('file.remove')}</button>
    </div>
  );
}
