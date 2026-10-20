# Phase 1: Collection core

Status: **all 6 slices built; waiting for the owner's review** (see "Review checklist for the owner" at the end). Phase 1 was built in vertical slices; this file has one section per slice.

## Slices

- [x] **1. Auth**: activation codes, PIN login, TOTP step-up, devices, security feed, first-cashier CLI; Activation, PIN pad, TOTP and Menu screens
- [x] **2. Members, shares, rules, dues**: member and share reads, own-profile and cashier contact edits, rule lookup by date, account balances, dues generation with auto-applied credit, dues and fines lists, voting-policy seed check
- [x] **3. Ledger, audit log, files**: posting service and reversals, charity routing and NAV exclusion lists, `/ledger` and `/ledger/verify`, `/audit-log`, `POST/GET /files`, idempotency middleware
- [x] 4. Payments: submit, cashier entry, SMS parser, confirm/reject, allocations, reversal approvals
- [x] 5. Matrix, objections, member screens (home, pay, ledger), cashier screens (dashboard, matrix, payments, ledger)
- [x] 6. Importer and verification, e2e scenarios (1) and (2), Section 14 test pass

## Slice 1: what was built

API (`apps/api`):

| Route | Who | Notes |
| --- | --- | --- |
| `POST /auth/activate` | public | member ref + code + device + new PIN; creates the device, returns a session |
| `POST /auth/login` | public | PIN on a registered device; 5 wrong PINs lock 15 min |
| `POST /auth/refresh`, `POST /auth/logout` | refresh token / any | refresh rotates every use; a replayed token revokes the device |
| `POST /auth/totp/enroll`, `/verify` | cashier, auditor | verify opens a 12 h step-up window on that device |
| `GET /me`, `GET /me/devices`, `DELETE /me/devices/:id` | any | |
| `GET /device-events` | any | security feed (who registered, revoked or reset a device) |
| `POST /members/:id/activation-code` | cashier + step-up | `{mode: 'replace' \| 'add'}`; the code is returned once, only its hash is stored |
| `POST /members/:id/unlock` | cashier | clears a PIN lockout |

- Guards in `apps/api/src/auth/guards.ts`: `authenticate`, `requireRole`, `requireWritable` (role A, `auth.read_only`), `requireStepUp`. Later slices use these.
- Schema: `devices.step_up_at` and `activation_codes.mode` were folded into `db/migrations/001_initial-schema.sql` (Doc.md 18.8). **An existing dev database needs the two columns**: either reset it (`docker compose -f infra/docker-compose.dev.yml down -v`, then up, `pnpm migrate`, `pnpm seed`) or run the two `ALTER TABLE` statements.
- Env: `AUTH_RATE_LIMIT_PER_MINUTE` (default 10), `RATE_LIMIT_PER_MINUTE` (default 120).

Web (`apps/web`): API client with refresh-and-retry, `AuthProvider`, `/activate` (member ID + code, then set and confirm PIN), `/login` (PIN pad, or the "device reset needed" screen), `/totp`, and a Menu page with profile, devices, security feed and logout. Route guard sends anonymous users to `/login` (known device) or `/activate`. The design's OTP login screen is replaced per Doc.md 19.1. Bengali and English keys added to both files.

## Slice 2: what was built

