# Barakah build checklist

Serial order. Source of truth is `Doc.md` (sections 15, 18, 19). Each phase ends with green `pnpm check`, a `docs/PHASE-N.md`, and a stop for owner review. Within a phase, finish slices in order.

Legend: `[x]` done, `[ ]` to do.

---

## Phase 0: Scaffolding
- [x] Monorepo, tooling, Docker dev stack, baseline migration, health route, theme and i18n skeleton, `CLAUDE.md`
- [x] Audit fixes (`docs/AUDIT-PHASE-0.md`)

## Phase 1: Collection core

### Slice 1: Auth (done)
- [x] Activation codes (create, hash, expiry, single use, 5 attempts, new code invalidates old)
- [x] PIN login, 15 min lockout, cashier unlock
- [x] Refresh rotation and reuse revocation, logout
- [x] TOTP enrol and 12 h step-up, per device
- [x] Device limits (member 1, cashier/auditor 2) and device events feed
- [x] First-cashier CLI (`pnpm activation-code M01`)
- [x] Screens: activation, set PIN, PIN pad, device-reset, TOTP, menu (profile, devices, feed, logout)
- [x] Auth integration tests

### Slice 2: Members, shares, rules, dues (done)
- [x] `GET /members`, `GET /members/:id` (phones hidden from regular members)
- [x] `PATCH /members/me` (photo, notification prefs, digits); `PATCH /members/:id/contact` (cashier, audited)
- [x] `GET /share-register`, share holdings reads
- [x] `GET /rules` and rule lookup helper by date (`valid_from`), `fund_term_*` rules
- [x] Chart of accounts, `GET /accounts/balances`
- [x] Dues generation for a period (monthly, start boost), `GET /dues`, `GET /fines`
- [x] `proposal_policies` seed and schema check (voting UI is Phase 3)
- [x] Tests: dues amounts per share, due dates (Asia/Dhaka), idempotent generation, rules by date

### Slice 3: Ledger, audit log, files (done)
- [x] Ledger posting service (double entry, bigint paisa, hash chain via triggers, READ COMMITTED)
- [x] Charity account and fine routing (18.2), NAV exclusions list
- [x] Reversal entries (never mutate or delete)
- [x] `GET /ledger` (filters, cursor), `GET /ledger/verify`
- [x] Audit log writes for every write; sensitive reads only (19.4); `GET /audit-log` (cashier, auditor)
- [x] `POST /files`, `GET /files/:id` (10 MB, image/PDF, EXIF stripped, sha256 content addressing, thumbnails)
- [x] Idempotency-key middleware
- [x] Tests: hash chain, tamper detection, reversal balances, file size/type limits, app role cannot update or delete financial rows

### Slice 4: Payments (done)
- [x] `POST /payments` (member submission, duplicate TrxID, method labels per 19.3)
- [x] `POST /payments/cashier-entry`
- [x] `POST /payments/parse-sms` (bKash, Nagad, bank formats) and suggested matching
- [x] `POST /payments/:id/confirm` and `/reject` (step-up)
- [x] Allocation: oldest principal then fines (`allocation_order` rule), partial payments, overpayment handling
- [x] Reversal request by cashier, approval by auditor (`/approvals/:id/approve|reject`)
- [x] `GET /payments` visibility rules (raw SMS and proofs only to payer, cashier, auditor)
- [x] Tests: allocation, late fine on payment, duplicate TrxID, reversal approval, parser fixtures

