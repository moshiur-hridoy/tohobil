# Phase 3: Proposal executors

Status: **built and green; ready for owner review.**

The proposal execution pipeline is wired end-to-end: an approved proposal can be executed by an authorized officer, the correct mutations are applied, and the action is audited.

## What was built

### Backend

- **Executor registry** (`apps/api/src/proposals/executors/index.ts`): maps proposal `type` to an executor and centralizes per-type access rules (cashier can execute most proposals; auditor is required for `role_change` and `constitution_amendment`).
- **Executors** (`apps/api/src/proposals/executors/`):
  - `general.ts` — `fine_waiver`, `expense`
  - `financial.ts` — `distribution`, `new_member`, `valuation_update`, `levy`
  - `governance.ts` — `rule_change`, `role_change`, `constitution_amendment`
  - `membership.ts` — `new_member`, `suspension`, `reinstatement`
- **Execution orchestration** (`apps/api/src/proposals/service.ts`): `executeProposal` validates role/finality, re-validates the stored payload against current schemas, calls the executor, persists the result, updates the proposal status (`executed`) and writes an audit record.
- **Route wiring** (`apps/api/src/routes/proposals.ts`): `POST /api/v1/proposals/:id/execute` is guarded for `cashier`/`auditor`; the service enforces per-type auditor-only rules.
- **NAV helper** (`apps/api/src/lib/nav.ts`): `computeNav` used by executors that need current net assets / share counts and stale-valuation detection.
- **Ledger service tweaks** (`apps/api/src/ledger/service.ts`): `postEntries` and `reverseEntry` now accept the generic `Db` client so they can be used inside executor transactions.
- **Test harness fix** (`apps/api/src/test/db-harness.ts`): role creation is now idempotent via a `DO` block so that parallel DB test suites no longer race on `CREATE ROLE`.
- **Shared schemas** were extended where needed for payload inputs and the execute route.

### Tests

- `apps/api/src/proposals/executors.test.ts` covers:
  - fine waiver marks the fine waived and linked to the proposal
  - expense posts correct ledger entries and rejects amounts above the approved maximum
  - rule and role changes update `fund_rules` / user roles
  - distribution splits cash by shares and parks a suspended member’s portion in `MEMBER_ESCROW`
  - new-member quoting refuses to run while asset valuations are stale
  - role-change execution is rejected for a cashier-only actor

Final run (2026-10-20): `pnpm check` green (0 lint errors, 5 expected `no-console` warnings; types pass; shared 76, web 9, api 371 tests pass; audit with one documented ignore).

## How to run

```bash
# Start the dev database if not running
docker compose -f infra/docker-compose.dev.yml up -d db

pnpm --filter @barakah/api test
# or the full quality gate
pnpm check
```

## Known gaps

- e2e proposal execution paths are not yet recorded with Playwright.
- Push/SMS notifications for executed proposals use the existing console providers in dev.

## Review checklist for the owner

1. Confirm `pnpm --filter @barakah/api test` is green.
2. Decide whether executor access rules match the constitution (cashier vs auditor split).
3. Verify the `new_member` stale-valuation guard and NAV-based entry price match the intended policy.
