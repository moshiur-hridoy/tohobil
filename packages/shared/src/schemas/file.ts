import { z } from 'zod';
import { boolQuerySchema } from './common';

/** Spec 7 and 11: images and PDFs, at most 10 MB. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The types the server accepts. The server decides the type from the file's own bytes, never from
 * the browser's claim; this list is for client-side hints only.
 */
export const FILE_ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;
export type FileMime = (typeof FILE_ALLOWED_MIMES)[number];

/** Longest side of an image thumbnail, in pixels. */
export const THUMBNAIL_MAX_SIDE = 320;

/** `GET /files/:id?thumb=true` returns the thumbnail of an image. */
export const fileViewQuerySchema = z.object({ thumb: boolQuerySchema.optional() });
export type FileViewQuery = z.infer<typeof fileViewQuerySchema>;
