# Phase 3: Governance

Status: **built and green; ready for owner review.**

Governance is built end to end (settings, proposals and voting, executors, member status machine, settlement, new-member entry, charity, contact log, constitution, and the matching screens). The proposal execution pipeline is wired: an approved proposal can be executed by an authorized officer, the correct mutations are applied, and the action is audited.

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

### Also in this phase

- **Settlement view**: `GET /settlements` returns the caller's settlements (all of them for cashier and auditor) with the snapshot numbers and payout plan; `SettlementPage` shows them. Tested in `members/settlement-view.test.ts`.
- **Clause links**: a rule's `clause_ref` links to `/menu/constitution?clause=<ref>`, which opens the matching clause. It matches `clause_no` exactly, so seed clause numbers in the same form as the rule refs.
- **Member status machine and jobs** (`members/status.ts`, `jobs/workers/status.ts`): warning after consecutive unpaid months, final notice, and auto-suspension after `final_notice_days` when `auto_suspend` is on. Tested in `members/status.test.ts`.
- **Settlement, new-member entry, contact log** (`members/settlement.ts`, `members/entry.ts`, `members/contact.ts`).
- **Constitution**: versions, clause search and per-member ack (`routes/constitution.ts`). The member screen (`ConstitutionPage`) reads these endpoints, opens the PDF through an authenticated blob fetch, and lists older versions.
- **Screens**: votes list and detail, admin proposals (executes with a confirmation sheet), members (status history, suspension, reinstatement and settlement proposals, contact log), rules, charity, settings, the owner-conflict banner, and the member notices page (reads the push inbox).
- **e2e**: scenarios (4) and (5) in `e2e/specs/governance.spec.ts` pass. Fixes made while running them: `resumeSession` re-seeded a rotated refresh token on every page load (server treated it as reuse and revoked the session), scenario 5 opened the details dialog over the Execute button, and its "executed" check matched the button label by substring.

## Known gaps

- `ConstitutionPage` shows what is seeded in `constitution_versions`; seeding from the private PDF is an owner step, not in the repo.
- Testcontainers does not start on the owner's Mac (`reading 'bind'`), so a plain `pnpm test` skips the 324 DB tests. Run with `TEST_DATABASE_URL=<superuser url> REQUIRE_DB_TESTS=1`.

- Push/SMS notifications for executed proposals use the existing console providers in dev.

## Review checklist for the owner

1. Confirm `pnpm --filter @barakah/api test` is green.
2. Decide whether executor access rules match the constitution (cashier vs auditor split).
3. Verify the `new_member` stale-valuation guard and NAV-based entry price match the intended policy.
