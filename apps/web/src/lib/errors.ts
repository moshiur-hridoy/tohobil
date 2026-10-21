import type { TFunction } from 'i18next';
import { ApiError } from './api';

/** Maps a problem `code` to a Bengali message; unknown codes get the generic text (spec 8). */
export function errorMessage(t: TFunction, err: unknown): { message: string; requestId?: string } {
  if (err instanceof ApiError) {
    if (err.code === 'network') return { message: t('errors.network') };
    const key = `errors.${err.code}`;
    if (err.code !== 'request.invalid' && t(key, { defaultValue: '' }) !== '') {
      // A server fault keeps its reference number so it can be found in the logs.
      return { message: t(key), ...(err.status >= 500 && err.requestId ? { requestId: err.requestId } : {}) };
    }
    return { message: t('errors.generic'), ...(err.requestId ? { requestId: err.requestId } : {}) };
  }
  return { message: t('errors.generic') };
}
