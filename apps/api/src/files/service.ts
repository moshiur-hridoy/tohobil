import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ReadStream } from 'node:fs';
import type pg from 'pg';
import { FILE_MAX_BYTES, type Clock } from '@barakah/shared';
import type { AuthUser } from '../auth/service';
import { audit } from '../lib/audit';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { inTransaction } from '../lib/tx';
import { isImage, makeThumbnail, processImage, sniffFileType } from './process';
import { FileStore } from './storage';

export interface FileDeps {
  pool: pg.Pool;
  store: FileStore;
  clock: Clock;
}

export interface ClientCtx {
  ip?: string | undefined;
}

export interface UploadedFile {
  id: string;
  sha256: string;
  mime: string;
  size_bytes: string;
  original_name: string | null;
  /** Pixel size of an image after re-encoding; null for a PDF. */
  width: number | null;
  height: number | null;
  created_at: string;
}

// Control characters and the double quote: the regex is the point, so the lint rule does not apply.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f"]/g;

/** Keep only a harmless display name: no directories, no control characters, no quotes. */
export function sanitizeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(UNSAFE_NAME_CHARS, '').trim().slice(0, 200);
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : null;
}

/**
 * Store an uploaded file (spec 7, 11).
 *
 *  - the type comes from the bytes (JPEG, PNG, WebP or PDF); anything else is `415`;
 *  - images are re-encoded, which strips EXIF and all other metadata, applies the camera orientation
 *    and scales huge images down; PDFs are stored exactly as sent;
 *  - the blob is named after the SHA-256 of what is stored, so identical content is stored once, and a
 *    thumbnail is made for every image;
 *  - one `files` row per upload (who, when, original name) and an audit row.
 * `created_by` is the uploading *user* id.
 */
export async function uploadFile(
  deps: FileDeps,
  user: AuthUser,
  input: { bytes: Buffer; originalName: string | null },
  ctx: ClientCtx,
): Promise<UploadedFile> {
  const { bytes } = input;
  if (bytes.length === 0) throw badRequest('file.empty', 'The file is empty');
  if (bytes.length > FILE_MAX_BYTES) throw tooLarge();

  const mime = sniffFileType(bytes);
  if (!mime) {
    throw new AppError(
      415,
      'file.unsupported_type',
      'Only JPEG, PNG, WebP images and PDF files are accepted',
    );
  }

  let stored = bytes;
  let width: number | null = null;
  let height: number | null = null;
  if (mime !== 'application/pdf') {
    const image = await processImage(bytes, mime);
    stored = image.data;
    width = image.width;
    height = image.height;
  }
  if (stored.length > FILE_MAX_BYTES) throw tooLarge();

  const sha256 = createHash('sha256').update(stored).digest('hex');
  const relative = FileStore.relativePath(sha256);
  await deps.store.write(relative, stored);
  if (isImage(mime))
    await deps.store.write(FileStore.thumbnailPath(relative), await makeThumbnail(stored));

  const originalName = sanitizeFileName(input.originalName);
  return inTransaction(deps.pool, async (tx) => {
    const res = await tx.query(
      `INSERT INTO files (sha256, mime, size_bytes, path, original_name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [sha256, mime, stored.length, relative, originalName, user.id],
    );
    const row = res.rows[0] as { id: string; created_at: Date };
    await audit(tx, {
      actor: user.id,
      action: 'file.upload',
      entityType: 'file',
      entityId: row.id,
      after: { sha256, mime, size_bytes: String(stored.length), original_name: originalName },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
    return {
      id: row.id,
      sha256,
      mime,
      size_bytes: String(stored.length),
      original_name: originalName,
      width,
      height,
      created_at: row.created_at.toISOString(),
    };
  });
}

export const tooLarge = () =>
  new AppError(413, 'file.too_large', `Files can be at most ${FILE_MAX_BYTES / (1024 * 1024)} MB`);

interface FileRow {
  id: string;
  mime: string;
  size_bytes: string | bigint;
  path: string;
  original_name: string | null;
  created_by: string | null;
  proof_member_ids: string[];
  is_shared: boolean;
}

export interface FileView {
  stream: ReadStream;
  contentType: string;
  size: number;
  /** `inline` for images, `attachment` for PDFs. */
  disposition: 'inline' | 'attachment';
  filename: string;
}

/**
 * Authorise and open a file for download (spec 7: `GET /files/:id`, role M; 11, 19.4).
 *
 *  - A payment proof is for its payer, the cashier and the auditor only, and every view is audited
 *    (`file.view_proof`): proofs show account numbers and balances.
 *  - A file attached to the group's records (member photo, asset or constitution document, charity
 *    receipt, feasibility report) is for every member.
 *  - A file not attached to anything yet (just uploaded) is for its uploader, the cashier and the
 *    auditor.
 */
export async function openFile(
  deps: FileDeps,
  user: AuthUser,
  id: string,
  opts: { thumb: boolean },
  ctx: ClientCtx,
): Promise<FileView> {
  const res = await deps.pool.query(
    `SELECT f.id, f.mime, f.size_bytes, f.path, f.original_name, f.created_by,
            ARRAY(SELECT DISTINCT p.member_id FROM payments p WHERE p.proof_file_id = f.id) AS proof_member_ids,
            (EXISTS (SELECT 1 FROM members m WHERE m.photo_file_id = f.id)
             OR EXISTS (SELECT 1 FROM documents d WHERE d.file_id = f.id)
             OR EXISTS (SELECT 1 FROM constitution_versions c WHERE c.file_id = f.id)
             OR EXISTS (SELECT 1 FROM charity_donations c WHERE c.proof_file_id = f.id)
             OR EXISTS (SELECT 1 FROM assets a WHERE a.feasibility_file_id = f.id)) AS is_shared
     FROM files f WHERE f.id = $1`,
    [id],
  );
  const file = res.rows[0] as FileRow | undefined;
  if (!file) throw notFound('file.not_found', 'File not found');

  const privileged = user.roles.includes('cashier') || user.roles.includes('auditor');
  const isProof = file.proof_member_ids.length > 0;
  if (isProof) {
    if (!privileged && !file.proof_member_ids.includes(user.member_id)) throw forbidden();
  } else if (!file.is_shared && !privileged && file.created_by !== user.id) {
    throw forbidden();
  }

  if (opts.thumb && !isImage(file.mime)) {
    throw notFound('file.no_thumbnail', 'Only images have a thumbnail');
  }

  let relative = file.path;
  if (opts.thumb) {
    relative = FileStore.thumbnailPath(file.path);
    if (!(await deps.store.exists(relative))) {
      // Made at upload; only missing if the volume was restored without it.
      await deps.store.write(
        relative,
        await makeThumbnail(await readFile(deps.store.resolve(file.path))),
      );
    }
  } else if (!(await deps.store.exists(file.path))) {
    throw new AppError(500, 'file.missing', 'The stored file is missing');
  }

  if (isProof) {
    await audit(deps.pool, {
      actor: user.id,
      action: 'file.view_proof',
      entityType: 'file',
      entityId: file.id,
      after: { thumb: opts.thumb },
      ip: ctx.ip,
      deviceId: user.device_id,
    });
  }

  const pdf = file.mime === 'application/pdf';
  return {
    stream: deps.store.open(relative),
    contentType: opts.thumb ? 'image/jpeg' : file.mime,
    size: await deps.store.size(relative),
    disposition: pdf ? 'attachment' : 'inline',
    filename: file.original_name ?? `file-${file.id}${pdf ? '.pdf' : ''}`,
  };
}

/** `Content-Disposition` with an ASCII fallback and the real name in RFC 5987 form. */
export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
