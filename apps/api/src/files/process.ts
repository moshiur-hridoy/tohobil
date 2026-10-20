import sharp from 'sharp';
import { THUMBNAIL_MAX_SIDE, type FileMime } from '@barakah/shared';
import { AppError } from '../lib/errors';

// A 384 MB container: no pixel cache, one worker. Uploads are rare and small.
sharp.cache(false);
sharp.concurrency(1);

/** Refuse images that would need more memory than this to decode (decompression bombs). */
const MAX_INPUT_PIXELS = 50_000_000;
/** Proofs are screenshots and photos; nothing needs more than this on either side. */
const MAX_SIDE = 4096;

/**
 * Decide the file type from its own bytes. The browser's `Content-Type` and the file name are
 * ignored: a script renamed `.jpg` is not an image, and a PDF sent as `image/png` is a PDF.
 */
export function sniffFileType(bytes: Buffer): FileMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // PDF readers accept the header anywhere in the first 1024 bytes.
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'application/pdf';
  return null;
}

export const isImage = (mime: string): boolean => mime.startsWith('image/');

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
}

const corrupt = () =>
  new AppError(400, 'file.corrupt', 'The image could not be read: it may be damaged');

/**
 * Re-encode an image. This is what strips EXIF (GPS position, camera, owner name) and every other
 * embedded metadata block: sharp writes none unless asked to. The EXIF orientation is applied
 * first so a phone photo still looks upright after the tag is gone. Large images are scaled down.
 */
export async function processImage(
  input: Buffer,
  mime: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<ProcessedImage> {
  try {
    const pipeline = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    const encoded =
      mime === 'image/jpeg'
        ? pipeline.jpeg({ quality: 85, mozjpeg: true })
        : mime === 'image/png'
          ? pipeline.png({ compressionLevel: 9 })
          : pipeline.webp({ quality: 85 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw corrupt();
  }
}

/** A small JPEG preview (transparent areas become white). */
export async function makeThumbnail(image: Buffer): Promise<Buffer> {
  try {
    return await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: THUMBNAIL_MAX_SIDE,
        height: THUMBNAIL_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 75 })
      .toBuffer();
  } catch {
    throw corrupt();
  }
}