API (`apps/api`). Every route needs a logged-in user (role M); only the contact edit is cashier only.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /members?status` | M | every member in code order: shares today, capital, outstanding principal and fines, overdue count, status of this month's monthly due, `under_verification`. Phones only for cashier, auditor and the member themself |
| `GET /members/:id` | M | profile, share holdings and register rows, dues, fines, payments (max 100, `has_more`) and ledger rows (max 100). TrxID, note and rejection reason only for payer, cashier, auditor; raw SMS and proofs never |
| `PATCH /members/me` | M | photo (an existing image file, or `null`) and notification prefs, merged key by key; audited |
| `PATCH /members/:id/contact` | C | name and phone; `409 member.phone_taken`; audited with old and new values |
| `GET /share-register` | M | one row per share with registered name and nominee |
| `GET /share-holdings?member_id&as_of&history` | M | holdings in force on a date (end exclusive) with the total, or the full history |
| `GET /rules?key&as_of&history` | M | the rules in force on a date, one per key (default today), or every version |
| `GET /accounts/balances` | M | the chart of accounts in chart order with raw and natural balances (strings); `FINE_INCOME` is flagged `retired` |
| `GET /dues?period&member_id&status&cursor&limit` | M | derived status, amounts, `under_verification`; newest first, cursor paging |
| `GET /fines?member_id&status&cursor&limit` | M | `unpaid`, `partial`, `paid`, `waived`; cursor paging |

Services and helpers:

- `lib/rules.ts`: `getRule(db, key, asOf)` (greatest `valid_from <= asOf`), typed readers `ruleInt`, `rulePaisa`, `ruleString`, `ruleBool`, `fundTerm`, and the list queries. Always pass the business date the rule is *for*, never "now".
- `dues/service.ts`: `generateDues(deps, {period, kinds?, actor?})`. Idempotent; shares and rules as of the period's first day; `due_day` clamped to the month; nothing after `fund_term_end`; unallocated credit applied to the new dues. Also `pnpm dues:generate [YYYY-MM] [--start-boost]` (this is how dues are created until the Phase 2 scheduler; see ASSUMPTIONS 43 to 46, 51).
- `lib/audit.ts`, `lib/tx.ts`, `lib/money.ts`, `lib/cursor.ts`: audit rows, `inTransaction`, bigint/paisa-string helpers, keyset cursors. `audit` and `inTransaction` moved out of `auth/service.ts` (no behaviour change).
- Shared package: `dateInPeriod`, `DUE_STATUSES`, `FINE_STATUSES`, `boolQuerySchema`, and the query schemas for members, holdings, rules, dues and fines.
- `proposal_policies` was already seeded by migration 001 (Doc.md 18.3). Slice 2 adds the test that pins every row to the spec table. There is no policy route; voting is Phase 3.

No schema change in this slice.

## Slice 3: what was built

**Dev database: reset it.** Slice 3 folds one column (`ledger_entries.reverses_seq`), a unique index and a stricter ledger trigger into `db/migrations/001_initial-schema.sql` (Doc.md 18.8), so an existing dev database must be recreated: `docker compose -f infra/docker-compose.dev.yml down -v`, then `up -d db`, `pnpm migrate`, `pnpm seed`.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /ledger?from&to&account&member_id&ref_type&ref_id&order&cursor&limit` | M | rows with hash, who posted, reversal links both ways, open-objection badge; keyset paging on `seq`, newest first |
| `GET /ledger/verify` | M | recomputes the whole chain: `{ok, count, last_seq, last_hash, issues_total, issues[]}`; 6 calls a minute |
| `GET /audit-log?actor_user_id&action&entity_type&entity_id&from&to&cursor&limit` | C, U | newest first; `from`/`to` are Asia/Dhaka days |
| `POST /files` | A | multipart, one file, max 10 MB; JPEG, PNG, WebP, PDF by sniffing; `201` with id, sha256, size, size in pixels; honours `Idempotency-Key` |
| `GET /files/:id?thumb=true` | M | access by what the file is attached to (ASSUMPTIONS 57); proof views audited |

There is deliberately **no route that posts or reverses a ledger entry**: postings happen inside the transaction of the business action that causes them (slice 4 onwards).

Code:

