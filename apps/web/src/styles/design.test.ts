/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the screens inside the design system (DESIGN.md at the repository root). A failure names the
 * file and line; use the token or class DESIGN.md gives instead of adding an exception here.
 */

const root = new URL('../', import.meta.url);
const sources = (readdirSync(root, { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ file: f, lines: readFileSync(new URL(f, root), 'utf8').split('\n') }));

const offences = (bad: (line: string) => boolean) =>
  sources.flatMap(({ file, lines }) => lines.flatMap((line, i) => (bad(line) ? [`${file}:${i + 1} ${line.trim().slice(0, 120)}`] : [])));

/** Every quoted piece of a line, which is where class names live. */
const strings = (line: string) => line.split(/["'`]/);

describe('design system', () => {
  it('uses only the corner scale (xs, sm, md, lg, xl, full)', () => {
    expect(offences((l) => /\brounded(?:-[trblse]{1,2})?-(?:2xl|3xl|\[)/.test(l))).toEqual([]);
  });

  it('rounds fully only circles, never a chip or a button with side padding', () => {
    // a counter badge (min-w-*) is the one padded shape that stays round: with one digit it is a circle
    expect(offences((l) => strings(l).some((s) => /(?<![\w:-])rounded-full(?![\w-])/.test(s) && /(?<![\w-])px-[1-9]/.test(s) && !/(?<![\w-])min-w-/.test(s)))).toEqual([]);
  });

  it('uses the named type scale, not one-off text sizes', () => {
    expect(offences((l) => /(?<![\w-])text-\[\d*\.?\d+(?:rem|px|em)\]/.test(l))).toEqual([]);
  });

  it('uses the two elevations, shadow-card and shadow-lift', () => {
    expect(offences((l) => /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl|inner)(?![\w-])/.test(l))).toEqual([]);
  });

  it('builds action buttons from the btn classes', () => {
    // a hand-made button of button height with the primary fill would drift from the rest
    expect(offences((l) => strings(l).some((s) => /(?<![\w:-])bg-primary(?![\w-])/.test(s) && /(?<![\w-])(?:min-)?h-(?:9|10|11|12|14|\[)/.test(s)))).toEqual([]);
  });
});
