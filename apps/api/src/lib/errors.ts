/**
 * Application errors carry an HTTP status and a stable machine `code` (spec 4: RFC 7807 with codes
 * like `payment.duplicate_trx`). The web app maps codes to Bengali messages, so codes must not change.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra RFC 7807 members, e.g. a pointer to the existing payment on a duplicate TrxID. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(400, code, message, extra);
export const unauthorized = (code = 'auth.unauthorized', message = 'Authentication required') =>
  new AppError(401, code, message);
export const forbidden = (
  code = 'auth.forbidden',
  message = 'You do not have permission for this action',
) => new AppError(403, code, message);
export const notFound = (code = 'not_found', message = 'Not found') =>
  new AppError(404, code, message);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(409, code, message, extra);