- `ledger/service.ts`: `postEntries(tx, entries, actor)` (the only code that inserts ledger rows: validation, readable errors, all-or-nothing), `reverseEntry`, `reverseReference(tx, 'payment', paymentId, ...)`. Call them with the client of an open READ COMMITTED transaction.
- `ledger/postings.ts`: pure builders. `paymentPostings` (principal and credit to `MEMBER_CAPITAL`, **fines to `CHARITY_PAYABLE`**), `ribaReceivedPosting` (interest is charity money), `autoChargePosting` (the one posting allowed without a vote, tagged `auto_charge`).
- Shared: `NAV_CASH_ACCOUNTS`, `NAV_DEDUCTION_ACCOUNTS` (the accounts that never raise NAV, 18.4), `FILE_MAX_BYTES`, ledger and audit-log query schemas. A test checks the NAV lists against the seeded chart of accounts, so a new liability account cannot be forgotten.
- `lib/idempotency.ts`: `withIdempotency(deps, req, reply, userId, fingerprint, run)`; later create endpoints wrap their handler in it.
- `files/`: `process.ts` (sniffing, re-encoding, thumbnails), `storage.ts` (content-addressed store under `FILES_DIR`, atomic writes), `service.ts` (upload, authorise, open).
- Env: `FILES_DIR` (default `data/files`; the production compose sets `/data/files`), `UPLOAD_RATE_LIMIT_PER_MINUTE`.
- Audit: added rows for PIN login, TOTP enrolment start and step-up; security views (device list, feed) are now logged as sensitive reads (19.4).
- Schema: see the reset note above. The trigger now also checks that a reversal mirrors its original.

## Slice 4: what was built

**Dev database:** slice 4 folds one change into `db/migrations/001_initial-schema.sql` (`v_due_status.last_paid_on` counts only confirmed payments). Either reset the dev database as in slice 3, or run just the view: `docker exec -i infra-db-1 psql -U barakah_migrator -d barakah` and paste the `CREATE OR REPLACE VIEW v_due_status` statement from the migration.

| Route | Who | Notes |
| --- | --- | --- |
| `POST /payments` | A | member says "I have sent money"; the payer is always the caller; `Idempotency-Key`; duplicate TrxID is `409 payment.duplicate_trx` with `existing_payment_id`; proof must be the caller's own upload; stays `pending` and touches nothing |
| `GET /payments?status&member_id&cursor&limit` | M | everyone sees who paid what and the status; TrxID, note, reject reason and proof only for the payer, cashier, auditor |
| `GET /payments/:id` | M | adds the allocations, the raw SMS (payer, cashier, auditor; audited as `payment.view_raw_sms`) and, for the cashier on a pending payment, a `preview` of what confirming will do |
| `POST /payments/cashier-entry` | C + step-up | create and confirm in one step (`sms_match` when an SMS is attached); the member is notified |
| `POST /payments/parse-sms` | C | read a pasted message and suggest the pending payment it belongs to; never throws |
| `POST /payments/:id/confirm` | C + step-up | one transaction: mark confirmed, allocate (default or manual list), post the ledger, audit, queue the member's notification |
| `POST /payments/:id/reject` | C + step-up | reason of 3+ characters; the TrxID can be submitted again |
| `POST /payments/:id/reverse-request` | C | opens an approval item |
| `GET /approvals?status&kind` | C, U | requests with who asked and the payment concerned |
| `POST /approvals/:id/approve`, `/reject` | U + step-up | approve reverses the ledger entries, adds negative allocation rows, marks the payment `reversed`; nobody decides their own request |

Code: `payments/service.ts` (everything above), `payments/allocation.ts` (pure planners: default `oldest_principal_then_fines`, manual list validation), `payments/sms-parser.ts` (bKash receive, bKash cash in, bank deposit, a guessed Nagad shape), `routes/payments.ts`. Confirm uses `paymentPostings` from slice 3: principal and credit to `MEMBER_CAPITAL`, fines to `CHARITY_PAYABLE`. See ASSUMPTIONS 61 to 67 and 78.

## Slice 5: what was built

API: `GET /matrix?from&to` (M, member x month grid with row and column totals, default the 12 months ending now), `POST/GET /objections` and `PATCH /objections/:id` (A creates, everyone reads, the auditor answers), `GET /settings/payment-instructions` (M, read-only). See ASSUMPTIONS 68, 69, 77.

