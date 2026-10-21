import * as Dialog from '@radix-ui/react-dialog';
import type { HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip, Icon } from './ui';
import { Skeleton } from './Skeleton';

/**
 * The cashier screens' shared layout (the dashboard and matrix design): a wide page, a big title with
 * a subtitle and the page's actions on the right, a row of stat tiles, then cards, usually a main
 * table next to a detail or form panel from `xl` up.
 */

export const ICONS = {
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5M12 16v.01',
  check: 'M5 12l5 5 9-10',
  chevron: 'M9 5l7 7-7 7',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  flag: 'M12 3l10 18H2zM12 10v5M12 18v.01',
  grid: 'M4 5h16v14H4zM4 10h16M10 5v14',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  home: 'M3 21h18M5 21V10l7-4 7 4v11M9 21v-6h6v6',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  bell: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  doc: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6',
  hourglass: 'M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  message: 'M4 5h16v11H9l-5 4z',
  pause: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 9v6M14 9v6',
  plus: 'M12 5v14M5 12h14',
  scale: 'M12 4v16M5 20h14M6 8h12M6 8l-3 6h6zM18 8l-3 6h6z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  sliders: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4',
  trend: 'M3 17l6-6 4 4 8-9M15 6h6v6',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 5a3.5 3.5 0 0 1 0 6.5M18 14.5c2 .7 3.5 2.4 3.5 5.5',
  vote: 'M4 4h16v16H4zM9 12l2 2 4-4',
  wallet: 'M3 7h18v12H3zM3 11h18M16 15h2',
} as const;

/** Button looks. Height 44px (h-11) everywhere a finger may tap; `BTN_SM` is for dense table rows. */
export const BTN_PRIMARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
export const BTN_SECONDARY =
  'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-medium text-ink2 transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50';
export const BTN_SM =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-ink2 transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50';
export const BTN_SM_PRIMARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';

export function AdminPage({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[1400px] space-y-5">{children}</div>;
}

export function AdminHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <section {...rest} className={`min-w-0 rounded-[20px] border border-border bg-card shadow-card ${className}`}>
      {children}
    </section>
  );
}

/** A card's title row: optional icon chip, title and muted line, and an action on the right. */
export function CardHead({ title, sub, icon, tone = 'bg-primary-soft text-primary', action, id }: {
  title: ReactNode;
  sub?: ReactNode;
  icon?: string;
  tone?: string;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <Chip tone={tone} d={icon} size={32} iconSize={18} />}
        <div className="min-w-0">
          <h2 id={id} className="text-[1.0625rem] font-bold">{title}</h2>
          {sub && <p className="text-[0.8125rem] text-muted">{sub}</p>}
        </div>
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** Stat tiles in a row: two per line up to `xl`, then four. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2.5 sm:gap-3.5 xl:grid-cols-4">{children}</div>;
}

/**
 * One figure with its icon chip; `value` null shows a skeleton. With `to` the tile is a link; with
 * `onClick` it is a toggle button (`pressed` marks the active one, for tiles that filter a list).
 */
export function StatTile({ tone, icon, label, value, valueClass = '', sub, to, onClick, pressed }: {
  tone: string;
  icon: string;
  label: string;
  value: ReactNode | null;
  valueClass?: string;
  sub?: ReactNode;
  to?: string;
  onClick?: () => void;
  pressed?: boolean;
}) {
  const interactive = !!(to || onClick);
  const body = (
    <div className={`flex h-full items-center gap-3.5 rounded-[18px] border bg-card px-3.5 py-3.5 text-left shadow-card sm:px-[18px] sm:py-4 ${pressed ? 'border-primary ring-1 ring-primary' : 'border-border'} ${interactive ? 'transition-all hover:border-input hover:shadow-lift' : ''}`}>
      {/* the chip is decoration: on a phone the two-up tiles need the width for the figure */}
      <span className="hidden sm:block"><Chip tone={tone} d={icon} size={44} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[0.8125rem] leading-snug text-muted">{label}</p>
        {value === null ? (
          <Skeleton className="mt-1 h-7 w-20" />
        ) : (
          <p className={`truncate text-xl font-bold leading-tight tabular-nums sm:text-2xl ${valueClass}`}>{value}</p>
        )}
        {sub && value !== null && <p className="truncate text-xs text-muted">{sub}</p>}
      </div>
      {to && <span className="text-muted"><Icon d={ICONS.chevron} size={16} /></span>}
    </div>
  );
  if (to) return <Link to={to} className="block rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</Link>;
  if (onClick) {
    return (
      <button type="button" aria-pressed={pressed} onClick={onClick} className="block w-full rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {body}
      </button>
    );
  }
  return body;
}

