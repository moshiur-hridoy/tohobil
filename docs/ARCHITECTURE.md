# Architecture

One server, one Postgres, correctness and auditability over throughput (Doc.md section 1). Target: at most 50 members, 100k ledger rows, about 400-700 MB RAM in total.

## Runtime

```
 browser / Android shell ──HTTPS──▶ Cloudflare tunnel ──▶ api (Fastify, :3000) ──▶ Postgres 16
                                                          │  serves /api/v1/* and the built web app at /
                                                          └─ pg-boss jobs (Phase 2, same Postgres)
 backup sidecar (Phase 5): pg_dump → age → local volume + rclone; restic for /data/files
```

- **API** (`apps/api`): Fastify + zod (fastify-type-provider-zod). Errors are RFC 7807 `application/problem+json` with stable `code`s and a `request_id`. In production it is bundled by `esbuild` (`build.mjs`) into `dist/{index,migrate,healthcheck}.js`; real npm dependencies stay external and are installed with `pnpm deploy --prod`.
- **Web** (`apps/web`): React + Vite + Tailwind. Colours/radii/fonts are CSS variables in `theme.css`. PWA via `vite-plugin-pwa` (prompt-to-update). Android shell via Capacitor loading the production URL (`capacitor.config.ts`).
- **Shared** (`packages/shared`): single source for zod schemas, money (`formatBDT`, `parseBDT`, `divRound`), dates (`Clock`, Asia/Dhaka helpers), enums and i18n catalogues. Consumed as TypeScript source by both apps.
- **Database** (`db/migrations`): the schema, every integrity trigger, three roles. See below.

## Money

`bigint` paisa end to end. Postgres `int8` is parsed to `BigInt` and `date` to a plain `'YYYY-MM-DD'` string by the pool's type parsers (`apps/api/src/lib/db.ts`). JSON carries paisa as decimal strings (`packages/shared/src/schemas/common.ts`).

## Integrity model (defence in depth)

| Layer              | What it guarantees                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Row triggers       | `ledger_entries`, `audit_log`, `payment_allocations`, `member_snapshots`, `asset_valuations`, `rules`, `member_status_events`, `dues`, `device_events`, `charity_donations`: no UPDATE/DELETE. `votes`: only `superseded_at` may change. `payments`: core fields immutable, legal status transitions only. `fines`: only the waiver, once. |
| Statement triggers | `TRUNCATE` is refused on the append-only tables (row triggers do not fire for it).                                                                                                                                                                                                                                                         |
| Hash chain         | `ledger_before_insert` links each row to the previous one (`sha256(prev_hash \| canonical)`). A `BEFORE STATEMENT` trigger takes the advisory lock _before_ `seq` is assigned, so chain order equals `seq` order. `apps/api/src/lib/ledger-chain.ts` recomputes the chain byte for byte; the daily job and `pnpm verify-ledger` use it.    |
| Allocation guard   | `payment_allocations` insert checks bounds per payment/due/fine, member ownership and payment state, with row locks so concurrent confirmations cannot over-allocate.                                                                                                                                                                      |
| Roles              | `barakah_migrator` owns objects; `barakah_app` has DML only (no UPDATE/DELETE/TRUNCATE on append-only tables); `barakah_readonly` can verify but cannot read credential tables.                                                                                                                                                            |
| Locked periods     | Postings with an `entry_date` in a locked period are rejected by trigger.                                                                                                                                                                                                                                                                  |
| Retired accounts   | `FINE_INCOME` accepts no postings: fines are charity money (`CHARITY_PAYABLE`, Doc.md 18.2).                                                                                                                                                                                                                                               |

A superuser can still disable triggers; the nightly verifier then reports the broken row (tested), and the monthly statement prints the last hash as an external anchor.

## Decision records

Defaults chosen where the spec is silent are in `docs/ASSUMPTIONS.md`; deviations found during review are in `docs/AUDIT-PHASE-0.md`.