Web (`apps/web`). Everything reads the API; no figure is typed in. Every money action goes through `ConfirmSheet` (summary of the effect, waits for the server, shows the Bengali message and the request id on failure, links to the authenticator screen when a step-up is missing). No optimistic updates.

| Screen | Route | What it does |
| --- | --- | --- |
| Home | `/home` | outstanding principal and fines, next due date, "under verification" state, interim net assets, my capital, charity balance, everyone's status this month, pull to refresh |
| Pay | `/pay` | my open dues and fines, how-to-pay card with copy buttons, "I have sent money" form (amount, method, TrxID, date, month hint, screenshot) with a confirmation sheet and an idempotency key per attempt, payment history with receipts |
| Ledger | `/menu/ledger` | filters, hash, reversal links both ways, objection badge and an Object button, chain check |
| Members | `/menu/members` | members, shares, capital, outstanding, share register |
| Dashboard | `/admin` | net assets (interim), collected vs expected this month, overdue members, pending payments, open approvals and objections, charity money, ledger chain |
| Matrix | `/admin/matrix` | member x month grid with legend, cell details, totals, month range, CSV export |
| Payments | `/admin/payments` | queue with filters and proof thumbnails, paste SMS (several at once), exact and possible matches, cashier entry, approve and reject sheets, bulk approve of exact matches, J/K/A/R keys, reversal requests, and the auditor's approvals tab |
| Ledger (staff) | `/admin/ledger` | dense table with running balance per account (one account, no date filter), CSV export and the open objections the auditor answers |

Shared pieces: `ConfirmSheet`, `PullToRefresh`, skeletons, `LoadError`/`Empty`, `StatusPill` (colour plus word plus glyph), `AuthedImage` (proofs need the bearer token), `lib/money.ts` (bigint only; no floats), `lib/csv.ts`. Bengali and English keys for all of it, with `{{placeholders}}`, and counts go through the digit setting.

**Bug fixed on the way:** in development React StrictMode ran the session-restore effect twice, sent the same refresh token twice, and the server's reuse detection revoked the device, so a page reload logged you out. The refresh is now single flight (`lib/auth.tsx`).

## Slice 6: what was built

- **Importer** (`apps/api/src/import/`, CLI wrappers in `scripts/import-sheet/`, fake fixtures in `scripts/import-sheet/fixtures/`). `pnpm import:convert` turns the legacy tabs into the normalized CSVs of Doc.md 13 plus `import/review.csv`; `pnpm import:load` validates them with zod and loads through the same posting and allocation code the API uses (dry run unless `--commit`, local databases only, refuses duplicate TrxIDs); `pnpm import:verify` fails with a clear report when per-member totals, cash balances, the ledger chain or TrxID uniqueness are off. Gold purchases default to `BANK` and are flagged. See ASSUMPTIONS 70 to 76.
- **End-to-end tests** (`e2e/`, run with `pnpm e2e`, needs Docker Postgres and Chrome): (1) activation code, PIN set, PIN login, on a phone and a desktop viewport; (2) member submits, cashier pastes the bKash SMS, exact match, approves through the sheet, member sees it confirmed with a receipt, ledger shows the entry and the chain verifies. `E2E_SHOTS=1 pnpm e2e` saves screenshots to `e2e/test-results/shots`. See ASSUMPTIONS 79.
- **Section 14 pass.** Money (shared tests), dues (`dues.test.ts`), payments (`routes/payments.test.ts`, `payments/*.test.ts`), SMS parser, ledger (`ledger/*.test.ts`, `routes/ledger.test.ts`), auth (`routes/auth.test.ts`, plus the role table in `routes/roles.test.ts`) all pass. Fine and job cases (the 20th/21st, simulated year) belong to Phase 2, which owns `apply_fines`.

