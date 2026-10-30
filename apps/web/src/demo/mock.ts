/**
 * The UI demo's stand-in for the API (docs/DEMO.md). Only loaded when the app is built with
 * VITE_DEMO=1: every request is answered from data recorded off a real, fictional fund
 * (`pnpm demo:record`), so the demo needs no server. Reading works everywhere; anything that would
 * change the books answers "not saved in the demo".
 */

export type DemoRole = 'cashier' | 'auditor' | 'member';

/** The three demo accounts, by member ID. */
export const DEMO_ACCOUNTS: Record<string, DemoRole> = { M01: 'cashier', M07: 'auditor', M02: 'member' };

const ROLE_KEY = 'barakah.demo_role';

/** Writes that only record a UI event; answered quietly so nothing shows an error. */
const SILENT_WRITES = [/^\/notifications\/[^/]+\/open$/, /^\/devices$/, /^\/auth\/totp\/verify$/];

const loaders: Record<DemoRole, () => Promise<{ default: Record<string, unknown> }>> = {
  cashier: () => import('./data/cashier.json'),
  auditor: () => import('./data/auditor.json'),
  member: () => import('./data/member.json'),
};
const cache: Partial<Record<DemoRole, Record<string, unknown>>> = {};

function role(): DemoRole | null {
  try {
    return localStorage.getItem(ROLE_KEY) as DemoRole | null;
  } catch {
    return null;
  }
}

function setRole(r: DemoRole | null): void {
  try {
    if (r) localStorage.setItem(ROLE_KEY, r);
    else localStorage.removeItem(ROLE_KEY);
  } catch {
    // Private mode: the demo session lasts until reload.
  }
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(status: number, code: string): Response {
  return json(status, { code, title: code });
}

function session(r: DemoRole): Response {
  return json(200, { access_token: `demo-${r}`, refresh_token: `demo-${r}`, device_id: 'demo' });
}

/** Exact path and query first; otherwise the recording of the same path whose query matches best. */
function lookup(data: Record<string, unknown>, path: string): unknown {
  if (path in data) return data[path];
  const [pathname, query = ''] = path.split('?');
  const wanted = new URLSearchParams(query);
  let best: { score: number; value: unknown } | null = null;
  for (const [key, value] of Object.entries(data)) {
    const [p, q = ''] = key.split('?');
    if (p !== pathname) continue;
    let score = 0;
    for (const [k, v] of new URLSearchParams(q)) if (wanted.get(k) === v) score++;
    if (!best || score > best.score) best = { score, value };
  }
  return best?.value;
}

interface DemoRequest {
  method?: string;
  body?: unknown;
}

export async function demoFetch(path: string, opts: DemoRequest): Promise<Response> {
  const method = opts.method ?? 'GET';
  // A short pause, so loading states behave as they do against a real server.
  await new Promise((r) => setTimeout(r, 120));

  if (path === '/auth/login' || path === '/auth/activate') {
    const ref = String((opts.body as { member_ref?: string } | undefined)?.member_ref ?? '').toUpperCase();
    const r = DEMO_ACCOUNTS[ref];
    if (!r) return problem(401, 'auth.invalid_pin');
    setRole(r);
    return session(r);
  }
  if (path === '/auth/refresh') {
    const r = role();
    return r ? session(r) : problem(401, 'auth.unauthorized');
  }
  if (path === '/auth/logout') {
    setRole(null);
    return json(204, undefined);
  }

  const r = role();
  if (!r) return problem(401, 'auth.unauthorized');

  if (method !== 'GET') {
    return SILENT_WRITES.some((re) => re.test(path.split('?')[0]!)) ? json(204, undefined) : problem(403, 'demo.read_only');
  }

  const data = (cache[r] ??= (await loaders[r]()).default);
  const value = lookup(data, path);
  if (value === undefined) return problem(404, 'demo.not_recorded');
  if (path === '/me') {
    // The recorded authenticator window has long expired; in the demo it stays open.
    return json(200, { ...(value as object), step_up_until: '2099-12-31T00:00:00Z' });
  }
  return json(200, value);
}
