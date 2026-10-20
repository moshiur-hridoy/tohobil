import { badRequest } from './errors';

/**
 * Opaque keyset-pagination cursors (spec 4: cursor-based, default 50, max 200).
 * A cursor is the sort key of the last row returned, as base64url JSON. Timestamps travel as text
 * with microsecond precision (a JS Date would truncate to milliseconds and skip or repeat rows).
 */
export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, length: number): string[] | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === length &&
      parsed.every((p) => typeof p === 'string')
    ) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  throw badRequest('request.invalid_cursor', 'The cursor is not valid');
}

/** SQL expression for a timestamptz column as a microsecond-precision UTC text key. */
export const tsKey = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