/** Main area plus a side panel from `xl` (the panel drops below on smaller screens). */
export function SplitLayout({ main, side, sideWidth = '380px' }: { main: ReactNode; side?: ReactNode; sideWidth?: string }) {
  // no panel (for example a role that cannot act here): the main area takes the full width
  if (!side) return <div className="min-w-0 space-y-5">{main}</div>;
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_var(--side)]" style={{ ['--side' as string]: sideWidth }}>
      <div className="min-w-0 space-y-5">{main}</div>
      <div className="min-w-0 space-y-5">{side}</div>
    </div>
  );
}

/** Pill-shaped segmented control (the matrix range picker): buttons with aria-pressed. */
export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; count?: number | string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex max-w-full gap-0.5 overflow-x-auto rounded-xl bg-soft p-1 text-[0.8125rem]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${active ? 'bg-card font-bold text-foreground shadow-card' : 'text-ink2 hover:text-foreground'}`}
          >
            {o.label}
            {o.count !== undefined && <span className="text-xs font-normal text-muted tabular-nums">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The round member-code badge used in every member list. */
export function MemberBadge({ code, size = 'md' }: { code: string; size?: 'md' | 'lg' }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-full bg-soft font-bold text-ink2 ${size === 'lg' ? 'h-11 w-11 text-sm' : 'h-8 w-8 text-[0.6875rem]'}`}>
      {code}
    </span>
  );
}

/** Label / value line in a detail panel or dialog. */
export function InfoRow({ label, value, valueClass = '' }: { label: ReactNode; value: ReactNode; valueClass?: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 border-t border-border py-2 text-sm first:border-t-0">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-right font-semibold tabular-nums ${valueClass}`}>{value}</dd>
    </div>
  );
}

/** A labelled form control; the control itself carries the `field` class. */
export function FieldLabel({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block text-[0.8125rem] font-medium text-ink2 ${className}`}>
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

/** A success line after an action ("Saved."), announced to screen readers. */
export function Notice({ text, className = '' }: { text: string | null; className?: string }) {
  if (!text) return null;
  return (
    <p role="status" className={`flex items-center gap-2 rounded-xl bg-ok-bg px-4 py-2.5 text-sm font-medium text-ok ${className}`}>
      <Icon d={ICONS.check} size={16} sw={2.2} />
      {text}
    </p>
  );
}

/** Centred dialog with the cashier screens' look (not for money actions: those use ConfirmSheet). */
export function AdminDialog({ open, onClose, title, children, wide = false }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className={`fixed left-1/2 top-1/2 z-50 max-h-[90vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[24px] border border-border bg-card p-6 shadow-lift ${wide ? 'w-[min(40rem,94vw)]' : 'w-[min(30rem,92vw)]'}`}
        >
          <Dialog.Title className="mb-4 pr-8 text-lg font-bold">{title}</Dialog.Title>
          <Dialog.Close aria-label={t('common.close')} className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-hover">
            <Icon d="M6 6l12 12M18 6L6 18" size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The quiet empty state inside a card. */
export function EmptyCard({ text, icon = ICONS.check }: { text: string; icon?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Chip tone="bg-soft text-muted" d={icon} />
      <p className="text-sm text-muted">{text}</p>
    </div>
  );
}
