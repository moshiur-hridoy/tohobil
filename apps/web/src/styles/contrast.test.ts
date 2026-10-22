/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA contrast for the colour pairs the screens actually use (spec 14, accessibility pass): 4.5:1 for
 * normal text, 3:1 for large text and for borders of controls. Read straight from theme.css, so restyling
 * the theme cannot quietly break readability.
 */

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** `--name: #hex` or `--name: var(--other)`; a var() is resolved after the theme is assembled. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6}|var\(--[\w-]+\))/g)].map((m) => [m[1]!, m[2]!]),
  );
}
function resolve(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(raw)) {
    let v = raw[name]!;
    for (let i = 0; i < 5 && v.startsWith('var('); i++) v = raw[v.slice(6, -1)] ?? v;
    out[name] = v;
  }
  return out;
}
const lightRaw = tokens(css.slice(css.indexOf(':root'), css.indexOf('@media')));
const light = resolve(lightRaw);
const dark = resolve({ ...lightRaw, ...tokens(css.slice(css.indexOf('@media'), css.indexOf('/* Base styles */'))) });

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [text token, background token, minimum ratio] */
const PAIRS: Array<[string, string, number]> = [
  ['foreground', 'background', 4.5],
  ['card-foreground', 'card', 4.5],
  ['foreground', 'card', 4.5],
  ['muted', 'background', 4.5],
  ['muted', 'card', 4.5],
  ['muted', 'soft', 4.5],
  ['ok', 'background', 4.5],
  ['ok', 'card', 4.5],
  ['ok', 'ok-bg', 4.5],
  ['warn', 'background', 4.5],
  ['warn', 'card', 4.5],
  ['warn', 'warn-bg', 4.5],
  ['bad', 'background', 4.5],
  ['bad', 'card', 4.5],
  ['bad', 'bad-bg', 4.5],
  ['primary', 'background', 4.5],
  ['primary', 'card', 4.5],
  ['primary', 'primary-soft', 4.5],
  ['primary-foreground', 'primary', 4.5],
  ['blue', 'blue-bg', 4.5],
  ['blue', 'card', 4.5],
  ['vio', 'vio-bg', 4.5],
  ['ink2', 'background', 4.5],
  ['ink2', 'card', 4.5],
  ['on-bad', 'bad', 4.5],
  // the outstanding card on the member home screen and the button inside it
  ['on-hero', 'hero', 4.5],
  ['on-hero-muted', 'hero', 4.5],
  ['on-hero', 'hero-chip', 4.5],
  ['on-hero', 'hero-icon', 3],
  ['on-hero-action', 'hero-action', 4.5],
  ['hero-action', 'hero', 3],
  // the same card in its warning colours, while something is owed
  ['on-hero', 'hero-alert', 4.5],
  ['on-hero-muted', 'hero-alert', 4.5],
  ['on-hero', 'hero-alert-chip', 4.5],
  ['on-hero', 'hero-alert-icon', 3],
  ['on-hero-alert-action', 'hero-alert-action', 4.5],
  ['hero-alert-action', 'hero-alert', 3],
  // keyboard focus ring and the brand fill must be visible against the page
  ['ring', 'background', 3],
  ['ring', 'card', 3],
  ['primary', 'hover', 4.5],
  ['foreground', 'hover', 4.5],
  ['foreground', 'primary-soft', 4.5],
  // the outline of a text field must be visible against the page (non-text contrast, 3:1)
  ['input', 'card', 3],
  ['input', 'background', 3],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast', (_name, theme) => {
  it.each(PAIRS)('%s on %s is at least %s:1', (fg, bg, min) => {
    expect(theme[fg], `token --${fg}`).toBeDefined();
    expect(theme[bg], `token --${bg}`).toBeDefined();
    const ratio = contrast(theme[fg]!, theme[bg]!);
    expect(ratio, `${fg} ${theme[fg]} on ${bg} ${theme[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
  });
});
