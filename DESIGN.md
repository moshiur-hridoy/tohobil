# Barakah design system

One system for the whole app: the member screens (phone) and the cashier screens (desktop) are the same React app and use the same tokens and classes. Read this before adding or changing anything visible.

**Rule of thumb:** pick from what is listed here. If something you need is missing, add it to the system (and to this file) first, then use it.

## Where it lives

| What | File |
| --- | --- |
| Colour, radius and font tokens | `apps/web/src/styles/theme.css` |
| Shared classes (`btn`, `field`, labels) | `apps/web/src/styles/globals.css` |
| Tailwind names for the tokens, type scale, shadows | `apps/web/tailwind.config.ts` |
| Shared components | `apps/web/src/components/` (`ui.tsx`, `admin.tsx`, and one file per larger part) |
| Automatic checks | `apps/web/src/styles/design.test.ts`, `contrast.test.ts` |

## Principles

1. **One main action per screen.** It is the only filled green button. Everything else is quieter.
2. **Calm surfaces.** Neutral backgrounds; colour carries meaning, not decoration.
3. **Soft corners, not bubbles.** Nothing is rounder than 16px except true circles.
4. **Easy for anyone.** Members use phones, some are not used to forms: large tap targets, words next to icons, status never shown by colour alone.
5. **Bengali first.** All visible text is an i18n key with an English fallback; check that long Bengali text fits at 360px width.

## Colour

Use the semantic names only (`bg-card`, `text-accent`). Never a hex value or a `--ref-*` palette variable in a component. Opacity modifiers (`bg-primary/10`) do not work with these tokens.

| Role | Classes | Light | Dark | Use for |
| --- | --- | --- | --- | --- |
| Primary | `bg-primary` `text-primary-foreground` | green `#007a24` | lime `#aff900` | The main action only |
| Accent | `text-accent` `bg-accent-soft` `bg-accent-fill` `text-on-accent` | indigo `#3730a3` | `#aab4ff` | Chosen tab or menu item, links, icons, progress, brand cards |
| Page | `bg-background` | `#f6f7f9` | `#0e0f13` | Behind everything |
| Card | `bg-card` | white | `#16181d` | Cards, dialogs |
| Inset | `bg-soft` | `#edeff3` | `#1e2127` | Fields, boxes inside a card |
| Lines | `border-border` `border-edge` `border-track` `border-input` | | | Card outline, field outline, bar track, small controls |
| Text | `text-foreground` `text-ink2` `text-muted` | | | Main, secondary, captions |
| Good money news | `text-ok` `bg-ok-bg` | `#12794f` | `#4ade80` | Paid, profit |
| Waiting | `text-warn` `bg-warn-bg` | `#8f5a00` | `#fbbf24` | Pending, running vote |
| Owed or refused | `text-bad` `bg-bad-bg` | `#b3302a` | `#f87171` | Overdue, rejected, destructive |

A finished state ("executed") is grey, not green. The member's "+" pay button is white (`bg-fab`). New text and background pairs go into `contrast.test.ts` (WCAG AA).

## Corners

| Class | Size | Use for |
| --- | --- | --- |
| `rounded-xs` | 4px | Legend swatches, tiny marks |
| `rounded-sm` | 6px | Chips, status pills, role badges |
| `rounded-md` | 8px | Small buttons, menu items, tab items, icon buttons, boxes inside a card |
| `rounded-lg` | 12px | **The default:** buttons, fields, cards, tiles, popovers, toasts, tab bars |
| `rounded-xl` | 16px | Dialogs, bottom sheets, the large balance card. The maximum |
| `rounded-full` | circle | Avatars, dots, count badges, switches, progress bars, the "+" button |

A box inside a card or dialog is `rounded-md`, and boxes that sit side by side always share one size (whatever their colour). A box inside another box is never rounder than the one around it. `rounded-2xl`, `rounded-3xl` and `rounded-[..]` do not exist.

## Buttons

`btn` + one look + (optionally) one size. Width and margins go on the element.

| Look | Class | When |
| --- | --- | --- |
| Primary | `btn btn-primary` | The one main action |
| Secondary | `btn btn-secondary` | Everything else: cancel, download, edit |
| Danger | `btn btn-danger` | Confirming something that cannot be undone or refuses someone |

| Size | Class | Height | When |
| --- | --- | --- | --- |
| Regular | (none) | 44px | Default |
| Large | `btn-lg` | 56px | The main action of a phone screen, sign-in |
| Small | `btn-sm` | 36px | Rows, cards and toolbars with several actions |