### Slice 5: Matrix, objections, screens (done)
- [x] `GET /matrix?from&to` (status, due, paid, fine, pending per cell)
- [x] `POST /objections`, `GET /objections`, `PATCH /objections/:id`
- [x] Member screens: Home (real numbers, under-verification state, everyone's month status), Pay (dues, how-to-pay copy buttons, "I have sent money" form, history), Menu extras (ledger, objection button, members and shares list)
- [x] Cashier screens: Dashboard, Matrix (+CSV), Payments queue (J/K/A/R keys, paste SMS, bulk approve), Ledger
- [x] Confirmation sheet for every money action, no optimistic UI, error code mapping with request id
- [x] Loading skeletons, empty states, pull-to-refresh
- [x] Playwright set up; e2e scenario (1) member submits and cashier confirms

### Slice 6: Importer, verification, close-out (done, awaiting owner review)
- [x] Legacy sheet importer and `pnpm import:verify` on fixtures (gold purchases default to BANK, flagged)
- [x] e2e scenario (2)
- [x] Section 14 cases for money, dues, payments, ledger, auth all pass
- [x] Seeded stack demonstrable end to end
- [x] `docs/PHASE-1.md` finalised, `pnpm check` green, **stop for owner review**

## Phase 2: Notifications and automation
- [x] Notification engine, templates and channel policy (`notifications/catalog.ts`, `notifications/service.ts`)
  - [x] Templates: `due_reminder`, `fine_notice`, `payment_submitted_ack`, `payment_confirmed`, `payment_rejected`, `final_notice`, `meeting_reminder`, etc.
  - [x] Quiet-hours guard and SMS opt-out handling
  - [x] Pause reminders while a payment is pending
- [x] FCM push (`firebase-admin`), console fallback, and device token registration (`POST /devices`)
- [x] `SmsProvider` (console, generic HTTP), `sms_enabled=false` default
- [x] In-app inbox: `GET /notifications`, `POST /notifications/:id/open`
- [x] pg-boss scheduler and core jobs (`jobs/index.ts` + workers)
  - [x] `send-notifications`, `sms-fallback`, `generate-dues`, `apply-fines`, `remind-dues`, `notify-fines`, pending-payment alert, cleanup
  - [x] Final-notice / auto-suspension jobs (built in Phase 3)
- [x] Auditor push on device events
- [x] Cashier "not reachable by push" list; `GET /notifications/admin`; `POST /notifications/nudge` (1 per member per 6 h)
- [x] Admin notifications page (web UI)
- [ ] PWA update behaviour verified (prompt, old caches cleared)
- [ ] (optional, later; members use the installable web app meanwhile) Capacitor Android build, secure storage for refresh token and install id, push permission rationale, deep links
- [ ] (optional, later, Android only) Onboarding screens (battery optimisation, autostart by brand), repeat after 3 days
- [x] `GET /app/version`
  - [ ] In-app update banner
  - [ ] (optional, later) `pnpm android:release` tested
- [x] Simulated-year jobs test; e2e scenario (3)
- [ ] (optional, later) Signed debug APK installs and receives a test push (manual checklist in `docs/PHASE-2.md`)
- [ ] `docs/PHASE-2.md`, **stop for owner review**

## Phase 3: Governance
- [x] Settings table and settings routes (payment instructions etc.)
- [x] Proposals: create, open, close early, cancel, vote, execute (`proposal_policies`, weighted and unanimous voting, subject excluded)
- [x] Executors per proposal type; `rule_change` and `role_change` (auditor executes)
- [x] Member status machine (`inactive`, warning, suspended, exited), final notice and auto-suspension
- [x] Suspension, reinstatement, settlement (kinds per 18.6), escrow payouts, member snapshots
- [x] New-member entry (share price quote, entry due, register update)
- [x] Charity donations flow and statement inputs
- [x] Contact log
- [x] Constitution tab: versions, clause search, "I have read it", PDF link (seeding from the private file is an owner step)
  - [x] Clause links from rules (`?clause=` on the constitution page; matches `clause_ref` to `clause_no` exactly)
- [x] Member screens: votes list and detail (countdown, voter list, big Yes/No/Abstain)
- [x] Member settlement screen (`GET /settlements`: own settlements, everyone's for cashier and auditor)
- [x] Cashier screens: proposals (checklists), members (status history, actions create proposals), rules
- [x] Owner-decision conflict banner (18.12)
- [x] Tests: voting, suspension, settlement, invariants; e2e scenarios (4) and (5)
- [x] `docs/PHASE-3.md`, **stop for owner review**

## Phase 4: Assets and NAV (done)
- [x] Assets, valuations, documents (`GET /assets`, `/assets/:id/valuations`, `/assets/:id/documents`). A cashier can only note down a `planned` asset; cost, status, sale and valuation move only through proposals, staged payments or completion
- [x] Acquiring assets in NAV at amount paid so far (19.2); sold assets excluded
- [x] `GET /nav` with breakdown, deductions and stale-valuation list
- [x] Rent streams, expected rent, receipts (`GET/POST /rent/streams`, `/rent/expected`, `/rent/expected/:id/receive`, `/rent/expected/generate`), single source `rent_expected`
- [x] Sale, distribution and escrow payout through approved proposals (`asset_sale`, `distribution`, settlement payouts); no direct sale route by design
- [x] Staged payments on land or a house (`POST /assets/:id/payments`) and completion (`POST /assets/:id/complete`: needs a note, a document, and for land or a house a deed and an ownership split covering every share)
- [x] Compliance checklist and feasibility file enforced when an investment is opened for voting
- [x] Levy (`asset_cost_levy` creates levy dues, payments with purpose `levy` go to `LEVY_CLEARING`, `POST /levy/remittances`), `member_qard`, `financing_arrangement` (instalments, `POST /financing/instalments/:id/pay`), wind-up (stops dues and new members)
- [x] Property title fields (`legal_owner_name`, `ownership_split`)
- [x] Member screens: assets list and detail / NAV page
- [x] Cashier screens: assets, rent, obligations (levy and deferred purchases), and a proposal form for every proposal type
- [x] NAV tests, asset/rent lifecycle tests, obligations tests (levy, qard, financing, wind-up, staged purchase, no-loan check)
- [x] New-member NAV invariance test (`members/entry.test.ts`)
- [x] `docs/PHASE-4.md`

## Phase 5: Audit and operations
- [ ] Reconciliation entry, auditor approval, period locks
- [ ] Annual archive (PDF summary + CSVs, including charity statement), zakat statement, annual audit sign-off
- [ ] PDF statements (Bengali font), CSV exports (`/reports/*`), export audit logging
- [ ] Ledger verify page, `GET /system/status`, system status screen
- [ ] Backup and restore sidecar, restore test job, runbook, recovery kit
- [ ] Optional sheet mirror (off by default)
- [ ] Tests: restore on seeded data, tamper detection, archive for the fixture year
- [ ] `docs/PHASE-5.md`, **stop for owner review**

## Phase 6: Hardening and handover
- [ ] Security checklist and dependency audit
- [ ] Performance sanity: p95 under 300 ms on main endpoints with 100k ledger rows
- [ ] Accessibility pass on member screens (contrast, 200 percent font scaling)
- [ ] Bengali copy review list
- [ ] OpenAPI at `/api/v1/openapi.json` and `kysely-codegen` types (int8 mapping)
- [ ] Final docs, `docs/GO-LIVE.md` checklist complete
- [ ] All tests green, **stop for owner review**

---

## Outside the phases (owner or manual)
- [ ] Owner decisions list (Doc.md 18.12) resolved at the group meeting
- [ ] Real app icons replacing placeholders
- [ ] Android native project generated and keystore backed up (`docs/ANDROID.md`, `docs/RECOVERY-KIT.md`)
- [ ] Production deploy (manual, per `docs/RUNBOOK.md`); never from a dev session
- [ ] Targets from the owner's plan: Phases 1 and 2 usable before 20 Dec 2026; Phases 3 to 5 by March 2027
