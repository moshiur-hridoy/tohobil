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
export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="px-4 pb-2 pt-4">
      <h1 className="text-2xl font-bold">{title}</h1>
      {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
    </header>
  );
}
