# Phase 0: Scaffolding

Status: **complete after audit** (see `docs/AUDIT-PHASE-0.md`: the first version of this phase did not install, build or pass its own checks).

## What was built

- pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`), TypeScript strict, ESLint (type-aware) + Prettier.
- Baseline schema `db/migrations/001_initial-schema.sql`: all tables, accounts, rules, proposal policies, settings, views (`v_account_balances`, `v_due_status`, `v_fine_status`, `v_member_balances`), integrity triggers (append-only incl. TRUNCATE, ledger hash chain, locked periods, payment/fine guards, allocation bounds) and the three database roles' grants.
- API skeleton: validated environment, RFC 7807 errors, helmet/CORS/rate limiting, request-id logging, real `/api/v1/health`, static serving of the built web app with correct cache headers, `migrate` and `healthcheck` entry points, esbuild bundle.
- Shared package: money (`formatBDT`, `parseBDT`, `divRound`), Asia/Dhaka dates and `Clock`, enums, zod schemas (money as digit strings), proposal payload registry, i18n (bn + en, same keys).
- Web skeleton: layouts, placeholder pages (all strings via i18n), PWA with prompt-to-update, self-hosted Noto Sans Bengali, placeholder icons, offline page, Capacitor config.
- Infra: dev and production compose files, `infra/initdb/10-roles.sh`, Dockerfile (multi-stage, `pnpm deploy`, non-root), `.dockerignore`.
- Seed fixture (8 fictional members, shares `[2,4,1,1,3,1,4,4]`, idempotent, refuses non-local databases).
- Ledger verifier (`apps/api/src/lib/ledger-chain.ts`, `pnpm verify-ledger`).

## How to run

```bash
corepack enable && pnpm install
cp .env.example .env
docker compose -f infra/docker-compose.dev.yml up -d db
pnpm migrate && pnpm seed
pnpm dev                       # API :3000, web :5173
pnpm check                     # lint + typecheck + tests + audit
```

DB tests need Docker (Testcontainers) or `TEST_DATABASE_URL` pointing at any Postgres superuser connection; without either they skip with a warning.

## Known gaps (explicitly not Phase 0)

- Everything in Phases 1 to 6 of Doc.md section 15: auth/activation, members/payments/ledger endpoints, SMS parser, importer, notifications, jobs, governance, assets/NAV, reconciliation, archive, backup sidecar, hardening.
- `GET /api/v1/openapi.json` (add with the first resource routes, behind auth) and `kysely-codegen` types (note: Postgres `int8` is parsed to `bigint` by our pool, so generated `Int8` types need a mapping).
- Playwright e2e is not configured yet (first scenario arrives with Phase 1).
- The reference design (`design/Barakah_Fund_UI.html/.pdf`) and `docs/UI-NOTES.md` named in Doc.md 19.6 are not in the repository.
- The Android native project (`apps/web/android`) has not been generated and the release script is untested (`docs/ANDROID.md`).
- App icons are placeholders (`apps/web/scripts/generate-placeholder-icons.mjs`).
- `docs/GO-LIVE.md` lists launch blockers; most items belong to Phases 5 and 6.