## How to try it (slices 4 to 6)

```bash
pnpm activation-code M01 --code=12345678   # local only: a fixed 8-character code for easy testing
pnpm dues:generate                          # this month's dues
pnpm dev                                    # http://localhost:5173/activate
pnpm e2e                                    # the two scenarios, against a throwaway database
pnpm import:verify                          # importer check on the fixtures
```

Log in as M01 (cashier; enrol the authenticator on the Menu tab), issue codes for M02 to M08 (cashier tools: API or `pnpm activation-code`), pay as a member on `/pay`, then confirm on `/admin/payments` (desktop width, or the stacked mobile layout).

## Tests added in slices 4 to 6

`payments/sms-parser.test.ts`, `payments/allocation.test.ts`, `routes/payments.test.ts` (pending touches nothing, duplicate TrxID, resubmission after rejection, idempotent replay, proof ownership, step-up, oldest-first allocation, fine to charity money and credit, double and parallel confirm, manual allocation validation, cashier entry and locked-month dating, visibility rules, raw SMS audit, reversal approval restoring outstanding and the books, rejected and self-decided requests, fine reopening, locked-period reversal dating, parse-sms matching, invariants), `routes/matrix-objections.test.ts`, `routes/roles.test.ts` (role table for every new route), `apps/api/src/import/import.test.ts`, `apps/web/src/lib/money.test.ts`, and the two Playwright scenarios.

Final run (2026-10-20): `pnpm check` green (lint 0 errors, 5 `no-console` warnings in the CLI scripts; typecheck; shared 76, web 9, api 321 tests across 19 files; audit with the one documented ignore). `pnpm e2e` 3 of 3 passed.

## Known gaps in slices 4 to 6

- Notifications are only queued (`notifications` rows); delivery, reminders, the pause while a payment is pending and the auditor push come in Phase 2. Fines are not created yet (`apply_fines` is Phase 2), so the fine paths are tested with fines inserted directly.
- Net assets and "my share value" are interim figures (cash plus assets at cost, minus what is owed to others; capital). `GET /nav` and valuations are Phase 4.
- `levy` and `settlement_shortfall` payments are refused until their phases; the Nagad SMS wording is a guess (ASSUMPTIONS 67).
- No period locks yet, so objections do not block locking and the reconciliation screen is empty (Phase 5). The CSV exports on the matrix and ledger are made in the browser and are not audited; the server-side exports of Phase 5 will be.
- The cashier's other admin pages (members, proposals, assets, rent, notifications, reconcile, reports, rules, system) are still placeholders and arrive with their phases.
- The importer has only been run on fake fixtures; real sheet exports will probably need layout tweaks, and a `--commit` against the dev database has not been done (the fixture members clash with the seed).
- Accessibility pass (200 percent font scaling, contrast audit) and the Bengali copy review are Phase 6.

## Review checklist for the owner

1. Run `pnpm e2e` and click through `/home`, `/pay`, `/admin/payments`, `/admin/matrix`, `/admin/ledger` at phone and desktop width.
2. Decide the open items: the cashier confirming their own payment (ASSUMPTIONS 63), the Nagad SMS wording (67), and the interim net assets figure (77).
3. Supply a real (anonymised) sheet export so the converter can be fitted to it.

## How to try it (slices 1 to 3)

```bash
pnpm migrate && pnpm seed
pnpm activation-code M01        # prints an 8-character code (valid 24 h, single use)
pnpm dev                        # open http://localhost:5173/activate
```

Enter `M01`, the code, then choose a PIN twice. M01 is the seeded cashier; use the Menu tab to enrol an authenticator, after which M01 can issue codes for the other members (M02 to M08) through `POST /members/:id/activation-code`. There is no cashier screen for that yet (slice 5); until then use the API or the CLI.

From slice 2, create the current month's dues (safe to run twice) and read them through the API with the session's bearer token, for example `GET /api/v1/members` and `GET /api/v1/dues`:

