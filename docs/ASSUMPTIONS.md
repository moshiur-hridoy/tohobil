# Assumptions Register

Where the spec (`Doc.md`) was silent or ambiguous, the build chose the most conservative option and recorded it here. Each lives in a rule, a setting or one isolated module so it can change later.

**Status column**: what actually exists today. "Seeded" = the rule/setting row exists in the baseline migration. "DB" = enforced by the schema. Anything marked with a later phase is **not built yet**; an earlier version of this table marked every row "Implemented", which was not true.

## From the spec (Doc.md section 16)

| #   | Assumption                                                                                       | Where it lives                     | Status                                                                                 |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | One fine per late due, never compounding                                                         | 5.5                                | DB: unique index `fines_one_per_due`. Job: Phase 2                                     |
| 2   | Fines enter the ledger only when paid (cash basis)                                               | 5.5, 18.2                          | DB: `FINE_INCOME` retired by trigger. Posting logic: Phase 1                           |
| 3   | Payment allocation is oldest principal, then fines                                               | rule `allocation_order`            | Seeded. Logic: Phase 1                                                                 |
| 4   | Settlement uses a fresh NAV quote at proposal creation                                           | 5.10                               | Phase 3                                                                                |
| 5   | The subject of a suspension, settlement, reinstatement, fine waiver or role change does not vote | 5.8                                | Phase 3                                                                                |
| 6   | Votes are public and changeable until close                                                      | 5.8                                | DB: `votes` append-only except `superseded_at`. Logic: Phase 3                         |
| 7   | Early close only when the outcome is decided                                                     | 5.8                                | Phase 3                                                                                |
| 8   | The Android shell loads the web app from the server URL                                          | 8                                  | Configured (`capacitor.config.ts`). APK: Phase 2                                       |
| 9   | PIN is 6 digits. ~~OTP valid 5 minutes~~                                                         | 19.1                               | **OTP removed by 19.1** (no SMS login, no `otp_codes`). PIN rules in `packages/shared` |
| 10  | Quiet hours 21:00 to 08:00 for non-critical notifications                                        | 10                                 | Phase 2                                                                                |
| 11  | Reminders pause while a payment is pending verification                                          | 9                                  | Phase 2                                                                                |
| 12  | Reinstatement catch-up charges no fines by default                                               | rule `reinstatement_charges_fines` | Seeded. Logic: Phase 3                                                                 |
| 13  | A negative settlement blocks until the shortfall is settled                                      | 5.10                               | Phase 3                                                                                |
| 14  | Rent receipts and stream setup need no vote; maintenance spending does                           | 5.11                               | Phase 4                                                                                |
| 15  | Imported gold purchases default to source account `BANK` and are flagged                         | 13                                 | Phase 1 (importer)                                                                     |
| 16  | Cutover date 1 Jan 2027                                                                          | 13                                 | Configurable                                                                           |
| 17  | SMS gateway is a generic HTTP adapter                                                            | 2, 12                              | Env keys only (default off, 19.1). Adapter: Phase 2                                    |
| 18  | Sheet mirror optional, off by default                                                            | 12                                 | Env key only. Job: Phase 5                                                             |
| 19  | Other members' phone numbers are hidden from regular members                                     | 11                                 | Phase 1 (API)                                                                          |
| 20  | An automation backup key is held on the server for restore tests                                 | 12                                 | Phase 5                                                                                |
| 21  | Entry quote valid 7 days; stale valuations block quoting                                         | 5.9                                | Phase 3                                                                                |
| 22  | Exactly one cashier and one auditor, never the same person                                       | 5.1                                | DB: partial unique indexes + check on `users`. Role-change flow: Phase 3               |

## Added during the Phase 0 audit

| #   | Assumption                                                                                                                                                                                                                                            | Where it lives                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 23  | `divRound` rounds half **away from zero** (symmetric): for positive numbers this is exactly "round half up", and `divRound(-a, b) = -divRound(a, b)` so reversing a computed amount nets to zero                                                      | `packages/shared/src/money.ts`                |
| 24  | Money in JSON bodies, responses and jsonb payloads is a decimal **string** of paisa (JSON has no bigint; `z.bigint()` could never parse a request)                                                                                                    | `packages/shared/src/schemas/common.ts`       |
| 25  | `paid_late` compares the _payment's_ `paid_at` (Asia/Dhaka date) with `due_date`, not the allocation row's insert time, so imported history is not all "late"                                                                                         | `v_due_status`                                |
| 26  | Liability/equity/income balances are read from `v_account_balances.natural_balance_paisa`; `balance_paisa` is the raw debit-minus-credit                                                                                                              | `v_account_balances`                          |
| 27  | The _first_ cashier cannot be activated through the app (activation needs a cashier with TOTP). Phase 1 ships a server-side CLI that issues the first activation code; seeded users start as `pending_activation`                                     | Phase 1                                       |
| 28  | Hardening beyond the spec's list: `dues`, `device_events`, `charity_donations` are append-only; `payments`, `fines`, `members`, `proposals`, ... cannot be deleted; payment core fields are immutable; allocations are bounds-checked in the database | migration 001                                 |
| 29  | CSP `style-src 'self'` (no `unsafe-inline` for stylesheets); only `style-src-attr` allows inline style attributes, which React needs                                                                                                                  | `apps/api/src/app.ts`                         |
| 30  | Capacitor 8 (current stable, as the spec asks); the original `^6.2` pins for `@capacitor/push-notifications` did not exist                                                                                                                            | `apps/web/package.json`                       |
| 31  | `land_selection` and `project_closure` are added as generic share-basis proposal types (the 18.3 table lists them without a type name)                                                                                                                | `proposal_policies`, `enums.ts`               |
| 32  | Rule `max_devices_privileged` = 2 (cashier and auditor: phone plus desktop, 19.1)                                                                                                                                                                     | rules seed                                    |
| 33  | The `backup` compose service has no image until Phase 5, so `docker compose up` fails loudly rather than running without backups                                                                                                                      | `infra/docker-compose.yml`, `docs/GO-LIVE.md` |
| 34  | Ledger postings require READ COMMITTED; the trigger raises under REPEATABLE READ/SERIALIZABLE because a stale snapshot would fork the hash chain                                                                                                      | `ledger_hash_chain`                           |
| 35  | API responses are `Cache-Control: no-store`; the service worker caches only an allowlist of read-only GETs (and must clear that cache on logout: Phase 1)                                                                                             | `app.ts`, `api-cache-matcher.ts`              |

## OWNER DECISION items (Doc.md 18.12)

These require group resolution. Until resolved, the stated default is used and a conflict banner is shown to the cashier and auditor (banner UI: Phase 3).

1. Due day / fine day conflict (clauses 2.1 vs 2.2): default `due_day=20`, `fine_day=21`.
2. Member / share count (constitution 7/19 vs sheet 8/20): default use actual holdings.
3. Fine waivers (the fine is charity money): default keep, with a warning on the form.
4. Suspended members' profit rights: default keep (distributions go to escrow).
5. Amendment procedure: default unanimous.
6. "Majority" in 12.2: default share-weighted.
7. Where the 10% early-exit charge goes: default fund income (`EXIT_FEE_INCOME`).
8. Capital ratio vs share ratio: default share ratio (NAV-based).
9. Replace sheet/WhatsApp with the app (3.2, 3.3): record with a `constitution_amendment`.
10. "Start Boost" as a contribution change (1.4): record with a proposal.
11. Wind-up procedure: default `wind_up` proposal, share basis.
12. Absence fine per member or per share: default per member.
13. Final-notice period length: default 7 days.
