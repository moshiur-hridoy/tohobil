/**
 * Minimal API client: bearer token in memory, one transparent refresh-and-retry on an expired
 * access token, RFC 7807 problems surfaced as ApiError with the stable `code` (spec 4, 8).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refresher: (() => Promise<boolean>) | null = null;
let inflightRefresh: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** The auth layer registers how to refresh; the client stays free of storage concerns. */
export function setRefresher(fn: (() => Promise<boolean>) | null): void {
  refresher = fn;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body, or a FormData for an upload (the browser then sets the multipart boundary). */
  body?: unknown;
  headers?: Record<string, string>;
  /** false for login/activation/refresh, which carry no bearer token. */
  auth?: boolean;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) headers['content-type'] = 'application/json';
  if (opts.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
  try {
    return await fetch(`/api/v1${path}`, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined
        ? { body: isForm ? (opts.body as FormData) : JSON.stringify(opts.body) }
        : {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
}

async function toError(res: Response): Promise<ApiError> {
  const problem = (await res.json().catch(() => null)) as {
    code?: string;
    title?: string;
    request_id?: string;
    [k: string]: unknown;
  } | null;
  const { code, title, request_id, ...rest } = problem ?? {};
  return new ApiError(res.status, code ?? 'request.invalid', title ?? res.statusText, request_id, rest);
}

async function sendWithRefresh(path: string, opts: RequestOptions): Promise<Response> {
  let res = await send(path, opts);

  if (res.status === 401 && opts.auth !== false && refresher) {
    const body = (await res.clone().json().catch(() => null)) as { code?: string } | null;
    if (body?.code === 'auth.token_expired' || body?.code === 'auth.unauthorized') {
      inflightRefresh ??= refresher().finally(() => {
        inflightRefresh = null;
      });
      if (await inflightRefresh) res = await send(path, opts);
    }
  }
  return res;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await sendWithRefresh(path, opts);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** An authenticated binary download (proof thumbnails): `<img src>` cannot send a bearer token. */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await sendWithRefresh(path, {});
  if (!res.ok) throw await toError(res);
  return res.blob();
}
