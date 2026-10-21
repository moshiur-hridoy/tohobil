import { toWesternDigits } from '@barakah/shared';
import type { ClauseInput } from './service';

export interface ParsedConstitution {
  title: string | null;
  clauses: ClauseInput[];
  /** Non-blank lines that are not inside a numbered clause (and so are not loaded). */
  ignored: string[];
}

const ARTICLE = /^##\s+(.+)$/;
/** "### 2.2 Late fine", "### ২.২ জরিমানা" or "### ২.২। জরিমানা": the number, then the title. */
const CLAUSE = /^###\s+([0-9০-৯]+(?:\.[0-9০-৯]+)*)[।.]?\s+(.+)$/;

/**
 * Split the constitution markdown (private/constitution_v1.bn.md, shape as examples/constitution.example.md)
 * into clauses. Clause numbers are stored with ASCII digits so they match `rules.clause_ref` ("2.2")
 * whatever digits the document uses; the article heading becomes the clause summary.
 */
export function parseConstitution(markdown: string): ParsedConstitution {
  let title: string | null = null;
  let article: string | null = null;
  let current: { clause_no: string; title: string; summary: string | null; lines: string[] } | null = null;
  const clauses: ClauseInput[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();

  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    clauses.push({ clause_no: current.clause_no, title: current.title, summary: current.summary, body: body || null });
    current = null;
  };

  const text = markdown.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const clause = CLAUSE.exec(line);
    if (clause) {
      flush();
      const no = toWesternDigits(clause[1]!);
      if (seen.has(no)) throw new Error(`Clause ${no} appears twice`);
      seen.add(no);
      current = { clause_no: no, title: clause[2]!.trim(), summary: article, lines: [] };
      continue;
    }
    if (line.startsWith('# ') && title === null) {
      title = line.slice(2).trim();
      continue;
    }
    const heading = ARTICLE.exec(line);
    if (heading) {
      flush();
      article = heading[1]!.trim();
      continue;
    }
    if (current) current.lines.push(line.trim());
    else if (line.trim()) ignored.push(line.trim());
  }
  flush();
  return { title, clauses, ignored };
}
