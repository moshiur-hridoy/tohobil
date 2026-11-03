import raw from '../../../../CHANGELOG.md?raw';

export interface Release {
  /** "1.7.0" */
  version: string;
  /** YYYY-MM-DD */
  date: string;
  sections: Array<{ title: string; items: string[] }>;
}

/**
 * The released versions in CHANGELOG.md, newest first. A release is `## 1.7.0 (2026-11-03)`, its
 * groups are `### নতুন` and the like, and each change is a `- ` line. The "অপ্রকাশিত" (unreleased)
 * section is work not yet merged, so it is left out; `pnpm release` turns it into the next version.
 */
export function parseChangelog(text: string): Release[] {
  const out: Release[] = [];
  let release: Release | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^## (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)\s*$/.exec(line);
    if (head) {
      release = { version: head[1] as string, date: head[2] as string, sections: [] };
      out.push(release);
      continue;
    }
    if (line.startsWith('## ')) {
      release = null;
      continue;
    }
    if (!release) continue;
    if (line.startsWith('### ')) release.sections.push({ title: line.slice(4).trim(), items: [] });
    else if (line.startsWith('- ')) release.sections.at(-1)?.items.push(line.slice(2).trim());
  }
  return out;
}

export const RELEASES: Release[] = parseChangelog(raw);

/** The version this build is (root package.json, see vite.config.ts). */
export const APP_VERSION: string = __APP_VERSION__;
