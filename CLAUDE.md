# Barakah Fund System

## Quick Reference

- **Spec**: [`Doc.md`](./Doc.md) is the authoritative build specification. Sections 18 (constitution) and 19 (design-review amendments) override earlier sections.
- **Rule**: NEVER mutate or delete financial records. Corrections are reversal entries only. Database triggers enforce this; do not work around them.
- **Money**: All amounts are bigint paisa. No floats. Ever. On the wire (JSON) and inside jsonb payloads, paisa is a decimal **string**; the zod schemas in `packages/shared` convert to/from bigint.
- **Dates**: business dates are `YYYY-MM-DD` strings in Asia/Dhaka, never JS `Date` objects. Anything that depends on "now" takes an injectable `Clock`.
- **Language**: user-facing text is Bengali via i18n keys (English fallback, same keys in `bn.json` and `en.json`). Code, comments, docs and commits are English.
- **Phases**: build one phase at a time (Doc.md section 15), finish it with green tests and a `docs/PHASE-N.md`, then stop for owner review. Current status: see `docs/PHASE-0.md`.
- Where the spec is silent, choose the conservative option, make it a rule or adapter, and record it in `docs/ASSUMPTIONS.md`. Never run against production from a dev session.

## Commands

```bash
# Install dependencies (Node >= 22, pnpm 9.15 via `corepack enable`)
pnpm install

# Start dev stack (Postgres + API + Web)
cp .env.example .env
docker compose -f infra/docker-compose.dev.yml up -d db
pnpm migrate            # needs MIGRATOR_DATABASE_URL (see .env.example)
pnpm seed               # fictional fixture; refuses non-local databases
pnpm dev                # API on :3000, web on :5173 (proxies /api)
pnpm dues:generate      # dues for the current period (or `2026-11`); idempotent, until the Phase 2 scheduler

# Run tests (DB tests use Testcontainers, which needs Docker;
# or point TEST_DATABASE_URL at any Postgres superuser connection).
# Without either they SKIP with a warning; set REQUIRE_DB_TESTS=1 (CI does this implicitly) to make that a failure.
pnpm test

# Full quality check (lint + types + tests + audit)
pnpm check

# Create a new migration (SQL). Before the first release, fold schema changes into
# db/migrations/001_initial-schema.sql instead (Doc.md 18.8).
pnpm migrate:create my-migration

# Verify the ledger hash chain (uses READONLY_DATABASE_URL, else DATABASE_URL)
pnpm verify-ledger

# End-to-end scenarios (Playwright + installed Chrome; builds a throwaway barakah_e2e database)
pnpm e2e

# Fixed activation code for local testing (8 chars; refused in production or on a non-local database)
pnpm activation-code M01 --code=12345678

# Legacy sheet importer: convert tabs to CSV, dry-run load (add --commit), verify the totals
pnpm import:convert && pnpm import:load && pnpm import:verify
```

## Layout

`apps/api` Fastify API (bundled with esbuild for production) · `apps/web` React PWA + Capacitor · `packages/shared` zod schemas, money/date utils, enums, i18n · `db/` migrations + seed · `infra/` Docker · `docs/` runbook, assumptions, phase notes, audit.