```tsx
<button type="submit" className="btn btn-primary btn-lg w-full">{t('pay.send')}</button>
<button type="button" className="btn btn-secondary btn-sm">{t('common.cancel')}</button>
<button type="button" className="btn btn-secondary text-bad">{t('devices.remove')}</button>
```

The cashier screens use the same classes through `BTN_PRIMARY`, `BTN_SECONDARY`, `BTN_SM` and `BTN_SM_PRIMARY` (`components/admin.tsx`).

Solid buttons are **raised** (darker rim, light top line, soft glow, sinks when pressed); secondary buttons have only a faint edge. This comes with the classes; do not add shadows by hand.

Special cases: vote buttons take their colours from `lib/voteTone.ts` (alike until chosen, so colour does not suggest an answer); the button on the balance card is `btn btn-lg bg-hero-action text-on-hero-action`. A text-only action is plain `text-accent` with a tap area of at least 44px.

## Form fields

One look: a lighter fill, a faint outline, the accent outline on focus and red when invalid.

| Class | Use |
| --- | --- |
| `field` | Every input, select and textarea (44px) |
| `field field-lg` | Sign-in screens and the pay form (56px) |
| `field-label` | The label, wrapping the control |
| `field-hint` | Help under a field |
| `<Optional />` | Marks an optional field; required fields carry no mark |

Dates use `<DateInput>`, files use `<FilePicker>` (pick, drop or paste), on/off uses `<Switch>`. Money inputs use `inputMode="decimal"`.

## Surfaces and parts

| Part | Standard |
| --- | --- |
| Card | `rounded-lg border border-border bg-card shadow-card`, padding `p-4` (`sm:p-5`). Cashier: `<Card>` and `<CardHead>` |
| Box inside a card | `rounded-md bg-soft p-3`; prefer a divider line to a box inside a box |
| Dialog or sheet | `rounded-xl`; money and other confirmations use `<ConfirmSheet>`, cashier forms `<AdminDialog>` |
| Chosen or hovered row | In a table inset in its card: `row-fill` on the `<tr>`, `aria-selected` when chosen. In a list: `rounded-md` with `bg-accent-soft` or `hover:bg-hover` |
| Tabs | `<Segmented>`: bar `rounded-lg`, items `rounded-md`, chosen one filled with the accent |
| Status | `<StatusPill>` (colour, glyph and word); time left uses `<CountdownChip>` |
| Count badge | `rounded-full` with `min-w-*`, on `bg-bad` for things needing attention |
| Member | `<MemberBadge>` for the ID, `<Avatar>` for the photo |
| Label and value | `<InfoRow>` |
| Nothing to show, loading, error | `<EmptyCard>`, `<ListSkeleton>` or `<Skeleton>`, `<LoadError>` |

## Type

Noto Sans Bengali, self-hosted. Weights: 400 text, 600 labels and buttons, 700 headings and money.

| Class | Size | Use |
| --- | --- | --- |
| `text-2xs` | 11px | Badges only |
| `text-xs` | 12px | Captions, chips |
| `text-meta` | 13px | Supporting lines on cards |
| `text-sm` | 14px | Default for dense screens |
| `text-body` | 15px | Phone body text, fields |
| `text-base` | 16px | Card titles |
| `text-lead` | 17px | Card headings, large buttons |
| `text-lg` / `text-title` | 18 / 19px | Dialog titles |
| `text-heading` / `text-2xl` | 22 / 24px | Page titles |
| `text-figure` / `text-figure-lg` / `text-display` | 28 / 36 / 42px | Money figures |

Money and counts that line up use `tabular-nums`. Format amounts with `taka()`, dates with `fmtDate()`.

## Elevation, spacing, touch

- Two shadows: `shadow-card` (resting) and `shadow-lift` (hover, popovers, dialogs).
- Spacing follows the 4px steps: `gap-3` between cards, `gap-5` between page sections on desktop, `p-4` inside cards.
- Tap targets are at least 44px (`h-11`); small buttons are the only exception.
- Pages never scroll sideways; check at 360px.
- Motion is short (about 150ms) and respects reduced motion.

## Checks

`pnpm test` fails when a screen leaves the system: a corner or text size outside the scale, a fully rounded chip or padded button, another shadow, or a hand-made primary button. Fix the screen. Change the rule only when the system itself changes, and update this file and `docs/ASSUMPTIONS.md` with it.

Owner decisions behind this system: `docs/ASSUMPTIONS.md` 98, 133, 135, 137, 138.
