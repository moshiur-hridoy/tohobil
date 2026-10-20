import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Content-addressed blob storage on a local volume (spec 2, 11).
 *
 * A file lives at `<root>/<sha[0..2]>/<sha>` where `sha` is the SHA-256 of the stored bytes, so two
 * uploads of the same content share one blob, and the path is derived from content, never from user
 * input (no path traversal). Blobs are written once and never changed. The thumbnail of an image sits
 * next to it as `<sha>.thumb.jpg`. The root must not be served statically; files leave only through
 * the authenticated `GET /files/:id` route.
 */
export class FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Relative path stored in `files.path`. */
  static relativePath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('not a sha256 digest');
    return `${sha256.slice(0, 2)}/${sha256}`;
  }

  static thumbnailPath(relative: string): string {
    return `${relative}.thumb.jpg`;
  }

  /** Absolute path, refusing anything that would leave the root. */
  resolve(relative: string): string {
    const full = resolve(this.root, relative);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('path escapes the file store');
    }
    return full;
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await stat(this.resolve(relative));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write `data` at `relative` unless it is already there. Written to a temporary file on the same
   * volume first and renamed, so a reader never sees a half-written blob.
   */
  async write(relative: string, data: Buffer): Promise<void> {
    if (await this.exists(relative)) return;
    const target = this.resolve(relative);
    await mkdir(dirname(target), { recursive: true });
    const tmpDir = join(this.root, '.tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, randomBytes(12).toString('hex'));
    await writeFile(tmp, data, { mode: 0o640 });
    await rename(tmp, target);
  }

  async size(relative: string): Promise<number> {
    return (await stat(this.resolve(relative))).size;
  }

  open(relative: string): ReadStream {
    return createReadStream(this.resolve(relative));
  }
}
