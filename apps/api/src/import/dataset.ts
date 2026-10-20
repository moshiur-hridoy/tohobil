import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { csvObjects } from './csv';
import { FILES, type Dataset, type NormalizedName } from './schemas';

/** A refusal with every problem found, so the owner can fix the CSVs in one pass. */
export class ImportError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(problems.length > 0 ? `${message}\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'ImportError';
  }
}

/** Files that may be absent: without them the default allocation applies (Doc.md 13). */
const OPTIONAL: readonly NormalizedName[] = ['allocations'];

/** Validate normalized CSV texts (keyed by file name, e.g. `members.csv`) into typed rows. */
export function parseDataset(texts: Partial<Record<string, string>>): Dataset {
  const problems: string[] = [];
  const out: Record<string, unknown[]> = {};
  for (const name of Object.keys(FILES) as NormalizedName[]) {
    const { file, schema, columns } = FILES[name];
    const text = texts[file];
    if (text === undefined) {
      if (!OPTIONAL.includes(name)) problems.push(`${file}: file is missing`);
      out[name] = [];
      continue;
    }
    const rows = csvObjects(text);
    const first = rows[0];
    if (first) {
      const missing = columns.filter((c) => !(c in first));
      if (missing.length > 0) problems.push(`${file}: missing column(s) ${missing.join(', ')}`);
    }
    out[name] = rows.flatMap((row, i) => {
      const parsed = (schema as ZodTypeAny).safeParse(row);
      if (parsed.success) return [parsed.data as unknown];
      for (const issue of parsed.error.issues) {
        problems.push(`${file} row ${i + 2}: ${issue.path.join('.') || '(row)'}: ${issue.message}`);
      }
      return [];
    });
  }
  if (problems.length > 0) throw new ImportError('The normalized CSVs are not valid', problems);
  return out as unknown as Dataset;
}

/** Read and validate every normalized CSV in a directory. */
export function readDataset(dir: string): Dataset {
  const texts: Record<string, string> = {};
  for (const name of Object.keys(FILES) as NormalizedName[]) {
    const path = join(dir, FILES[name].file);
    if (existsSync(path)) texts[FILES[name].file] = readFileSync(path, 'utf8');
  }
  return parseDataset(texts);
}