```bash
pnpm dues:generate              # current Asia/Dhaka period
```

## Tests

`apps/api/src/routes/auth.test.ts` (real Postgres): code expiry, single use, 5-attempt limit, new code invalidates old, weak PIN rejected, PIN and code never stored or audited in clear, same error for unknown member and wrong PIN, lockout and cashier unlock and timed expiry, device limits (member 1, cashier 2), replacement revokes devices and refresh tokens, refresh rotation and reuse detection, logout, TOTP enrolment and step-up (including per-device), role checks, the app role cannot delete audit rows.

Slice 3 tests (real Postgres): `apps/api/src/ledger/ledger.test.ts` (posting validation and stable error codes, all-or-nothing groups, locked periods, READ COMMITTED guard, 30 parallel postings keep the chain linear, charity routing, reversal balances and links, one reversal even under a race, reversal dating, database refusal of a non-mirroring reversal, NAV lists vs chart of accounts, the app role cannot update or delete financial rows), `ledger/postings.test.ts`, `routes/ledger.test.ts` (filters, both-way reversal links, objection badge, paging that survives new postings, verify, **tamper detection by a superuser: edit and delete**), `routes/audit-log.test.ts` (access, filters, paging, a walk over every write endpoint asserting an audit row, secrets never logged, sensitive reads logged and ordinary reads not), `routes/files.test.ts` (EXIF stripped and orientation applied, type sniffing, 10 MB limit exactly, content addressing, name sanitising, access rules, proof audit, thumbnails, upload rate limit, idempotency including races, expiry and crash takeover), and `packages/shared/src/nav-accounts.test.ts`.

Slice 2 tests (real Postgres): `apps/api/src/dues/dues.test.ts` (amounts per share, due dates, Asia/Dhaka period boundary, idempotency, share snapshot at period start, excluded statuses, rule changes by `valid_from`, start boost, fund term end, credit auto-allocation, rule lookup), `apps/api/src/routes/members.test.ts` (auth on every route, phone and payment-detail visibility, profile and contact edits with audit, register and holdings, rules, balances, dues and fines filters and paging), `apps/api/src/db/proposal-policies.test.ts` (policy table and weight columns), and `dateInPeriod` in `packages/shared`.

## Known gaps in slice 3

- Nothing calls the payment posting builders or `reverseReference` yet; slice 4 (confirm, reversal approval) is their first user, and the allocation and posting happen there in one transaction.
- Permitted bank profit (`BANK_PROFIT`) and the "compliance pack off" mode are not built (ASSUMPTIONS 55).
- No cleanup of expired idempotency rows and no garbage collection of unreferenced file blobs (jobs arrive in Phase 2 and 5).
- `GET /ledger/verify` is not yet recorded anywhere for `/system/status` (Phase 5).
- PDFs are stored unmodified (ASSUMPTIONS 56). Virus scanning is out of scope.
- The web app has no upload or ledger screen yet (slice 5).

## Known gaps in slice 2

- `v_due_status` judges `overdue` by the database date, not the injectable `Clock` (ASSUMPTIONS 50). It matters for the Phase 2 simulated-year test.
- Photo upload itself needs `POST /files` (slice 3); `PATCH /members/me` accepts a file id that already exists.
- Phones are returned only to cashier, auditor and the owner of the number; there is no screen for any of this yet (slice 5).
- `GET /members/:id` caps payments and ledger rows at 100; the full lists come with `/payments` (slice 4) and `/ledger` (slice 3).

## Known gaps in slice 1

- No browser (Playwright) test of the screens yet; the first e2e scenario arrives with slice 5. The screens were only type-checked, linted and exercised through the API.
- Activation QR scanning (camera) is not built; the code is typed. `/activate?ref=M01&code=...` works for a deep link.
- Device events do not notify the auditor yet (push is Phase 2); they are in the feed and the audit log.
- See ASSUMPTIONS 36 to 42.
