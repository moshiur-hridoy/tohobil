/**
 * Which API GET responses the service worker may serve from cache when offline (spec 8: read-only
 * offline viewing of home, matrix, ledger and assets).
 *
 * IMPORTANT: Workbox serialises this function into the service worker with `toString()`. It must be
 * completely self-contained: any reference to a variable, import or helper defined outside its body
 * becomes a ReferenceError inside the worker. `api-cache-matcher.test.ts` enforces this.
 *
 * It is an allowlist on purpose. Never cached: auth, files (payment proofs), reports, devices,
 * payments (raw SMS), notifications and /health (which must always reflect reality).
 */
export function isOfflineReadableApiRequest({
  url,
  request,
}: {
  url: URL;
  request: Request;
}): boolean {
  return (
    request.method === 'GET' &&
    /^\/api\/v1\/(members|dues|fines|matrix|ledger|accounts|nav|assets|rent|proposals|rules|constitution|share-register|settlements)(\/|$)/.test(
      url.pathname,
    )
  );
}
