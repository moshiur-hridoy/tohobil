import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { bn, type Clock } from '@barakah/shared';
import { charityStatement } from '../charity/service';
import { FileStore } from '../files/storage';
import { audit } from '../lib/audit';
import { conflict, notFound } from '../lib/errors';
import { inTransaction } from '../lib/tx';
import type pg from 'pg';
import { assertReadyForArchive } from '../periods/service';
import { toCsv, buildCsv } from './csv';
import { annualSummaryPdf, memberStatementPdf } from './documents';

export interface ArchiveDeps {
  pool: pg.Pool;
  clock: Clock;
  /** Where `<year>/` folders are written (a volume that is part of the backups, spec 12). */
  archivesDir: string;
  files: FileStore;
}

const README = (year: string): string => `Barakah Fund - archive ${year}
${bn.reports.archiveReadme.replace('{{year}}', year)}

annual-summary.pdf   One-page-style summary of the year: position, collections, charity, assets, audit.
statement-<M..>.pdf  One statement per member for the whole year (capital, dues, payments, fines).
ledger.csv           Every ledger entry of the year with its hash (the chain can be re-checked from this).
payments.csv         Every payment: who, how much, method, status. No SMS text or screenshots.
dues.csv             Every due with what was paid and what is still outstanding.
fines.csv            Every fine and whether it was waived or paid. Fines are charity money.
votes.csv            Every vote on every proposal.
proposals.csv        Every proposal and how it ended.
assets.csv           The fund's assets with cost and sale details.
valuations.csv       Every valuation of every asset.
members.csv          Members, shares and paid-in capital.
charity-statement.csv  Charity fund: opening, received, donated, closing.
constitution/        The constitution that was in force at year end.
documents/           Copies of the documents attached to assets.
SHA256SUMS           A fingerprint of every file. Run "shasum -a 256 -c SHA256SUMS" to prove nothing changed.

Amounts in the CSV files are in paisa (100 paisa = 1 taka).
`;

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Write the year's archive (spec 12): only once every month is locked and the auditor has signed the
 * year. An archive is never overwritten: if the folder exists the year is already closed.
 */
export async function createAnnualArchive(
  deps: ArchiveDeps,
  actor: { userId: string; ip?: string | undefined; deviceId?: string | null | undefined },
  year: string,
): Promise<{ year: string; dir: string; files: number }> {
  await assertReadyForArchive(deps.pool, year);
  const dir = resolve(deps.archivesDir, year);
  const exists = await stat(dir).then(() => true, () => false);
  if (exists) throw conflict('archive.exists', `The ${year} archive already exists and is never overwritten`);
  await mkdir(dir, { recursive: true });

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  await writeFile(join(dir, 'annual-summary.pdf'), await annualSummaryPdf(deps.pool, deps.clock, year));

  const members = (await deps.pool.query(`SELECT id, code FROM members WHERE status <> 'prospective' ORDER BY code`)).rows as Array<{ id: string; code: string }>;
  for (const m of members) {
    await writeFile(join(dir, `statement-${m.code}.pdf`), await memberStatementPdf(deps.pool, deps.clock, m.id, year));
  }

  for (const entity of ['ledger', 'payments', 'dues', 'fines', 'votes', 'proposals', 'valuations']) {
    await writeFile(join(dir, `${entity}.csv`), (await buildCsv(deps.pool, entity, { from, to })).csv);
  }
  await writeFile(join(dir, 'assets.csv'), (await buildCsv(deps.pool, 'assets')).csv);
  await writeFile(join(dir, 'members.csv'), (await buildCsv(deps.pool, 'members', { to })).csv);
  const charity = await charityStatement(deps.pool, year);
  await writeFile(
    join(dir, 'charity-statement.csv'),
    toCsv(['year', 'opening_paisa', 'receipts_paisa', 'disbursements_paisa', 'closing_paisa'], [charity as unknown as Record<string, unknown>]),
  );

  const constitution = await deps.pool.query(
    `SELECT v.version, f.path, f.original_name FROM constitution_versions v JOIN files f ON f.id = v.file_id
     WHERE v.effective_from <= $1::date ORDER BY v.effective_from DESC LIMIT 1`,
    [to],
  );
  const c = constitution.rows[0] as { version: string; path: string; original_name: string | null } | undefined;
  if (c) {
    await mkdir(join(dir, 'constitution'), { recursive: true });
    await copyFile(deps.files.resolve(c.path), join(dir, 'constitution', `constitution-${c.version}.pdf`));
  }
  const docs = (
    await deps.pool.query(
      `SELECT d.id, f.path, COALESCE(f.original_name, d.id::text) AS name FROM documents d JOIN files f ON f.id = d.file_id ORDER BY d.created_at`,
    )
  ).rows as Array<{ id: string; path: string; name: string }>;
  if (docs.length > 0) await mkdir(join(dir, 'documents'), { recursive: true });
  for (const d of docs) {
    const safe = d.name.replace(/[^\w.-]+/g, '_');
    await copyFile(deps.files.resolve(d.path), join(dir, 'documents', `${d.id.slice(0, 8)}-${safe}`));
  }

  await writeFile(join(dir, 'README.txt'), README(year));
  const sums: string[] = [];
  for await (const file of walk(dir)) {
    const rel = relative(dir, file).split('\\').join('/');
    if (rel !== 'SHA256SUMS') sums.push(`${await sha256(file)}  ${rel}`);
  }
  sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  await writeFile(join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  await inTransaction(deps.pool, (tx) =>
    audit(tx, {
      actor: actor.userId,
      action: 'archive.create',
      entityType: 'year',
      entityId: year,
      after: { files: sums.length + 1 },
      ip: actor.ip,
      deviceId: actor.deviceId,
    }),
  );
  return { year, dir, files: sums.length + 1 };
}

/** The whole archive of a year as a ZIP stream (for the download). */
export async function streamArchiveZip(deps: Pick<ArchiveDeps, 'archivesDir'>, year: string, out: Writable): Promise<void> {
  const dir = resolve(deps.archivesDir, year);
  const exists = await stat(dir).then(() => true, () => false);
  if (!exists) throw notFound('archive.not_found', `No archive has been created for ${year}`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  const done = pipeline(zip, out);
  zip.directory(dir, `barakah-${year}`);
  await zip.finalize();
  await done;
}

export async function archiveExists(deps: Pick<ArchiveDeps, 'archivesDir'>, year: string): Promise<boolean> {
  return stat(resolve(deps.archivesDir, year)).then(() => true, () => false);
}
