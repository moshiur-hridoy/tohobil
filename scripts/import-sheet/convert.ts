/**
 * Stage 1: legacy sheet tabs (CSV exports in import/raw/) -> import/normalized/*.csv + import/review.csv.
 *
 *   pnpm import:convert [--raw DIR] [--out DIR]
 *
 * Writes files only; never touches a database. Open import/review.csv, fix the normalized CSVs by
 * hand where it says so, then run `pnpm import:load`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RAW_TABS, convertSheet, reviewCsv, type RawTabs } from '../../apps/api/src/import/convert';
import { FILES, type NormalizedName } from '../../apps/api/src/import/schemas';
import { DEFAULT_NORMALIZED, DEFAULT_RAW, DEFAULT_REVIEW, flagValue } from './common';

const argv = process.argv.slice(2);
const rawDir = flagValue(argv, 'raw') ?? DEFAULT_RAW;
const outDir = flagValue(argv, 'out') ?? DEFAULT_NORMALIZED;
const reviewPath = flagValue(argv, 'out') ? join(dirname(outDir), 'review.csv') : DEFAULT_REVIEW;

const tabs: RawTabs = {};
for (const [key, file] of Object.entries(RAW_TABS) as Array<[keyof RawTabs, string]>) {
  const path = join(rawDir, file);
  if (existsSync(path)) tabs[key] = readFileSync(path, 'utf8');
  else console.warn(`warning: ${path} not found, skipped`);
}

const result = convertSheet(tabs);
mkdirSync(outDir, { recursive: true });
for (const name of Object.keys(FILES) as NormalizedName[]) {
  writeFileSync(join(outDir, FILES[name].file), result.files[name]);
}
mkdirSync(dirname(reviewPath), { recursive: true });
writeFileSync(reviewPath, reviewCsv(result.review));
console.log(`Wrote ${Object.keys(FILES).length} files to ${outDir}`);
console.log(`${result.review.length} row(s) need a decision: see ${reviewPath}`);
