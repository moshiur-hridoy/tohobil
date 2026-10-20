# Barakah Fund System: Build Specification for Claude Code

*Version 1.0 · 17 Oct 2026 · Authoritative build spec. Derived from the owner-approved plan. Hand this whole document to Claude Code; it should be able to build without asking questions.*

## 0. Read first: instructions to the build agent

1. **Do not ask the owner questions.** Where this spec is silent or ambiguous, pick the most conservative option, implement it as a configurable rule (`rules` table) or an adapter interface, and record it in `docs/ASSUMPTIONS.md`. Section 16 lists defaults already chosen.
2. **Build in phases (Section 15).** Finish and test a phase before starting the next. Each phase ends with green tests and a short `docs/PHASE-N.md` (what was built, how to run, known gaps).
3. **Money correctness over speed.** Write the tests for money logic first (Section 14). Any change to money code needs a test.
4. **No real data in dev or tests.** Use the seed fixture (Section 14.2) with fictional names and fake phone numbers. Never commit secrets; use `.env` files listed in `.env.example`.
5. **Never mutate or delete financial records.** Corrections are reversal entries. Database triggers enforce this (Section 6).
6. **Language:** all user-facing text is Bengali via i18n keys (English fallback). Code, comments, identifiers, commit messages, docs are English.
7. **Boring technology.** Use only the stack in Section 2. Do not add services (no Redis, no Kafka, no extra DBs).
8. **Never run against production** from a dev session. Production deploy is a documented manual step (Section 12).
9. Keep containers small: the host has about 8 GB RAM shared with other services (Section 12 gives limits).

## 1. Product summary

- A private fund of about 8 members holding 20 shares. Each share contributes a fixed amount every month (default 5,000 BDT per share). Late payers get a fine. The fund invests in assets (gold, land, house), receives rent, and decides everything by member vote.
- Roles: **member** (mobile, most users, no PC), **cashier** (the owner; desktop-first UI, also usable on mobile), **auditor** (a member who is not the cashier; read-only plus approvals).
- Promises: every taka is traceable (who, when, how much, how, proof); nothing is deleted; every spending or rule decision needs a majority vote; every member can see every member's payment status and the whole ledger; each late member gets individual reminders.
- Currency BDT (taka). Store paisa as bigint. Show with lakh/crore grouping (1,00,000). Bengali digits are a user setting.
- Scale: at most 50 members, at most 100k ledger rows, one server. Optimise for correctness, auditability and low memory, not throughput.
- Clients: Android app (Capacitor wrapper) and PWA for members; same web app, desktop layout for the cashier. iOS is out of scope but the PWA must work on iPhone Safari.

## 2. Technology stack (fixed)

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 22 LTS, TypeScript strict, pnpm workspaces |  |
| API | Fastify, zod (fastify-type-provider-zod), OpenAPI generated | REST under `/api/v1` |
| Database | PostgreSQL 16 | SQL-first migrations with `node-pg-migrate`; queries via Kysely with types from `kysely-codegen` |
| Jobs | `pg-boss` | Uses Postgres, no Redis |
| Web | React 18, Vite, TypeScript, Tailwind CSS, Radix UI primitives (shadcn/ui style), TanStack Query, React Router, react-i18next, vite-plugin-pwa |  |
| Android | Capacitor (current stable), `@capacitor/push-notifications` | Package id `app.barakah.fund` |
| Auth | Phone + SMS OTP, 6-digit PIN, JWT access (15 min) + rotating refresh token (30 days, hashed in DB), TOTP (`otplib`) for cashier and auditor |  |
| Push | `firebase-admin` (FCM HTTP v1) |  |
| SMS | `SmsProvider` interface with `ConsoleSmsProvider` (dev) and `HttpSmsProvider` (generic, configured by env: URL, API key, sender id, body template) | Real gateway chosen later by owner |
| Files | Local volume `/data/files`, content-addressed by sha256, thumbnails via `sharp` |  |
| PDF | `pdf-lib` or `pdfkit` with an embedded Bengali font (Noto Sans Bengali) |  |
| Tests | Vitest, Testcontainers (real Postgres), Playwright for e2e |  |
| Quality | ESLint, Prettier, `tsc --noEmit`, `pnpm test`, `pnpm lint` as one `pnpm check` |  |
| Deploy | Docker Compose; images built off-server |  |

## 3. Repository layout

```
barakah/
  apps/
    api/            Fastify app, routes, services, jobs
    web/            React app (member + cashier UI), PWA, Capacitor config
  packages/
    shared/         zod schemas, money utils, date utils, i18n keys, enums
  db/
    migrations/     SQL migrations (numbered)
    seed/           seed fixture (fictional)
  scripts/
    verify-ledger.ts, import-sheet/, backup.sh, restore-test.sh
  infra/
    docker-compose.yml, docker-compose.dev.yml, Dockerfile.api, backup/
  docs/
    ASSUMPTIONS.md, RUNBOOK.md, RECOVERY-KIT.md, PHASE-*.md
  CLAUDE.md         short pointer to this spec + commands
```

`CLAUDE.md` must contain: how to run dev, how to run tests, the rule 'never mutate financial rows', and a link to this spec.

## 4. Conventions

- **Money:** `bigint` paisa everywhere (DB and TypeScript `bigint`). No floats. `packages/shared/money.ts` exports `formatBDT(paisa, {digits:'bn'|'en'})` with lakh/crore grouping, `parseBDT(text)` (accepts commas, `৳`, Bengali digits), and `divRound(a, b)` (integer division, round half up). Multiply before dividing.
- **Time:** `timestamptz` in DB, UTC. Business dates are `date` in `Asia/Dhaka`. Helper `todayDhaka()`. Cron schedules run in `Asia/Dhaka`. All code that depends on 'now' takes an injectable `Clock` so tests can simulate months.
- **IDs:** `uuid` (`gen_random_uuid()`) except `ledger_entries.seq` and `audit_log.id` (bigint identity).
- **Periods:** a month is `char(7)` like `2026-11`.
- **Errors:** RFC 7807 `application/problem+json` with a stable machine `code` (e.g. `payment.duplicate_trx`). UI maps codes to Bengali messages.
- **Audit:** every write endpoint writes `audit_log` (actor, action, entity, before, after, ip, device) in the same transaction as the change.
- **Idempotency:** create endpoints accept an `Idempotency-Key` header (store key + response for 24 h).
- **Pagination:** cursor-based, default 50, max 200.
- **Logging:** `pino` JSON to stdout. Mask phone numbers (`+88017****1234`). Never log OTPs, PINs, tokens, or SMS bodies.

## 5. Domain rules (authoritative)

### 5.1 Members, status, roles

Statuses: `prospective`, `active`, `warning`, `suspended`, `exited`, `deceased`.

| From | To | Trigger |
| --- | --- | --- |
| (new) | prospective | `new_member` proposal executed |
| prospective | active | entry payment fully confirmed (5.9) |
| active | warning | job: outstanding principal in at least `warning_after_months` (default 2) consecutive periods |
| warning | active | outstanding principal cleared |
| active, warning | suspended | `suspension` proposal executed (5.10) |
| suspended | active | `reinstatement` proposal executed |
| any except exited | exited | settlement completed |
| any | deceased | `member_deceased` proposal executed (then settlement to nominees) |

- Voting and proposing allowed only for `active` and `warning`. `suspended` members can log in read-only. `prospective`, `exited` cannot log in except `prospective` can see their own entry quote.
- Roles (`users.roles`): `member`, `cashier`, `auditor`. Exactly one active cashier and one active auditor at a time (enforce in code). The cashier and auditor must be different members. Changing either is a proposal (`role_change`).
- Permission matrix:

| Capability | member | cashier | auditor |
| --- | --- | --- | --- |
| View all members' payment status, ledger, assets, proposals, constitution | yes | yes | yes |
| Submit own payment, vote, create proposal, file objection | yes | yes | yes |
| Confirm/reject payments, cashier entry, execute approved proposals, open/close proposals, enter valuations/rent | no | yes | no |
| Approve reversals, reconciliations, period locks, resolve objections | no | no | yes |
| View audit log, backup status, system health | no | yes | yes |
| Change rules | only via executed proposal | executes | no |

The cashier is also a member and votes like one.

### 5.2 Rules table and defaults

Table `rules(key, value jsonb, valid_from date, clause_ref text, created_by_proposal)`. `getRule(key, asOfDate)` returns the row with the greatest `valid_from <= asOfDate`. Seed these (clause\_ref empty until the owner links the constitution):

| key | default | meaning |
| --- | --- | --- |
| `monthly_due_per_share_paisa` | 500000 | monthly due per share |
| `start_boost_per_share_paisa` | 800000 | one-time legacy due (import only) |
| `due_day` | 20 | day of month a due is payable by |
| `dues_generation_day` | 1 | day dues are generated |
| `reminder_start_day` / `reminder_end_day` | 15 / 20 | daily reminder window |
| `reminder_time` | `09:00` | Asia/Dhaka |
| `fine_day` | 21 | day fines are applied |
| `fine_per_share_paisa` | 50000 | fine per share per late due |
| `warning_after_months` | 2 | consecutive unpaid periods before `warning` |
| `push_to_sms_fallback_hours` | 6 | unread push becomes SMS |
| `default_vote_duration_hours` | 72 | prefill only; cashier sets per proposal |
| `proposal_execution_window_days` | 30 | approved proposal lapses after this |
| `payment_pending_alert_hours` | 24 | alert cashier about old pending payments |
| `rent_grace_days` | 3 | days after rent due before alert |
| `valuation_max_age_days` | 365 | NAV shows a stale warning beyond this |
| `exit_fee_paisa` | 0 | settlement deduction |
| `allocation_order` | `oldest_principal_then_fines` | default payment allocation |

Changing a rule needs an executed `rule_change` proposal. Rule rows are append-only (new `valid_from`), never edited.

### 5.3 Dues

- Job `generate_dues(period)` runs at 00:10 on `dues_generation_day`. For each member with status `active` or `warning` and `shares_on(member, first day of period) > 0`, insert a due: `kind='monthly'`, `shares_snapshot`, `amount = shares_snapshot * monthly_due_per_share_paisa`, `due_date = date(period, due_day)`. Unique `(member_id, period, kind)`; the job is idempotent. Suspended, exited and prospective members get none.
- Also exposed as a function so the importer and tests can backfill any period.
- A due's outstanding principal = `amount - sum(allocations)`. Derived status: `paid`, `partial`, `unpaid`, `overdue` (outstanding > 0 and today > due\_date), `paid_late` (paid and last allocation date > due\_date).
- If a member has unallocated credit (`payments.unallocated_paisa` > 0), auto-allocate it to newly generated dues (oldest first), writing allocation rows.

### 5.4 Payments

Fields and states in Section 6. States: `pending` -> `confirmed` | `rejected`; `confirmed` -> `reversed`. Sources: `member_submitted`, `cashier_entry`, `sms_match`, `import`. Methods: `bkash`, `nagad`, `bank`, `cash`, `other`.

**Member submission** (`POST /payments`): amount > 0, method, `paid_at` (default now), `trx_id` required for bkash/nagad/bank, optional proof image, optional `for_periods` hint. Status `pending`. Pending payments do not touch the ledger, balances or NAV. While a pending payment exists, the member's due shows 'under verification' and reminders pause for that member.

**Uniqueness:** unique index on `upper(trim(trx_id))` for rows with status in (`pending`,`confirmed`). A duplicate returns 409 `payment.duplicate_trx` with a pointer to the existing payment.

**Confirm** (`POST /payments/:id/confirm`, cashier): one DB transaction that (a) sets status `confirmed`, `confirmed_at`, `confirmed_by`; (b) allocates (below); (c) posts ledger entries; (d) writes audit; (e) enqueues a `payment_confirmed` notification. Body may contain a manual allocation list; otherwise use `allocation_order`.

**Allocation (default `oldest_principal_then_fines`):** outstanding dues ordered by `due_date` asc get principal first; then outstanding unwaived fines ordered by `created_at` asc; any remainder is `unallocated_paisa` (member credit, still capital). Manual override allowed: list of `{due_id|fine_id, amount}` summing to at most the payment amount.

**Ledger posting for a confirmed payment** (method account = `CASH`, `BANK`, `BKASH`, `NAGAD`; `other` -> `BANK`): one entry per component, all with `ref_type='payment'`: principal and credit -> `DR <method account>`, `CR MEMBER_CAPITAL` (member\_id set); fine part -> `DR <method account>`, `CR FINE_INCOME` (member\_id set).

**Reject** (`POST /payments/:id/reject`, cashier): reason required (min 3 chars). Member is notified. A rejected TrxID may be resubmitted.

**Cashier entry** (`POST /payments/cashier-entry`): cashier creates and confirms in one step with `source='cashier_entry'` (or `sms_match` when created from the SMS parser). The member always gets a `payment_confirmed` notification, and the notification links to the objection form. This is the second pair of eyes on the cashier's own entries.

**Reversal:** `POST /payments/:id/reverse-request` (cashier, reason) creates an approval item; the auditor approves (`POST /approvals/:id/approve`); then the system writes opposite ledger entries (new rows, `ref_type='payment_reversal'`), negative allocation rows, sets payment `reversed`, and recomputes due statuses. If a period is locked, the reversal is dated in the current open period.

**SMS parser** (`POST /payments/parse-sms`, cashier): input pasted SMS text; output `{method, amount_paisa, trx_id, paid_at, counterparty_phone, balance_paisa, matches[]}` where `matches` lists pending payments with the same TrxID, or same amount from a member within 3 days. Supported patterns (tests must cover these, with fake numbers):

- bKash receive: `You have received Tk 17,500.00 from 01700000000. Fee Tk 0.00. Balance Tk 38,486.45. TrxID AB12CD34EF at 30/12/2025 22:00`
- bKash cash in: `Cash In Tk 20,400.00 from 01700000000 successful. Fee Tk 0.00. Balance Tk 20,437.81. TrxID AB12CD34EF at 15/01/2026 19:23.`
- Bank deposit (no TrxID): `28-Dec-2025 Tk. 15,500 Deposit Tk. 65,655 Balance A/C: 1781***3544` -> amount and date only; `trx_id` null, `method='bank'`.
- Unknown text returns nulls plus `parsed=false`; never throw.

Parsing only suggests. A human always confirms.

### 5.5 Fines

- Cash-basis accounting for fines: a fine is a receivable tracked in `fines`; it reaches the ledger only when paid (`FINE_INCOME`).
- Job `apply_fines` runs 00:05 on `fine_day`. For every due where `due_date < today`, outstanding principal > 0, member status in (`active`,`warning`) and no `fines` row for that due: insert fine with `amount = shares_snapshot * fine_per_share_paisa(asOf today)`, reason `late_payment`. One fine per due; fines never compound. A due paid on or before `due_day` never gets a fine; paying on day 21 or later after the job has run does not remove the fine.
- Fine outstanding = amount - allocations - waived. A fine is waived only by an executed `fine_waiver` proposal, which sets `waived_by_proposal`, `waived_at` and writes audit. No ledger entry (nothing was ever posted).

### 5.6 Ledger and chart of accounts

Single-entry rows that each carry one debit account and one credit account (a double-entry pair per row). Accounts (seed table `accounts`):

| code | kind | note |
| --- | --- | --- |
| `CASH`, `BANK`, `BKASH`, `NAGAD` | asset | `is_cash=true` |
| `INVESTMENTS_AT_COST` | asset | non-cash assets at purchase cost |
| `MEMBER_CAPITAL` | equity | per member via `member_id` |
| `OPENING_ADJUSTMENT` | equity | import reconciliation only |
| `SETTLEMENT_PAYABLE` | liability | approved settlement not yet paid |
| `MEMBER_ESCROW` | liability | per member; distributions held for suspended members |
| `FINE_INCOME`, `RENT_INCOME`, `BANK_INTEREST`, `ASSET_GAIN`, `OTHER_INCOME` | income |  |
| `BANK_CHARGE`, `SMS_CHARGE`, `MAINTENANCE`, `ASSET_LOSS`, `OTHER_EXPENSE`, `DISTRIBUTIONS` | expense | `DISTRIBUTIONS` = profit paid to members |

Postings:

| Event | Debit | Credit |
| --- | --- | --- |
| Contribution or entry payment | method account | `MEMBER_CAPITAL` |
| Fine paid | method account | `FINE_INCOME` |
| Buy asset | `INVESTMENTS_AT_COST` | paying account |
| Rent received | method account | `RENT_INCOME` |
| Bank interest | `BANK` | `BANK_INTEREST` |
| Bank/SMS charge (auto, no vote) | `BANK_CHARGE` or `SMS_CHARGE` | `BANK` / `BKASH` |
| Sell asset at price P, cost C | method account (P) | `INVESTMENTS_AT_COST` (C), and `ASSET_GAIN` (P-C) if P>C; if P\<C the shortfall is debited to `ASSET_LOSS` |
| Move money between accounts | destination | source |
| Profit distribution | `DISTRIBUTIONS` | method account (or `MEMBER_ESCROW` for suspended members) |
| Settlement approved | `MEMBER_CAPITAL` (member) | `SETTLEMENT_PAYABLE` |
| Settlement instalment paid | `SETTLEMENT_PAYABLE` | method account |

- Automatic charges (bank, SMS) are the only ledger postings allowed without a proposal. They carry `ref_type='auto_charge'` and appear in a monthly auditor review list.
- `entry_date` may not fall in a locked period (`periods.locked_at`).
- **Hash chain:** a BEFORE INSERT trigger takes `pg_advisory_xact_lock(7001)`, reads the last row's `hash` (64 zeros if none), sets `prev_hash`, and sets `hash = encode(digest(prev_hash || '|' || canonical, 'sha256'), 'hex')` where `canonical = concat_ws('|', seq, entry_date, debit_account, credit_account, amount_paisa, coalesce(member_id::text,''), coalesce(ref_type,''), coalesce(ref_id::text,''), coalesce(memo,''), coalesce(created_by::text,''), to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`. `scripts/verify-ledger.ts` recomputes the chain in TypeScript and must match byte for byte. Expose `GET /ledger/verify` (returns last seq, last hash, ok flag). The monthly statement prints the last hash of the month.

### 5.7 Net asset value (NAV)

- `net_assets` = balances of `CASH`+`BANK`+`BKASH`+`NAGAD` + sum of the latest approved valuation of each asset with status `held` (use cost if an asset has no valuation) - balance(`SETTLEMENT_PAYABLE`) - balance(`MEMBER_ESCROW`). Do not count `INVESTMENTS_AT_COST` (valuation replaces it), pending payments, or unpaid dues/fines.
- `shares_outstanding` = shares effective today for members with status `active`, `warning`, `suspended`, `deceased` (not `prospective`, not `exited`).
- `nav_per_share = divRound(net_assets, shares_outstanding)`. Price for `n` shares = `divRound(net_assets * n, shares_outstanding)` (multiply first, bigint).
- `GET /nav` returns the breakdown (cash by account, each asset with valuation and date, deductions, shares) and `stale_valuations` (assets whose latest valuation is older than `valuation_max_age_days`).

### 5.8 Proposals and voting

**Types, payloads, and effect on execute:**

| type | payload (zod schema in `shared`) | effect when executed | subject excluded from voting |
| --- | --- | --- | --- |
| `fine_waiver` | `fine_ids[]`, reason | waive fines (5.5) | fined member |
| `expense` | max amount, account (`MAINTENANCE` or `OTHER_EXPENSE`), payee, purpose | post expense up to approved amount from chosen cash account | none |
| `investment_purchase` | kind, name, max amount, quantity, unit, source account, notes | create asset + ledger (5.11) | none |
| `asset_sale` | asset\_id, min price | sell asset (5.11) | none |
| `valuation_update` | items `{asset_id, value, basis, as_of}` | insert `asset_valuations` | none |
| `new_member` | name, phone, shares, nominees, note | create `prospective` member + entry quote (5.9) | none (not yet a member) |
| `suspension` | member\_id, reason, clause\_ref | 5.10 | that member |
| `reinstatement` | member\_id, terms | 5.10 | that member |
| `settlement` | member\_id, payout\_plan | 5.10 | that member |
| `member_deceased` | member\_id, nominee info | status `deceased`, then settlement flow | that member |
| `distribution` | total, source account | post per-member distribution by shares; suspended members' parts go to `MEMBER_ESCROW` | none |
| `rule_change` | key, value, valid\_from, clause\_ref | insert rule row | none |
| `constitution_amendment` | version, file\_id, effective\_from, summary | publish new constitution version | none |
| `role_change` | role, member\_id | change cashier or auditor | the member being replaced |
| `general` | text | none, records a decision | none |

**Lifecycle:** `draft` -> `open` -> (finalized by job at `closes_at`) `approved` | `rejected` -> `executed` | `lapsed` (not executed within `proposal_execution_window_days`) | `cancelled` (only while `draft`).

- Any `active`/`warning` member may create a proposal (status `draft`). The cashier or auditor opens it and sets `closes_at` (at least 1 hour ahead; duration is manual per proposal). Payload cannot change after opening.
- On open, snapshot eligible voters into `proposal_voters` (members `active`/`warning` minus the excluded subject). `eligible_count = count`. `threshold = floor(eligible_count / 2) + 1`.
- One current vote per member (`yes`, `no`, `abstain`). A member may change the vote until `closes_at`; changing inserts a new row and sets `superseded_at` on the previous one. Votes are public to all members (transparency); the audit log keeps every change.
- Finalize at `closes_at`: `approved` if `yes_count >= threshold`, else `rejected`. Early close by cashier or auditor only when the outcome is mathematically decided: `yes >= threshold` or `eligible - no - abstain < threshold`.
- Notifications: on open (everyone eligible), 24 h before close (non-voters), on result (everyone).
- **Execute** (`POST /proposals/:id/execute`): cashier, except `role_change` which the auditor executes. Preconditions: status `approved`, not executed, inside the window, payload re-validated against current state (amounts within the approved max, referenced rows still valid). Everything happens in one DB transaction; write `executed_at`, `executed_by`, `result_ref`, audit.
- Spending of any kind (expense, purchase, distribution, settlement payout) is impossible without an approved proposal. The only exception is `auto_charge` ledger rows (5.6).

### 5.9 New member

1. `new_member` proposal approved and executed: create `members` row with status `prospective`, create `entry_quotes(member_id, shares, net_assets_paisa, shares_outstanding, price_paisa, expires_at = now + 7 days)` where `price_paisa = divRound(net_assets * shares, shares_outstanding)`. If any held asset valuation is stale (older than `valuation_max_age_days`), execution fails with `nav.stale_valuation`; run a `valuation_update` proposal first.
2. The prospective person pays the quote through the normal payment flow with `purpose='entry'` (cashier entry or submission by the cashier on their behalf). Allocation goes to an `entry` due (kind `entry`, amount = quote price). Ledger: `DR <method account>`, `CR MEMBER_CAPITAL`.
3. When the entry due is fully paid: insert `share_holdings(effective_from = next day)`, status `active`, create `users` row, send onboarding SMS with an install link, notify all members.
4. Monthly dues start from the first period that begins after the join date.
5. If the quote expires unpaid, a new quote needs a new proposal.

A new share issued at NAV leaves NAV per share unchanged for existing members. Add a test for that invariant.

### 5.10 Suspension, reinstatement, settlement

**Suspension executed:**

- Status -> `suspended`, `member_status_events` row, `suspended_on = today`.
- Insert a locked `member_snapshots` row `kind='suspension'` recording: date, shares, net assets, shares outstanding, NAV per share, member's paid-in capital, outstanding principal, outstanding fines, escrow balance. Snapshots are immutable.
- From now: no new dues or fines for the member, reminders stop, UI is read-only, the member is excluded from voter lists and from `shares`-based distribution cash (their part goes to `MEMBER_ESCROW`). Shares stay in `shares_outstanding`.
- Existing outstanding dues and fines stay on the books.

**Reinstatement executed:** status -> `active`; generate catch-up dues for every period after `suspended_on` up to the current period using the rule in force for each period; fines are not charged for catch-up periods unless rule `reinstatement_charges_fines` is true (default false); escrow remains the member's money and is paid out through an `escrow_payout` cashier action (`DR MEMBER_ESCROW`, `CR <method account>`), amount at most the escrow balance.

**Settlement (exit):** creating a `settlement` proposal computes a fresh `member_snapshots` row `kind='settlement_quote'` using current NAV and the latest valuations:

```
gross       = divRound(member_shares * net_assets, shares_outstanding)
escrow      = balance of MEMBER_ESCROW for the member
deductions  = outstanding principal dues + outstanding unwaived fines + exit_fee
net         = gross + escrow - deductions
```

The quote is frozen for the vote and shown in the proposal with each term. `payout_plan` is a list of `{due_on, amount}` summing to `net` (a single entry means lump sum). If `net < 0` the settlement cannot execute until the shortfall is paid (a payment with `purpose='settlement_shortfall'`) or deductions are reduced by a `fine_waiver`.

**Execute settlement** (one transaction): post `DR MEMBER_CAPITAL (member)`, `CR SETTLEMENT_PAYABLE` for `gross - deductions` (skip if not positive), and `DR MEMBER_ESCROW`, `CR SETTLEMENT_PAYABLE` for `escrow`; set `share_holdings.effective_to = today`; create `settlements` and `settlement_payouts` rows. Each instalment is later paid by the cashier: `DR SETTLEMENT_PAYABLE`, `CR <method account>`, with a notification. When payable reaches 0: status `exited`, `exited_on`, user disabled, final PDF statement generated.

**Invariants checked before settlement executes (abort on failure) and asserted in tests:**

1. NAV after = NAV before + `divRound(deductions, shares_outstanding_after)` within 1 paisa per share.
2. Sum of payout plan = `net`.
3. No due or fine row was created for the member after the suspension snapshot date.
4. Ledger hash chain verifies.

### 5.11 Assets and rent

- Asset kinds: `gold`, `land`, `house`, `other`. Gold has `quantity` and `unit` (`vori` or `gram`). Status: `planned`, `acquiring`, `held`, `sold`. Documents (deeds, receipts) attach through `documents`.
- **Purchase:** executing `investment_purchase` creates the asset and posts `DR INVESTMENTS_AT_COST`, `CR <source account>` for the actual cost (at most the approved max). Land or house purchases may be staged: status `acquiring` with several staged payments, each a ledger post; status moves to `held` when the cashier marks it complete (needs a note and a document).
- **Valuation:** `valuation_update` proposal rows into `asset_valuations(asset_id, value_paisa, as_of, basis, proposal_id)`. Never edited.
- **Sale:** executing `asset_sale` with actual price P at least `min_price`: post per 5.6 (gain or loss), set status `sold`, `sold_on`, `sale_price_paisa`. Distribution of proceeds needs its own `distribution` proposal.
- **Rent (two streams at launch, any number allowed):** `rent_streams(asset_id?, name, tenant_name, monthly_amount_paisa, due_day, active_from, active_to)`. Job generates `rent_expected(stream_id, period, amount_paisa, due_date)` on day 1. Cashier records receipt (`POST /rent/expected/:id/receive`, amount, method, date); partial receipts allowed; posts `DR <method account>`, `CR RENT_INCOME`. Alert the cashier when unreceived `rent_grace_days` after `due_date`. Creating or ending a rent stream does not need a vote; receiving rent never does; maintenance spending does (an `expense` proposal).

### 5.12 Reconciliation, period locks, objections

- Monthly, the cashier submits actual balances for `CASH`, `BANK`, `BKASH`, `NAGAD` for the period end (`reconciliations` rows with `system_balance`, `actual_balance`, `difference`, note). Any non-zero difference requires a note and notifies the auditor. The auditor approves the reconciliation, then may lock the period (`periods.locked_at`). No ledger entry may have `entry_date` in a locked period.
- Year end: after all 12 periods are locked, generate the annual archive (Section 12).
- **Objections:** any member can object to any ledger row (`POST /objections {ledger_seq, text}`); the auditor resolves with a note (`resolved` or `dismissed`). Open objections show as a badge on the ledger row and block locking that period.

## 6. Database schema

Postgres 16. All tables in schema `public`. Three DB roles: `barakah_migrator` (owns objects, runs migrations), `barakah_app` (the API; DML only, and no UPDATE/DELETE on the append-only tables), `barakah_readonly` (verifier and backup checks). Money columns are `bigint` paisa. Below is the required DDL; migrations may split it but must keep names and constraints.

```sql
create extension if not exists pgcrypto;

create table members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,                       -- +8801XXXXXXXXX
  photo_file_id uuid,
  status text not null default 'active' check (status in ('prospective','active','warning','suspended','exited','deceased')),
  joined_on date not null,
  suspended_on date,
  exited_on date,
  notify_prefs jsonb not null default '{"push":true,"sms":true,"digits":"bn"}',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null unique references members,
  roles text[] not null default '{member}' check (roles <@ array['member','cashier','auditor']),
  pin_hash text, totp_secret_enc text, totp_enabled boolean not null default false,
  failed_attempts int not null default 0, locked_until timestamptz,
  disabled_at timestamptz, last_login_at timestamptz
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users,
  label text, platform text not null check (platform in ('android','web','ios')),
  fcm_token text, push_enabled boolean not null default true,
  refresh_token_hash text, refresh_expires_at timestamptz, revoked_at timestamptz,
  last_seen_at timestamptz, created_at timestamptz not null default now()
);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null, code_hash text not null, purpose text not null,
  expires_at timestamptz not null, consumed_at timestamptz,
  attempts int not null default 0, created_at timestamptz not null default now()
);

create table share_holdings (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members,
  shares int not null check (shares > 0),
  effective_from date not null, effective_to date,
  source text not null check (source in ('initial','entry','transfer_in','import')),
  proposal_id uuid
);

create table share_register (            -- informational: per-share registered name and nominee
  share_no int primary key,
  member_id uuid not null references members,
  registered_name text not null, nominee_name text, nominee_relation text
);

create table rules (
  id uuid primary key default gen_random_uuid(),
  key text not null, value jsonb not null, valid_from date not null,
  clause_ref text, proposal_id uuid, created_at timestamptz not null default now(),
  unique (key, valid_from)
);

create table periods (period char(7) primary key, locked_at timestamptz, locked_by uuid);

create table dues (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members,
  period char(7) not null,
  kind text not null check (kind in ('monthly','start_boost','entry')),
  shares_snapshot int not null, amount_paisa bigint not null check (amount_paisa >= 0),
  due_date date not null, created_at timestamptz not null default now(),
  unique (member_id, period, kind)
);

create table fines (
  id uuid primary key default gen_random_uuid(),
  due_id uuid not null unique references dues,
  member_id uuid not null references members,
  amount_paisa bigint not null check (amount_paisa > 0),
  reason text not null default 'late_payment',
  waived_by_proposal uuid, waived_at timestamptz,
  created_at timestamptz not null default now()
);

create table files (
  id uuid primary key default gen_random_uuid(),
  sha256 char(64) not null, mime text not null, size_bytes bigint not null,
  path text not null, original_name text, created_by uuid,
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members,
  amount_paisa bigint not null check (amount_paisa > 0),
  method text not null check (method in ('bkash','nagad','bank','cash','other')),
  purpose text not null default 'dues' check (purpose in ('dues','entry','settlement_shortfall')),
  trx_id text, paid_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','reversed')),
  source text not null check (source in ('member_submitted','cashier_entry','sms_match','import')),
  for_periods text[], proof_file_id uuid references files, raw_sms text, note text,
  reject_reason text, unallocated_paisa bigint not null default 0,
  submitted_by uuid, submitted_at timestamptz not null default now(),
  confirmed_by uuid, confirmed_at timestamptz
);
create unique index payments_trx_active on payments (upper(trim(trx_id)))
  where trx_id is not null and status in ('pending','confirmed');

create table payment_allocations (        -- append-only; negative amounts for reversals
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments,
  due_id uuid references dues, fine_id uuid references fines,
  amount_paisa bigint not null,
  created_at timestamptz not null default now(),
  check ((due_id is null) <> (fine_id is null))
);

create table accounts (
  code text primary key, name text not null,
  kind text not null check (kind in ('asset','liability','equity','income','expense')),
  is_cash boolean not null default false
);

create table ledger_entries (
  seq bigint generated always as identity primary key,
  entry_date date not null,
  debit_account text not null references accounts,
  credit_account text not null references accounts,
  amount_paisa bigint not null check (amount_paisa > 0),
  member_id uuid, ref_type text, ref_id uuid, memo text,
  created_by uuid, created_at timestamptz not null default now(),
  prev_hash char(64) not null, hash char(64) not null unique,
  check (debit_account <> credit_account)
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('gold','land','house','other')),
  name text not null, description text, location text,
  acquired_on date, cost_paisa bigint not null default 0,
  quantity numeric(14,4), unit text check (unit in ('vori','gram')),
  status text not null check (status in ('planned','acquiring','held','sold')),
  sold_on date, sale_price_paisa bigint, proposal_id uuid,
  created_at timestamptz not null default now()
);
create table asset_valuations (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets, value_paisa bigint not null,
  as_of date not null, basis text, proposal_id uuid,
  created_at timestamptz not null default now()
);
create table documents (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files,
  entity_type text not null, entity_id uuid not null,
  doc_type text, title text, created_at timestamptz not null default now()
);

create table rent_streams (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid references assets, name text not null, tenant_name text,
  monthly_amount_paisa bigint not null check (monthly_amount_paisa > 0),
  due_day int not null check (due_day between 1 and 28),
  active_from date not null, active_to date
);
create table rent_expected (
  id uuid primary key default gen_random_uuid(),
  stream_id uuid not null references rent_streams, period char(7) not null,
  amount_paisa bigint not null, due_date date not null,
  received_paisa bigint not null default 0,
  unique (stream_id, period)
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  type text not null, title text not null, description text,
  subject_member_id uuid, payload jsonb not null, amount_paisa bigint, clause_ref text,
  status text not null default 'draft' check (status in ('draft','open','approved','rejected','executed','lapsed','cancelled')),
  created_by uuid not null, opens_at timestamptz, closes_at timestamptz,
  eligible_count int, threshold int,
  yes_count int not null default 0, no_count int not null default 0, abstain_count int not null default 0,
  finalized_at timestamptz, executed_at timestamptz, executed_by uuid, result_ref jsonb,
  created_at timestamptz not null default now()
);
create table proposal_voters (
  proposal_id uuid not null references proposals, member_id uuid not null references members,
  primary key (proposal_id, member_id)
);
create table votes (                       -- append-only except superseded_at
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals, member_id uuid not null references members,
  choice text not null check (choice in ('yes','no','abstain')),
  cast_at timestamptz not null default now(), superseded_at timestamptz
);
create unique index votes_current on votes (proposal_id, member_id) where superseded_at is null;

create table approvals (                   -- auditor approvals (reversals, reconciliations)
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('payment_reversal','reconciliation','period_lock')),
  ref_id text not null, requested_by uuid not null, reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid, decided_at timestamptz, created_at timestamptz not null default now()
);

create table member_status_events (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members, from_status text, to_status text not null,
  reason text, proposal_id uuid, created_by uuid, created_at timestamptz not null default now()
);
create table member_snapshots (            -- immutable
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members,
  kind text not null check (kind in ('suspension','settlement_quote')),
  taken_on date not null, shares int not null,
  net_assets_paisa bigint not null, shares_outstanding int not null, nav_per_share_paisa bigint not null,
  paid_in_capital_paisa bigint, gross_paisa bigint, escrow_paisa bigint,
  deductions jsonb not null default '{}', net_paisa bigint, proposal_id uuid,
  created_at timestamptz not null default now()
);
create table entry_quotes (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members, shares int not null,
  net_assets_paisa bigint not null, shares_outstanding int not null, price_paisa bigint not null,
  expires_at timestamptz not null, proposal_id uuid, created_at timestamptz not null default now()
);
create table settlements (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members, snapshot_id uuid not null references member_snapshots,
  proposal_id uuid not null, net_paisa bigint not null, payout_plan jsonb not null,
  status text not null default 'approved' check (status in ('approved','paying','completed')),
  created_at timestamptz not null default now(), completed_at timestamptz
);
create table settlement_payouts (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references settlements, due_on date not null,
  amount_paisa bigint not null, paid_at timestamptz, ledger_seq bigint
);

create table reconciliations (
  id uuid primary key default gen_random_uuid(),
  period char(7) not null, account text not null references accounts,
  system_balance_paisa bigint not null, actual_balance_paisa bigint not null,
  difference_paisa bigint generated always as (actual_balance_paisa - system_balance_paisa) stored,
  note text, submitted_by uuid not null, approved_by uuid, approved_at timestamptz,
  unique (period, account)
);
create table objections (
  id uuid primary key default gen_random_uuid(),
  ledger_seq bigint not null references ledger_entries, member_id uuid not null references members,
  text text not null,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution text, resolved_by uuid, created_at timestamptz not null default now(), resolved_at timestamptz
);

create table constitution_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique, file_id uuid references files,
  effective_from date not null, proposal_id uuid, created_at timestamptz not null default now()
);
create table constitution_clauses (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references constitution_versions,
  clause_no text not null, title text, summary text, body text,
  unique (version_id, clause_no)
);
create table constitution_acks (
  version_id uuid not null references constitution_versions, member_id uuid not null references members,
  acked_at timestamptz not null default now(), primary key (version_id, member_id)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members, template text not null,
  channel text not null check (channel in ('push','sms')),
  payload jsonb not null default '{}', dedupe_key text unique,
  scheduled_for timestamptz not null default now(), sent_at timestamptz,
  delivered_at timestamptz, opened_at timestamptz,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  error text
);

create table audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid, action text not null, entity_type text not null, entity_id text,
  before jsonb, after jsonb, ip inet, device_id uuid, created_at timestamptz not null default now()
);

create table idempotency_keys (
  key text primary key, user_id uuid not null, response jsonb not null,
  created_at timestamptz not null default now()
);
```

**Required triggers and functions:**

```sql
create function forbid_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name; end $$;

-- append-only tables: ledger_entries, audit_log, payment_allocations, member_snapshots,
-- asset_valuations, rules, member_status_events
create trigger no_mutation before update or delete on ledger_entries
  for each row execute function forbid_mutation();   -- repeat for the other tables

-- votes: only superseded_at may change; deletes forbidden (trigger compares OLD/NEW columns)
-- ledger_entries BEFORE INSERT: advisory lock + prev_hash/hash computation per Section 5.6
-- ledger_entries BEFORE INSERT: reject if the entry_date's period is locked
-- accounts seeded by migration with the codes in Section 5.6
```

Plus: `shares_on(member_id, date)` SQL function summing active holdings; views `v_account_balances`, `v_due_status`, `v_member_balances`; indexes on `dues(member_id, period)`, `payments(member_id, status)`, `ledger_entries(entry_date)`, `ledger_entries(member_id)`, `notifications(member_id, template, scheduled_for)`.

## 7. API

REST, JSON, base path `/api/v1`, OpenAPI at `/api/v1/openapi.json`. All routes except `/health` and auth require a bearer access token. Roles: **M** any logged-in member (including suspended in read-only mode), **A** active/warning member, **C** cashier, **U** auditor. Write routes reject suspended, exited, prospective users with `auth.read_only`. Steps requiring a recent TOTP (`step-up`, valid 12 h): payment confirm, proposal execute, approvals, role change.

**Auth**

- OTP: 6 digits, expires in 5 minutes, max 3 attempts, hashed in DB, max 3 requests per phone per hour.
- First login on a device: `POST /auth/otp/request {phone}` -> `POST /auth/otp/verify {phone, code, device}` -> if the user has no PIN the response says `pin_required`; `POST /auth/pin/set {pin}` (6 digits). Tokens: access JWT 15 min; refresh token 30 days, rotated on every use, stored hashed per device; reuse of an old refresh token revokes the device.
- Returning device: `POST /auth/pin/login {device_id, pin}`. 5 wrong PINs lock the account for 15 minutes.
- `POST /auth/totp/enroll`, `POST /auth/totp/verify` (cashier and auditor must enroll before first privileged action). `POST /auth/refresh`, `POST /auth/logout`, `GET /me`, `GET /me/devices`, `DELETE /me/devices/:id`.

**Resources**

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /members`, `GET /members/:id` | M | list with shares and payment-status summary; detail with that member's dues, payments, fines, ledger rows |
| `PATCH /members/me` | M | photo, notification prefs, digits setting |
| `PATCH /members/:id/contact` | C | correct phone/name (audited) |
| `GET /share-register` | M | informational register |
| `GET /dues?period&member_id`, `GET /fines` | M |  |
| `GET /matrix?from&to` | M | member x period grid: `{status, due, paid, fine, pending}` per cell |
| `POST /files` | A | multipart upload (image/PDF, max 10 MB), returns file id; images re-encoded, EXIF stripped |
| `GET /files/:id` | M | auth-checked download |
| `POST /payments` | A | member submission (5.4) |
| `GET /payments?status&member_id` | M | members see all payments with amounts and status; `raw_sms` and proof images visible only to the payer, C, U |
| `POST /payments/cashier-entry` | C | create and confirm |
| `POST /payments/parse-sms` | C | parser (5.4) |
| `POST /payments/:id/confirm`, `/reject` | C (step-up) |  |
| `POST /payments/:id/reverse-request`, `POST /approvals/:id/approve`, `/reject` | C requests; U decides |  |
| `GET /ledger?from&to&account&member_id&cursor` | M | rows include `hash`, objection badge |
| `GET /ledger/verify` | M | chain check result |
| `GET /accounts/balances` | M |  |
| `GET /nav` | M | 5.7 |
| `POST /objections`, `GET /objections`, `PATCH /objections/:id` | A creates; U resolves |  |
| `GET /proposals`, `GET /proposals/:id` | M | detail includes voter list and each vote |
| `POST /proposals` | A | create draft |
| `POST /proposals/:id/open`, `/close-early`, `/cancel` | C or U |  |
| `POST /proposals/:id/vote {choice}` | A (eligible) |  |
| `POST /proposals/:id/execute` | C (step-up); U for `role_change` |  |
| `GET /assets`, `GET /assets/:id` | M | with valuations and documents |
| `POST /assets/:id/documents` | C | attach file |
| `GET /rent`, `POST /rent/expected/:id/receive` | M read; C writes |  |
| `POST /rent/streams`, `PATCH /rent/streams/:id` | C |  |
| `POST /escrow-payouts`, `POST /settlements/:id/payouts/:pid/pay` | C (step-up) | only under approved proposals |
| `GET /members/:id/snapshots`, `GET /settlements` | M |  |
| `GET /constitution/current`, `/versions`, `/clauses?q=` | M |  |
| `POST /constitution/ack {version_id}` | A |  |
| `GET /notifications` | M | own list; `POST /notifications/:id/open` marks opened |
| `POST /devices` | M | register FCM token; `DELETE /devices/:id` |
| `GET /notifications/admin?period` | C, U | who got what, opened or not |
| `POST /notifications/nudge {member_id}` | C | manual reminder (rate limit 1 per member per 6 h) |
| `GET/POST /reconciliations`, `POST /reconciliations/:period/approve`, `POST /periods/:period/lock` | C submits; U approves and locks |  |
| `GET /reports/statement?member_id&period` | M (own or all) | PDF |
| `GET /reports/annual?year` | M | ZIP: PDF summary + CSVs |
| `GET /reports/export.csv?entity=ledger\|payments\|dues\|votes` | M |  |
| `GET /rules`, `GET /audit-log?cursor` | M rules; C, U audit |  |
| `GET /system/status` | C, U | last backup time/size/result, last restore test, last ledger verify, queue depth, disk free |
| `GET /health` | public | liveness and DB check |

Validation: every request body and query uses a zod schema from `packages/shared`; the web app imports the same schemas.

## 8. Web app, PWA and Android

**Principles:** mobile-first at 360 px width; desktop layout from 1024 px. Same codebase, same routes. Body text at least 16 px. Primary actions are large buttons reachable by thumb. Bengali is the default language; every string is an i18n key in `packages/shared/i18n/bn.json` and `en.json`. Setting `digits` switches between Bengali and Western numerals everywhere (money, dates, counts). Light and dark themes. All colours, radii, spacing, and fonts come from CSS variables in a single `theme.css` (the owner is a designer and will restyle it); ship a clean neutral default. Self-host the Noto Sans Bengali font (no external font requests). Status colours as tokens: `--ok` paid, `--warn` partial/pending, `--bad` overdue, `--muted` not due.

**Member layout (below 1024 px):** bottom tab bar with 5 tabs, header avatar menu top right.

| Route | Content |
| --- | --- |
| `/home` | big card: my outstanding principal + fines + next due date, 'Pay now' button; 'under verification' state when a pending payment exists; everyone's status for the current month as a list of name + tick/amount due; fund net assets and my shares' value; open votes banner; latest notices |
| `/pay` | my dues and fines list; how-to-pay card with copy buttons for the fund's bKash/bank numbers (editable setting `payment_instructions` in `rules`-like `settings` table, cashier edits); 'I have sent money' form (amount, method, TrxID, date, period hint, screenshot); my payment history with status and receipt |
| `/votes`, `/votes/:id` | open and past proposals; detail with payload rendering per type, quote for settlement/entry, voter list and choices, big Yes / No / Abstain buttons, countdown |
| `/assets`, `/assets/:id` | asset cards (kind icon, status, cost, latest valuation, rent summary), detail with documents, valuations history, rent history |
| `/constitution` | current PDF viewer, clause index with search, version history, 'I have read it' button for new versions, and every rule on `/rules` links to its clause |
| `/menu` (avatar) | profile, members and shares list, ledger (full, filterable, with objection button), statements (PDF), notice history, notification settings, devices, language and digits, logout |

**Cashier layout (1024 px and above):** left sidebar + content area, dense tables.

| Route | Content |
| --- | --- |
| `/admin` | dashboard: net assets, this month collected vs expected, overdue members, pending payments count, open proposals, today's to-do, backup status |
| `/admin/matrix` | member x month grid like the legacy sheet; click a cell for details; columns for totals; export CSV |
| `/admin/payments` | queue with filters; each row shows submission data, proof thumbnail, suggested match; keyboard shortcuts (J/K move, A approve, R reject); a textarea 'paste SMS' at the top that fills a cashier entry or highlights the matching pending row; bulk approve when each row has a suggested exact match |
| `/admin/ledger` | full table, filters, running balances per account, hash column, export |
| `/admin/members` | status, shares, register, nominees, status history; actions create proposals (suspend, reinstate, settle) rather than act directly |
| `/admin/proposals` | create, open (set `closes_at`), close early, execute, with checklists of preconditions |
| `/admin/assets`, `/admin/rent` | create assets via approved proposals only; rent streams and receipts |
| `/admin/notifications` | per-member delivery and open status, manual nudge |
| `/admin/reconcile` | monthly balances entry; auditor approval state; period locks |
| `/admin/reports` | statements, annual archive |
| `/admin/rules` | rules with clause links; changing a rule opens a `rule_change` proposal form |
| `/admin/system` | backup status, restore-test result, ledger verify, audit log |

Below 1024 px the cashier gets the same pages in a stacked mobile layout so urgent actions (confirm payment, vote) work on a phone. The auditor sees the cashier pages in read-only mode plus approvals.

**Behaviours:**

- Never use optimistic UI for money actions; wait for the server result.
- Every action that changes money shows a confirmation sheet summarising the effect.
- Errors: map problem `code` to Bengali messages; unknown codes show a generic message with a copyable request id.
- Loading skeletons, empty states, and pull-to-refresh on mobile lists.

**PWA:** `vite-plugin-pwa`. Manifest (name 'Barakah', Bengali short name, icons, `theme_color`). Service worker: precache the app shell; `NetworkFirst` for `/api/*` GET (cache last good response for read-only offline viewing of home, matrix, ledger, assets); never cache auth or write calls. Versioned cache names; on a new version show a toast 'Update available' with a reload button; clear old caches on activate. This must avoid the 'stale app until data is cleared' problem.

**Android (Capacitor):** `capacitor.config.ts` with `server.url` = production origin (read from env at build) so UI updates apply without a new APK; `androidScheme: 'https'`; offline fallback page. Store refresh token via secure storage plugin. Push: request notification permission after the first successful login with a Bengali rationale screen; register FCM token to `/devices`; handle notification taps by deep link to the relevant route and calling `/notifications/:id/open`. First-run onboarding screen asks the user to disable battery optimisation and enable autostart, with brand-specific text (Xiaomi, Oppo, Vivo, Samsung, Realme, other) and a button opening the relevant settings page where the platform allows; skippable but repeated once after 3 days if no push was ever received. In-app update check: `GET /app/version` returns minimum and latest native versions; show 'new app version' banner linking to the APK download URL (setting). Provide a script `pnpm android:release` that builds a signed APK/AAB using a keystore from env; document keystore backup in `RECOVERY-KIT.md`.

## 9. Background jobs (pg-boss)

All schedules in `Asia/Dhaka`. Date-dependent jobs run **daily** and check the rule values in the handler (so a rule change needs no reschedule). All handlers are idempotent and use the injectable `Clock`.

| Job | When | Action |
| --- | --- | --- |
| `generate_dues` | daily 00:10 | on `dues_generation_day` run 5.3 for the current period; if the job was missed, catch up every missing period |
| `generate_rent_expected` | daily 00:15 | on day 1 create `rent_expected` for active streams |
| `apply_fines` | daily 00:05 | on `fine_day` run 5.5; also catch up missed days |
| `update_warning_status` | daily 00:20 | 5.1 active/warning transitions |
| `remind_dues` | daily at `reminder_time` | between `reminder_start_day` and `reminder_end_day`: for each member with outstanding principal on any due (due today or earlier) and no pending payment, queue `due_reminder` (push; SMS fallback) |
| `notify_fines` | daily 09:00 | for fines created today queue `fine_notice` (push and SMS) |
| `sms_fallback` | every 15 min | notifications on channel push, template flagged fallbackable, `sent_at` older than `push_to_sms_fallback_hours`, `opened_at` null, no SMS yet -> send SMS once |
| `finalize_proposals` | every 5 min | finalize proposals past `closes_at`; send `vote_result` |
| `vote_closing_reminder` | hourly | proposals closing within 24 h: remind non-voters once |
| `lapse_proposals` | daily 00:30 | approved and unexecuted past the window -> `lapsed` |
| `pending_payment_alert` | hourly | pending payments older than `payment_pending_alert_hours` -> alert cashier (once per day per payment) |
| `rent_overdue_alert` | daily 09:30 | alert cashier |
| `cashier_daily_summary` | daily 08:30 | summary to cashier and auditor |
| `entry_quote_expiry` | daily | expire old entry quotes |
| `verify_ledger` | daily 03:00 | recompute chain; on failure SMS cashier and auditor immediately |
| `valuation_staleness_check` | weekly Mon 09:00 | notify cashier of stale valuations |
| `cleanup` | daily 04:00 | purge expired OTPs, refresh tokens, idempotency keys older than 24 h |

Backup and restore-test run as a separate sidecar container (Section 12), not in this process, so a crashed API does not stop backups. The API reads their result files for `/system/status`.

## 10. Notifications

**Engine:** `notify(memberId, template, payload, opts)` writes a `notifications` row per channel with `dedupe_key = template:memberId:entityIdOrDate` (unique; duplicates are skipped silently), then a worker sends. Push goes to all of the member's devices with `push_enabled` and a token; an FCM `UNREGISTERED` error disables that token. SMS goes through `SmsProvider`; failures retry 3 times with backoff then mark `failed` and alert the cashier. Members can disable push per device, but `fine_notice`, `suspension_notice`, `otp`, `settlement_payout` and `backup_failed` ignore SMS opt-out. Never send between 21:00 and 08:00 Asia/Dhaka except `otp` and `backup_failed`. SMS text is Unicode (about 70 characters per segment), so keep SMS templates short.

**Open tracking:** push payload carries `notification_id`; when the app opens from the notification or the user views the item, the client calls `POST /notifications/:id/open`.

**Channel policy and templates (Bengali, `{var}` placeholders; store in `i18n` under `notif.*`):**

| Template | Policy | Text |
| --- | --- | --- |
| `otp` | sms only | আপনার Barakah OTP: {code}। ৫ মিনিট বৈধ। কাউকে জানাবেন না। |
| `due_reminder` | push, then SMS fallback | {name}, {month} মাসের ৳{outstanding} বকেয়া, শেষ তারিখ {due\_date}। বিকাশ বা ব্যাংকে পাঠিয়ে অ্যাপে TrxID জমা দিন। |
| `fine_notice` | push and SMS | {name}, {month} মাসের বকেয়া সময়মতো না দেওয়ায় ৳{fine} ফাইন হয়েছে। মোট বকেয়া ৳{total}। মাফের আবেদনের জন্য অ্যাপ খুলুন। |
| `payment_submitted_ack` | push | আপনার ৳{amount} জমা পাওয়া গেছে, ক্যাশিয়ার যাচাই করছেন। |
| `payment_confirmed` | push, then SMS fallback | আপনার ৳{amount} পেমেন্ট গৃহীত হয়েছে। কোনো ভুল থাকলে অ্যাপে আপত্তি জানান। |
| `payment_rejected` | push and SMS | আপনার ৳{amount} জমা গ্রহণ করা যায়নি। কারণ: {reason}। |
| `vote_opened` | push | নতুন ভোট: {title}। শেষ সময় {closes\_at}। অ্যাপে ভোট দিন। |
| `vote_closing` | push | ভোট শেষ হতে ২৪ ঘণ্টা বাকি: {title}। আপনি এখনও ভোট দেননি। |
| `vote_result` | push | ভোটের ফল: {title}: {result} (হ্যাঁ {yes}, না {no})। |
| `suspension_notice` | push and SMS | {name}, ফান্ডের সিদ্ধান্তে আপনার সদস্যপদ {date} থেকে সাময়িক স্থগিত। বিস্তারিত অ্যাপে দেখুন। |
| `entry_quote` | push and SMS | {name}, ফান্ডে যোগদানের জন্য {shares} শেয়ারের মূল্য ৳{price}। {expires} পর্যন্ত বৈধ। |
| `settlement_payout` | push and SMS | আপনার সেটেলমেন্টের ৳{amount} পরিশোধ করা হয়েছে। |
| `constitution_updated` | push | গঠনতন্ত্রের নতুন ভার্সন {version} কার্যকর। পড়ে 'পড়েছি' চাপুন। |
| `cashier_daily_summary` | push (C, U) | আজ {unpaid\_count} জন বাকি, {pending\_count}টি পেমেন্ট যাচাইয়ের অপেক্ষায়। |
| `pending_payment_alert` | push (C) | {count}টি পেমেন্ট {hours} ঘণ্টার বেশি যাচাইয়ের অপেক্ষায়। |
| `rent_overdue` | push (C) | {stream}-এর {month} মাসের ভাড়া এখনও আসেনি। |
| `reconciliation_mismatch` | push (C, U) | {period} মাসের {account} হিসাবে ৳{diff} অমিল। |
| `backup_failed` | push and SMS (C, U) | Backup ব্যর্থ হয়েছে ({job})। অবিলম্বে দেখুন। |

Reminder rules: `remind_dues` skips a member who has a pending payment (they get no reminder, the home screen shows 'under verification') and stops the moment the outstanding principal reaches zero.

### 6.1 Addendum: settings table

Section 8 refers to editable settings. Add this table in the same migration set:

```sql
create table settings (
  key text primary key, value jsonb not null,
  updated_by uuid, updated_at timestamptz not null default now()
);
-- keys: fund_name, payment_instructions (bkash/nagad numbers, bank account text),
--       apk_download_url, app_min_version, app_latest_version, sms_enabled
```

Changes to `settings` are audited. `payment_instructions` is editable by the cashier.

## 11. Security requirements

- HTTPS only. The tunnel terminates TLS; the API trusts `X-Forwarded-*` only from the tunnel network. Use `helmet` defaults, HSTS, strict CSP (`default-src 'self'`, no third-party scripts or fonts), CORS limited to the app origin and the Capacitor origin.
- Secrets only from environment or Docker secrets, never in the repo. TOTP secrets are encrypted at rest (AES-256-GCM with `APP_ENCRYPTION_KEY`). PINs use argon2id. OTP codes and refresh tokens are stored as hashes (refresh tokens: SHA-256 with a server pepper).
- Rate limits: auth routes 10 per minute per IP; other routes 120 per minute per user; OTP limits as in Section 7.
- Uploads: sniff the real type, 10 MB cap, strip EXIF, store outside any static path, serve only through the authenticated route with `Content-Disposition`.
- SQL only through parameterised Kysely queries. No string-built SQL.
- Privacy inside the group: members see each other's payment status and amounts, the ledger, votes and assets. Members do **not** see other members' phone numbers, raw SMS text, proof images, devices or PINs; only the cashier and auditor see phones; raw SMS and proofs are visible to the payer, cashier, auditor.
- Audit log covers all writes plus sensitive reads (CSV exports, viewing raw SMS or proofs).
- No super-admin bypass and no impersonation. Direct database edits to append-only tables are blocked by triggers; the daily verifier would catch tampering anyway.
- Dependencies: pin versions, run `pnpm audit` in `pnpm check`, allow install scripts only for an explicit allowlist (`pnpm.onlyBuiltDependencies`).
- Devices: users can list and revoke devices; refresh-token reuse revokes the device.

## 12. Infrastructure, backup and restore

**Compose services** (`infra/docker-compose.yml`):

```yaml
services:
  db:
    image: postgres:16-alpine
    mem_limit: 384m
    shm_size: 128m
    command: >
      postgres -c shared_buffers=64MB -c effective_cache_size=256MB
      -c work_mem=4MB -c maintenance_work_mem=32MB -c max_connections=20
      -c wal_compression=on -c checkpoint_timeout=15min -c timezone=UTC
      -c log_min_duration_statement=500
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ['CMD-SHELL','pg_isready -U barakah_migrator'], interval: 10s }
  migrate:
    image: barakah-api:${TAG}
    command: ['node','dist/migrate.js']      # one-shot, runs before api
    depends_on: { db: { condition: service_healthy } }
  api:
    image: barakah-api:${TAG}                # serves /api and the built web app at /
    mem_limit: 384m
    depends_on: { migrate: { condition: service_completed_successfully } }
    volumes: [files:/data/files, archives:/data/archives, backupstatus:/data/status:ro]
    healthcheck: { test: ['CMD','node','dist/healthcheck.js'], interval: 30s }
  cloudflared:
    image: cloudflare/cloudflared:latest
    mem_limit: 64m
    command: tunnel run
    profiles: ['tunnel']
  backup:
    image: barakah-backup:${TAG}             # alpine + postgresql-client + age + rclone + restic + cron
    mem_limit: 128m
    volumes: [files:/data/files:ro, backups:/backups, backupstatus:/data/status]
volumes: { pgdata: {}, files: {}, archives: {}, backups: {}, backupstatus: {} }
```

The `backups` volume must be bind-mounted from a **different disk or path** than `pgdata`. Container logging: `json-file`, `max-size 10m`, `max-file 3`. Expected total memory use is 400 to 700 MB.

**Environment (`.env.example`):** `DATABASE_URL` (app role), `MIGRATOR_DATABASE_URL`, `APP_ENCRYPTION_KEY`, `JWT_SECRET`, `TOKEN_PEPPER`, `PUBLIC_ORIGIN`, `FCM_SERVICE_ACCOUNT_JSON_PATH`, `SMS_PROVIDER` (`console` or `http`), `SMS_HTTP_URL`, `SMS_HTTP_API_KEY`, `SMS_SENDER_ID`, `SMS_HTTP_BODY_TEMPLATE`, `BACKUP_AGE_RECIPIENTS`, `RCLONE_REMOTE`, `INTERNAL_ALERT_SECRET`, `TUNNEL_TOKEN`, `SHEETS_EXPORT_ENABLED` (default false).

**Build and deploy:** build images on a dev machine or CI (`docker buildx`), never on the server (a build can spike RAM by 1 to 2 GB). Ship with a registry push or `docker save | ssh server docker load`. Deploy = set `TAG`, `docker compose up -d`; the `migrate` service applies migrations first. No manual SQL in production.

**Backups (sidecar, cron 02:00 Asia/Dhaka):**

1. `pg_dump -Fc` the database, then encrypt with `age` to three recipients: cashier key, auditor key, and an `automation` key whose private half lives on the server (needed only for restore tests).
2. Write the encrypted dump to the local `backups` volume and upload it with `rclone` to the configured remote.
3. Back up `/data/files` incrementally with `restic` (encrypted) to the same two places.
4. Retention: daily 30 days; keep the first backup of each month forever; keep the year-end backup forever.
5. Write `status.json` (`started, finished, ok, size, sha256, error`) to the status volume. On failure call the API `POST /internal/alert` (header `X-Alert-Secret`) to raise `backup_failed`; if the API is down, send the SMS directly with a small script using the same SMS env.
6. The cashier copies a monthly encrypted backup to an offline external drive held by the auditor (manual step documented in `RUNBOOK.md`; `/system/status` shows when the last offline copy was confirmed).

**Restore test (sidecar, weekly, Sunday 03:30):** decrypt the newest backup with the automation key, restore into a throwaway Postgres container, run `verify-ledger`, compare per-account balances and row counts with the manifest stored in the backup, and write `restore-status.json`. Failure alerts the cashier and auditor.

**Disaster recovery (`RUNBOOK.md`, target RPO 24 h, RTO 4 h):** new host with Docker; clone the private infra repo; place env and keys from the recovery kit; `docker compose up db`; restore the latest backup; `docker compose up -d`; restart the tunnel; verify with `/ledger/verify` and the balances page. `RECOVERY-KIT.md` lists, without secrets in the repo: server access, where the age private keys are, Android keystore location, Firebase project, SMS gateway account, domain and Cloudflare account, registry and git access. A sealed paper copy of the secrets is kept by the auditor.

**Annual archive** (`POST /periods/:year/archive`, after all 12 periods are locked): write `/data/archives/YYYY/` with `statement-<member>.pdf`, `annual-summary.pdf`, `ledger.csv`, `payments.csv`, `dues.csv`, `fines.csv`, `votes.csv`, `proposals.csv`, `assets.csv`, `valuations.csv`, `members.csv`, the constitution PDF in force, a `documents/` copy, `SHA256SUMS` and a `README.txt` describing every file in plain language. The archive is included in backups.

**Optional read-only mirror:** when `SHEETS_EXPORT_ENABLED=true`, a nightly job writes dues matrix, payments and ledger to a Google Sheet through a service account (Sheets API). Default off.

**Monitoring:** `/health`, container healthchecks, `/system/status` for backup and verifier results. Document in `RUNBOOK.md` how to point an external uptime monitor at `/health`.

## 13. Data import (legacy Google Sheet)

Goal: load the 2026 history and opening balances for the cutover (default 1 Jan 2027), then prove the numbers match.

**Two stages** in `scripts/import-sheet/`:

1. `sheet-to-csv`: reads CSV exports of the legacy tabs placed in `import/raw/` and writes normalized CSVs to `import/normalized/` plus `import/review.csv` listing every row needing a human decision (what, where, why, suggested value).
2. `load`: validates normalized CSVs with zod and loads them through the **same service functions the API uses** (so dues, allocations and ledger hashes are real), with `source='import'`. Dry run by default; `--commit` to write.

The owner can edit the normalized CSVs to resolve review items, then re-run `load`.

**Normalized CSV schemas:**

| file | columns |
| --- | --- |
| `members.csv` | member\_key, full\_name, phone, joined\_on, status |
| `share_holdings.csv` | member\_key, shares, effective\_from |
| `share_register.csv` | share\_no, member\_key, registered\_name, nominee\_name, nominee\_relation |
| `dues.csv` | member\_key, period, kind (`monthly` or `start_boost`), shares\_snapshot, amount\_paisa, due\_date |
| `fines.csv` | member\_key, period, amount\_paisa, status (`paid`, `unpaid`, `waived`) |
| `payments.csv` | payment\_key, member\_key, amount\_paisa, method, trx\_id, paid\_at, note, raw\_sms |
| `allocations.csv` | payment\_key, member\_key, period, kind (`principal` or `fine`), amount\_paisa |
| `assets.csv` | asset\_key, kind, name, acquired\_on, cost\_paisa, quantity, unit, status, source\_account |
| `misc_ledger.csv` | entry\_date, debit\_account, credit\_account, amount\_paisa, memo, member\_key |
| `opening_balances.csv` | account, actual\_balance\_paisa, as\_of |
| `expected_totals.csv` | member\_key, principal\_paid\_paisa, fines\_paid\_paisa, principal\_outstanding\_paisa, fines\_outstanding\_paisa |

**Legacy sheet structure (for the converter):**

- `Share Holder`: a list of 20 rows (SL, registered name, nominee, relation, share price, responsible owner) and a second table of the 8 responsible owners with share counts (2, 4, 1, 1, 3, 1, 4, 4 in sheet order). The 8 owners are the **members**; the 20 rows become `share_register`, grouped to owners in sheet order using the counts.
- `Collection 26`: column A is the row label (`Start Boost`, then January to December), column B a due-date text; then per member a block of three columns (Status, Fine, Amount) separated by a blank column. Status values: `Paid`, `L Paid` (paid late, a fine was charged), `Unpaid`. Cells hold currency strings with a taka sign and commas; use `parseBDT`. `Start Boost` is a one-time due of `start_boost_per_share_paisa` per share dated 2025-12-31. Months are 2026-01 to 2026-12 with due date the 20th (if the label column disagrees, trust the 20th and add a review row).
- `Transection`: columns SL, payer, method, pay-for, payable, paid, due, message. A payment can span consecutive rows (blank pay-for continues the previous group). The message column holds the raw SMS or a note such as 'Paid by Baksh' or 'Paid by Bank Cheque'. Amount source order: parse from SMS, else the `paid` cell. Unresolvable rows go to `review.csv`. The sheet contains at least one duplicate TrxID across two rows; the loader must refuse duplicates and list them.
- `Investments`: date, description, amount, status. About 12 gold purchases and one 'Profit' row marked completed. Quantity, unit and current value are missing: create assets with null quantity and add review rows. Source account is unknown: default `BANK` and flag. The 'Profit' row maps to `OTHER_INCOME` with a memo and a flag.
- `Miscellaneous`: expense lines (such as a bank SMS charge), revenue lines (fine totals, bank interest) and a negative number in the revenue column labelled as a distribution. Do not import fine totals (fines come from payments). Bank interest -> `BANK_INTEREST`. The negative distribution -> `DISTRIBUTIONS`, flagged. Unlabelled scratch numbers are ignored and listed in `review.csv`.
- `Dashboard`: derived. Use only to cross-check TRUE/FALSE paid flags against `Collection 26` status.

Allocation on import: use `allocations.csv` when present; otherwise apply the default allocation per payment in date order.

**Verification (`pnpm import:verify`, must pass before cutover):** per member principal paid, fines paid, principal outstanding and fines outstanding equal `expected_totals.csv`; cash by account equals `opening_balances.csv` after posting an `OPENING_ADJUSTMENT` entry for any difference (shown on the reconciliation page with its memo for the auditor); `verify-ledger` passes; no negative outstanding; no duplicate TrxID.

**Cutover:** freeze the sheet; export tabs; run on staging; verify; owner and auditor review; run on production; keep the sheet read-only; run in parallel for 1 to 2 months with `pnpm compare:sheet` printing monthly differences between a fresh sheet export and the system.

## 14. Testing

### 14.1 Policy

Unit tests, integration tests against real Postgres (Testcontainers), and Playwright e2e. `pnpm check` (lint, types, tests, audit) must pass before any phase is called done.

### 14.2 Seed fixture

8 fictional members with shares `[2,4,1,1,3,1,4,4]`, fake phones `+8801700000001` to `+8801700000008`, one cashier and one auditor (different members), periods from 2026-01, default rules, accounts, deterministic UUIDs. Never include real names or numbers.

### 14.3 Mandatory test cases

- **Money:** lakh/crore grouping; Bengali digits; `parseBDT` variants; `divRound` half-up with positive and negative inputs.
- **Dues:** idempotent generation; share snapshot at period start; suspended excluded; credit auto-applied; a rule change affects only later periods.
- **Payments:** pending touches no ledger or NAV; duplicate TrxID (case and whitespace insensitive) returns 409; rejected TrxID can be resubmitted; confirm posts correct debit/credit for principal, fine and credit; oldest-first allocation; manual allocation validation; reversal approval restores outstanding; cashier entry notifies the member.
- **SMS parser:** the three formats plus garbage input.
- **Fines:** paid on the 20th gets no fine; unpaid on the 21st gets `shares * fine_per_share` (4 shares -> 200000 paisa); one fine per due; paid fine posts `FINE_INCOME`; waiver only via executed proposal.
- **Status:** warning transitions both ways.
- **Ledger:** UPDATE and DELETE raise; hash chain verifies; tampering by a superuser is detected by the verifier; locked period rejects entries; parallel inserts keep the chain linear.
- **NAV:** breakdown correct; stale valuation flagged; issuing shares at NAV leaves NAV per share unchanged within 1 paisa.
- **Voting:** thresholds for eligible 8 (5), 7 (4) and subject-excluded cases; vote change; early-close rules; finalize; lapse; execution preconditions; eligibility snapshot unaffected by later status changes; ineligible vote rejected.
- **Suspension and settlement:** snapshot immutable; no new dues or fines afterwards; reminders stop; distribution goes to escrow; reinstatement catch-up dues; the formula example (gross 1200000, escrow 50000, dues 500000, fines 100000 paisa -> net 650000); invariants 1 to 4; negative net blocks execution.
- **Notifications:** dedupe; quiet hours; SMS fallback after the configured hours; open tracking; opt-out exceptions.
- **Auth:** OTP expiry and attempt limits; PIN lockout; refresh rotation and reuse detection; a table-driven test over the route table asserting each route's allowed roles; read-only mode for suspended members.
- **Jobs (fake clock):** simulate January to December: dues on the 1st, reminders only on days 15 to 20 and only for unpaid members, fines on the 21st, no duplicate work on re-run.
- **Import:** fixtures shaped like the sheet CSVs (fake data) produce the expected normalized CSVs; verification catches an injected mismatch.
- **Backup:** `restore-test.sh` passes on the fixture database.
- **E2E (mobile and desktop viewports):** (1) OTP login and PIN set; (2) member submits payment, cashier pastes SMS and approves, member sees confirmed; (3) fine appears after advancing the clock to the 21st and the notification is recorded; (4) proposal create, open, 5 of 8 vote yes, execute a fine waiver; (5) suspension, settlement quote, vote, execute, instalment payout.

## 15. Phases and acceptance criteria

Delivery target from the owner's plan: Phases 1 and 2 usable before 20 Dec 2026 so January 2027 dues run in the system; Phases 3 to 5 by March 2027.

| Phase | Scope | Done when |
| --- | --- | --- |
| 0. Scaffolding | monorepo, tooling, Docker dev stack, baseline migrations, health route, theme and i18n skeleton, `CLAUDE.md` | `pnpm check` green; dev stack starts from scratch; migrations apply to an empty DB |
| 1. Collection core | auth (OTP, PIN, TOTP, devices), members, shares, share register, rules, accounts, dues, payments (submit, confirm, reject, cashier entry, SMS parser, reversal approvals), allocations, ledger with hash chain and triggers, audit log, files, objections, matrix; member screens (home, pay, menu, ledger); cashier screens (dashboard, matrix, payments, ledger); importer and verification | Section 14 cases for money, dues, payments, ledger, auth pass; e2e (1) and (2) pass; importer verify passes on fixtures; seeded stack demonstrable end to end |
| 2. Notifications and automation | notification engine, FCM, `SmsProvider`, templates, all jobs in Section 9 except governance ones, Capacitor Android build, onboarding screens, PWA update behaviour, admin notifications page, nudge | simulated-year jobs test passes; e2e (3) passes; signed debug APK installs and receives a test push (manual checklist in `docs/PHASE-2.md`) |
| 3. Governance | proposals and voting, constitution tab and versions with clause links, member status machine, suspension, reinstatement, settlement, new-member entry, `rule_change`, `role_change`, executors, settings table | voting, suspension, settlement and invariant tests pass; e2e (4) and (5) pass |
| 4. Assets and NAV | assets, valuations, NAV page, rent streams and receipts, sale, distribution, escrow payout | NAV tests, new-member invariance, asset lifecycle tests pass |
| 5. Audit and operations | reconciliation, period locks, annual archive, PDF statements, CSV exports, ledger verify page, system status, backup and restore sidecar, runbook, recovery kit, optional sheet mirror | restore test passes on seeded data; tamper-detection test passes; archive generated for the fixture year |
| 6. Hardening and handover | security checklist, dependency audit, performance sanity (p95 under 300 ms for main endpoints on 100k ledger rows), accessibility pass on member screens (contrast, 200 percent font scaling), Bengali copy review list, final docs | all tests green; `docs/GO-LIVE.md` checklist complete |

After each phase write `docs/PHASE-N.md` and stop for owner review; do not start the next phase unprompted if the instructions of the session say to stop.

## 16. Assumptions register

These defaults resolve open questions so the build never blocks. Each lives in a rule, a setting or one isolated module so it can change later.

| # | Assumption | Where it lives |
| --- | --- | --- |
| 1 | One fine per late due, never compounding | 5.5 |
| 2 | Fines enter the ledger only when paid | 5.5 |
| 3 | Payment allocation is oldest principal, then fines | rule `allocation_order` |
| 4 | Settlement uses a fresh NAV quote at proposal creation; the suspension snapshot is a record | 5.10 |
| 5 | The subject of a suspension, settlement, reinstatement, fine waiver or role change does not vote on it | 5.8 |
| 6 | Votes are public and changeable until close | 5.8 |
| 7 | Early close only when the outcome is decided | 5.8 |
| 8 | The Android shell loads the web app from the server URL | 8 |
| 9 | PIN and OTP are 6 digits; OTP valid 5 minutes | 7 |
| 10 | Quiet hours 21:00 to 08:00 for non-critical notifications | 10 |
| 11 | Reminders pause while a payment is pending verification | 9 |
| 12 | Reinstatement catch-up charges no fines by default | rule `reinstatement_charges_fines` |
| 13 | A negative settlement blocks until the shortfall is settled | 5.10 |
| 14 | Rent receipts and stream setup need no vote; maintenance spending does | 5.11 |
| 15 | Imported gold purchases default to source account `BANK` and are flagged | 13 |
| 16 | Cutover date 1 Jan 2027 | 13 |
| 17 | SMS gateway is a generic HTTP adapter; the real provider is chosen later | 2, 12 |
| 18 | Sheet mirror is optional and off by default | 12 |
| 19 | Other members' phone numbers are hidden from regular members | 11 |
| 20 | An automation backup key is held on the server for restore tests | 12 |
| 21 | Entry quote valid 7 days; stale valuations block quoting | 5.9 |
| 22 | Exactly one cashier and one auditor at a time, never the same person | 5.1 |

## 17. Out of scope for v1

iOS native app; multiple funds or tenants; bKash or Nagad payment APIs (payments are verified by the cashier); WhatsApp; email; tax calculation; multi-currency; self-registration; OCR of screenshots (SMS text parsing only); in-app chat; accounting reports beyond those listed.

## 18. Constitution alignment (amends and overrides earlier sections)

The group's signed written constitution (the *nitimala*, 14 articles) is the highest authority. **Where this section conflicts with Sections 5 to 17, this section wins.** Sections affected: 5.1, 5.2, 5.4 to 5.8, 5.10, 6, 9, 10, 11, 14.3, 15, 16.

- Clause references below use the constitution's own numbers (for example `2.3` = article 2, clause 3). Every rule row and every proposal policy must carry its `clause_ref`.
- The constitution text is group-specific. Store it outside the public repository: `private/constitution_v1.bn.md` (git-ignored). Seed `constitution_versions` and `constitution_clauses` from that file at deploy time. The repo ships only `examples/constitution.example.md`.
- The ethical-finance rules (interest-free finance, fines and interest routed to charity, investment checklist) are implemented as a **compliance pack** controlled by `compliance.interest_free` (default `true` for this deployment). With it off, the system behaves as an ordinary fund. This keeps the code reusable for other groups.
- Items marked **OWNER DECISION** are contradictions or gaps in the constitution. Implement the stated default as a configurable rule, show a visible 'rule conflict' banner to the cashier and auditor until the group resolves it by a `constitution_amendment` or `rule_change` proposal, and list the item in `docs/ASSUMPTIONS.md`.

### 18.1 Rule values taken from the constitution

| Rule key | Value | Clause | Notes |
| --- | --- | --- | --- |
| `fund_term_start`, `fund_term_end` | 2026-01-01, 2028-12-31 | 1.2 | No dues generated after the end; wind-up flow (18.6) applies |
| `monthly_due_per_share_paisa` | 500000 | 1.4 | Changes or round-off boosts need a unanimous `contribution_change` proposal |
| `fine_per_share_paisa` | 50000 | 2.2 | Fines are charity money (18.2) |
| `suspension_after_consecutive_unpaid_months` | 3 | 2.4 | Dues and fines unpaid for 3 consecutive months |
| `final_notice_days` | 7 | 2.4 | Default; the constitution gives no length. OWNER DECISION |
| `auto_suspend` | true | 2.4 | Suspension follows the final notice without a vote; see 18.5 |
| `early_exit_service_charge_percent` | 10 | 5.1 | Of paid-in capital, exits before `fund_term_end` |
| `feasibility_threshold_paisa` | 10000000 | 12.2 | 1,00,000 BDT; investments above need a feasibility report |
| `big_financial_threshold_paisa` | 10000000 | 4.2, 12.2 | Expenses at or above this use share-weighted voting |
| `absence_fine_paisa` | 50000 | 9.2 | Per member (not per share), charity money |
| `absence_fine_after_consecutive` | 3 | 9.2 | Consecutive unexcused absences from monthly meetings |
| `meeting_window_start_day`, `meeting_window_end_day` | 10, 12 | 9.1 | Online meeting |
| `inactive_after_months_no_contact` | 3 | 13.1 | Plus a registered letter, then 1 month wait (13.2) |
| `inactive_wait_days_after_letter` | 30 | 13.2 |  |
| `compliance.interest_free` | true | 3.1, 6, 11 | Compliance pack |

**OWNER DECISION: due and fine dates.** Clause 2.1 says pay between the 1st and 15th; clause 2.2 charges the fine after the 10th. These contradict each other. The legacy sheet practice is due on the 20th and fine on the 21st. Default: keep `due_day=20`, `fine_day=21` (what the group actually follows) and show the conflict banner until the constitution is amended. Reminders keep the 15th to 20th window.

**OWNER DECISION: member and share counts.** The constitution states 7 members and 19 shares; the legacy sheet has 8 members and 20 shares. Never hard-code either. All logic uses holdings. The importer records the difference in `review.csv` and the cashier should record the change with a `general` or `constitution_amendment` proposal.

### 18.2 Charity money (replaces `FINE_INCOME` treatment)

Under 2.3, 3.1(b) and 9.2, late fines, absence fines and any bank interest received are **not fund income and not member profit**. They must be donated at year end.

- New liability account `CHARITY_PAYABLE`. It is **not** part of net assets: subtract its balance in the NAV formula (5.7).
- A paid late fine or absence fine posts `DR <method account>`, `CR CHARITY_PAYABLE`. Remove `FINE_INCOME` from use (keep the account row for legacy compatibility but block new postings).
- Bank interest that arrives is posted `DR BANK`, `CR CHARITY_PAYABLE` with `ref_type='riba_received'`. Profit from a profit-sharing bank account is income (`BANK_PROFIT`, replacing `BANK_INTEREST`) only when the cashier tags it `permitted_profit` and the auditor approves; default for untagged bank credits is charity.
- Donation flow: `charity_donation` proposal (member-based majority) with recipient name, amount (not more than the balance) and purpose. Execute posts `DR CHARITY_PAYABLE`, `CR <method account>` and requires a proof file (receipt). A `charity_year_end` job notifies the cashier and auditor on 15 December with the amount still to donate.
- Show 'charity balance to donate' on the cashier dashboard and the members' home screen.
- The fine waiver (5.5) stays available as a member-majority proposal, but the constitution is silent about waivers and the fine is charity money. **OWNER DECISION:** keep or remove waivers. Default: keep, and show a warning on the proposal form.
- Importer: legacy fines paid and any legacy bank profit lines map to `CHARITY_PAYABLE` and are flagged in `review.csv` (the legacy sheet counted a fine total as revenue).

### 18.3 Voting policies (replaces the single rule in 5.8)

The constitution defines two voting bases (4.1: one member one vote; 4.2: one share one vote for financial matters), plus unanimity for some matters. Implement a `proposal_policies` table; each proposal copies its policy at open time.

| Proposal type | Basis | Threshold | Clause |
| --- | --- | --- | --- |
| `general`, `role_change`, `rule_change` (minor), `reinstatement`, `fine_waiver`, `charity_donation`, meeting and administrative matters | member | more than 50% of eligible members | 4.1 |
| `investment_purchase`, `asset_sale`, `distribution`, `financing_arrangement`, `dissolution`, `wind_up`, land selection, project closure, `valuation_update` | share | more than 50% of eligible share weight | 4.2, 12.2 |
| `expense` at or above `big_financial_threshold_paisa` | share | more than 50% | 4.2 |
| `expense` below the threshold, `member_qard` | member | more than 50% | 4.1 |
| `new_member`, outside buyer of a leaving member's share | member | unanimous (every eligible member votes yes) | 5.3 |
| `contribution_change` (boost or round-off) | member | unanimous | 1.4 |
| `constitution_amendment` | member | unanimous | OWNER DECISION: the constitution has no amendment clause; default unanimous |
| `settlement` for early exit, compassionate exit | member | more than 50% | 5.1, 5.2 |
| `dissolution` (early end of project) | share | more than 50% | 10.2, 4.2 |

Mechanics: `proposal_voters.weight` = the voter's shares at open time for basis `share`, 1 for basis `member`. `eligible_weight` = sum of weights. Majority: `yes_weight >= floor(eligible_weight / 2) + 1`. Unanimous: `yes_weight = eligible_weight` (abstain or no blocks). Early close rule (5.8) uses weights. With 19 eligible shares the share threshold is 10; with 20 it is 11; with 7 eligible members the member threshold is 4.

**Conflict with an earlier owner choice:** during planning the owner chose one vote per person for everything. The constitution says otherwise for financial matters. The constitution wins; confirm with the group.

**Feasibility report and compliance checklist (12.2, 11.2, 12.1):** an `investment_purchase` proposal must include a boolean checklist, all required to be true to open the proposal: `interest_free_instrument`, `not_conventional_fixed_deposit`, `not_conventional_insurance`, `not_speculative_trading`, `permissible_business`, `liquidatable_within_term`, `no_fixed_profit_promised`. If `amount > feasibility_threshold_paisa`, a feasibility report file is also required. Store the checklist in `proposals.payload` and copy it to `assets.compliance`. Labels come from i18n so other groups can change them.

### 18.4 Accounts and NAV changes

Add accounts (kind in brackets): `CHARITY_PAYABLE` (liability), `BANK_PROFIT` (income, replaces `BANK_INTEREST`), `EXIT_FEE_INCOME` (income), `LEVY_CLEARING` (liability), `INACTIVE_HELD` (liability, per member), `MEMBER_QARD` (liability, per member), `DEFERRED_PURCHASE_PAYABLE` (liability).

NAV (5.7) becomes: `net_assets` = cash accounts + latest valuations of held assets - `SETTLEMENT_PAYABLE` - `MEMBER_ESCROW` - `CHARITY_PAYABLE` - `LEVY_CLEARING` - `INACTIVE_HELD` - `MEMBER_QARD` - `DEFERRED_PURCHASE_PAYABLE`. `shares_outstanding` excludes `inactive` members.

**Capital ratio vs share ratio (note 11.3(b)):** the constitution shares profit and loss by capital ratio. Because all members pay the same per-share monthly amount, share ratio equals capital ratio for members who are up to date, and the settlement formula already deducts arrears. The system keeps the share-ratio NAV (required for fair entry of new members) and shows capital contribution per member next to it. OWNER DECISION: confirm this is acceptable.

### 18.5 Member statuses and procedures (replaces 5.1 transitions where different)

Add status `inactive`. Add `member_contact_log(member_id, kind, note, at, by)` for calls, messages and the registered letter.

- **Suspension (2.4):** the daily status job marks a member `warning` after 2 consecutive unpaid months (courtesy) and issues a **final notice** (push, SMS and a PDF) after 3 consecutive unpaid months of dues and fines. After `final_notice_days` without payment of all arrears, with `auto_suspend` true, the system creates and executes a `suspension` proposal automatically (policy: no vote; auditor is notified; any member can open a review vote). Suspension effects stay as in 5.10. OWNER DECISION: whether suspended members keep profit rights; default keep (capital and shares stay, distributions go to escrow).
- **Inactive (13):** if a member has 3 or more consecutive unpaid months and the cashier has logged no successful contact, the system shows a checklist: send registered letter (log it), wait 30 days. After that the cashier may declare the member inactive with auditor approval (`approvals.kind='inactive_declaration'`). Effect: no profit participation; post `DR MEMBER_CAPITAL`, `CR INACTIVE_HELD` for the member's paid-in principal; shares leave `shares_outstanding`; no more dues or fines. When the member returns, or at term end, refund = paid-in principal minus unpaid fines and costs, no profit.
- **Death (8):** the nominee on the share register automatically becomes the owner. Cashier records the death with a document; auditor approves (`approvals.kind='death_surrender'`). Nominee chooses: (a) **continue**: shares move to a new member record for the nominee, status `active`, no entry price, dues continue to term end; (b) **surrender**: settlement with profit (NAV-based formula of 5.10).
- **Share transfer (5.3):** a leaving member's share is offered to current members first (record offers and acceptance); a sale to an outsider is a `new_member` proposal requiring unanimity.

### 18.6 Settlement types (replaces the single formula in 5.10)

`settlements.kind` selects the formula. `paid_in_capital` = sum of confirmed principal contributions (not fines, not charity).

| Kind | When | Refund | Profit |
| --- | --- | --- | --- |
| `early_exit` | member leaves before `fund_term_end` (5.1) | `paid_in_capital * (100 - 10) / 100` minus unpaid fines and costs. The 10% retained posts to `EXIT_FEE_INCOME` | none |
| `compassionate_exit` | life-threatening illness or serious accident of member or family (5.2); needs a document and a member vote | `paid_in_capital`, no service charge | none |
| `inactive_return` | inactive member returns or term ends (13.2) | `paid_in_capital` minus unpaid fines and costs | none |
| `death_surrender` | nominee surrenders (8.2) | NAV-based gross (5.10 formula) with deductions | included |
| `wind_up` | term end, or early dissolution (10.2) | every member receives `shares * NAV` after all assets are sold or valued; ratio by shares | included |

For `early_exit`, `compassionate_exit` and `inactive_return` the money kept back from the refund beyond what is posted to `EXIT_FEE_INCOME` (the member's unpaid profit share) simply remains in the fund and raises NAV for the others. Posting: `DR MEMBER_CAPITAL`, `CR SETTLEMENT_PAYABLE` for the refund; the difference between `paid_in_capital` and the refund is handled by the formulas above. Invariant 1 in 5.10 applies only to `death_surrender` and `wind_up`. New invariants for the other kinds: refund never exceeds `paid_in_capital`; refund is non-negative; fee equals exactly 10% for `early_exit`.

**Wind-up at term end (1.2, 10.2):** a `wind_up` proposal (share basis) lists assets to sell and the distribution plan. Sales go through `asset_sale`. The final distribution uses `distribution` per share. After the last payout all members become `exited` and the fund status becomes `closed` (no postings except charity donations still owed).

### 18.7 Other constitutional features

- **No loans to members (6.1, 11.1):** there must be no feature that lends money to a member. Add an automated test `no_loan_path`: every ledger entry that credits a cash account in favour of a member must reference a settlement, distribution, escrow payout, or charity donation proposal result (no others).
- **Registration, VAT and tax levy (6.2):** `levy` due kind. An executed `asset_cost_levy` proposal creates levy dues for active members in proportion to shares on a due date. Payments with purpose `levy` post `DR <method account>`, `CR LEVY_CLEARING`; the later payment to the registrar posts `DR LEVY_CLEARING`, `CR <method account>`. Levy is never fund capital and never in NAV.
- **Financing (6.3):** no interest-bearing loan path exists. Allowed records: `member_qard` (interest-free loan from a member to the fund): `DR <method account>`, `CR MEMBER_QARD` with proposal, repayment with proposal; and `financing_arrangement` (deferred purchase or hire purchase through an interest-free bank): a record with attachments, with instalments posted `DR DEFERRED_PURCHASE_PAYABLE`, `CR <method account>`.
- **Property title (7):** `assets` gains `legal_owner_name`, `ownership_split` (jsonb: member and share count) and `compliance`. For `land` and `house`, status cannot become `held` until a deed document is attached and `ownership_split` sums to the total shares in the fund.
- **Meetings (9):** tables `meetings(id, scheduled_for, link, status, notes)` and `meeting_attendance(meeting_id, member_id, status in present, absent_excused, absent_unexcused, reason)`. On `meeting_window_start_day - 5` a job creates a meeting draft; the cashier sets the time; reminders go one day and one hour before. After the meeting the cashier marks attendance. When a member reaches `absence_fine_after_consecutive` consecutive `absent_unexcused`, create a fine of kind `absence` (charity money, 18.2) and notify the member.
- **Zakat information (14):** `GET /reports/zakat-statement?member_id&as_of` returns a PDF with the member's paid-in capital, current share value (valuation based, labelled an estimate), pending dues, and a note that each member calculates their own obligation. The cashier sets `zakat_notice_date` each year before Ramadan; a job then sends everyone a `zakat_info` notification with the PDF. The system gives figures only, no religious calculation.
- **Ledger, proof and audit (3.2 to 3.4):** the app replaces the Google Sheet and the WhatsApp screenshots; recommend recording that with a `constitution_amendment` proposal. Clause 3.4 requires a yearly audit by a non-manager member: add `approvals.kind='annual_audit'` where the auditor signs the year; the annual archive (12) is incomplete without it. The cashier is the 'manager' of the constitution.
- **Dissolution and disputes (10):** disputes are decided by majority (use the `general` policy). Early dissolution uses `dissolution`/`wind_up` (share basis).

### 18.8 Schema changes (fold into the base migrations, do not add alter-migrations before first release)

- `members.status` also allows `inactive`.
- `fines`: `due_id` nullable; add `kind` (`late_payment`, `absence`) and `meeting_id`.
- `dues.kind` also allows `levy`; `payments.purpose` also allows `levy`.
- `proposals`: add `basis` (`member`, `share`), `threshold_kind` (`majority`, `unanimous`), `eligible_weight`, `threshold_weight`, `yes_weight`, `no_weight`, `abstain_weight`; keep the count columns for display. `proposal_voters.weight int not null default 1`.
- `approvals.kind` also allows `annual_audit`, `inactive_declaration`, `death_surrender`.
- `assets`: add `legal_owner_name`, `ownership_split jsonb`, `compliance jsonb`, `feasibility_file_id uuid`.
- `settlements.kind` text with the five kinds above.
- New tables:

```sql
create table proposal_policies (
  type text primary key,
  basis text not null check (basis in ('member','share')),
  threshold_kind text not null check (threshold_kind in ('majority','unanimous')),
  amount_threshold_paisa bigint,            -- policy switches to share basis at or above this amount (expense)
  clause_ref text, requires_feasibility boolean not null default false
);
create table meetings (
  id uuid primary key default gen_random_uuid(),
  scheduled_for timestamptz, link text,
  status text not null default 'draft' check (status in ('draft','scheduled','held','cancelled')),
  notes text, created_at timestamptz not null default now()
);
create table meeting_attendance (
  meeting_id uuid not null references meetings, member_id uuid not null references members,
  status text not null check (status in ('present','absent_excused','absent_unexcused')),
  reason text, primary key (meeting_id, member_id)
);
create table member_contact_log (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members,
  kind text not null check (kind in ('call','message','email','registered_letter','visit')),
  outcome text, note text, at timestamptz not null default now(), by uuid not null
);
create table charity_donations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals, recipient text not null,
  amount_paisa bigint not null check (amount_paisa > 0), proof_file_id uuid references files,
  donated_on date not null, ledger_seq bigint
);
```

### 18.9 Additional jobs and notifications

| Job or template | When | Action |
| --- | --- | --- |
| `final_notice` job | daily, after the fine job | members with 3 consecutive unpaid months get a final notice (push and SMS, PDF) once |
| `auto_suspend` job | daily | executes suspension after `final_notice_days` if arrears remain and `auto_suspend` is true |
| `inactive_candidates` job | weekly | lists candidates for the cashier checklist |
| `meeting_draft`, `meeting_reminder` | by day and hourly | see 18.7 |
| `charity_year_end` | 15 December | cashier and auditor reminder with the balance |
| `zakat_info` | on `zakat_notice_date` | notification plus statement PDF |

Bengali texts (add to Section 10 under `notif.*`):

| Template | Policy | Text |
| --- | --- | --- |
| `final_notice` | push and SMS | {name}, টানা ৩ মাস চাঁদা ও জরিমানা বকেয়া। {days} দিনের মধ্যে ৳{total} পরিশোধ না করলে নীতিমালার ২.৪ ধারা অনুযায়ী সদস্যপদ স্থগিত হবে। |
| `meeting_reminder` | push | {date} {time}-এ মাসিক মিটিং। লিংক অ্যাপে আছে। |
| `absence_fine` | push and SMS | {name}, কারণ ছাড়া টানা {count}টি মিটিংয়ে অনুপস্থিতির জন্য ৳{amount} জরিমানা হয়েছে (দান তহবিলে যাবে)। |
| `charity_year_end` | push (C, U) | বছর শেষ: দান করার বাকি জরিমানা ও অন্যান্য অর্থ ৳{amount}। |
| `zakat_info` | push | আপনার জমা মূলধন ও বর্তমান আনুমানিক মূল্যের বিবরণ সংযুক্ত। যাকাত আপনি নিজে হিসাব করবেন। |

### 18.10 Extra tests (add to 14.3)

- Late and absence fines post to `CHARITY_PAYABLE`, never to income; NAV excludes the charity balance; donation cannot exceed the balance and needs proof.
- Voting: share basis with 19 and with 20 eligible shares (thresholds 10 and 11); unanimity blocked by one abstain; policy copied at open and unaffected by later policy edits.
- Early exit: capital 1,000,000 paisa gives refund 900,000 and `EXIT_FEE_INCOME` 100,000; compassionate exit refunds the full 1,000,000; refund never exceeds capital.
- Inactive: shares leave `shares_outstanding`, principal moves to `INACTIVE_HELD`, no dues or fines afterwards; return refunds principal minus fines and costs.
- Final notice and auto-suspension timeline over a simulated clock (3 unpaid months, notice, 7 days, suspension, review vote).
- `no_loan_path` test described in 18.7.
- Investment proposal cannot open with a false checklist item, or without a feasibility file above the threshold.
- Levy dues are created per shares and never enter NAV.
- Absence fine after 3 consecutive unexcused absences; none after an excused one.
- Zakat statement lists capital, estimated value and the disclaimer.
- Term end: no dues after `fund_term_end`; wind-up distributes by shares.

### 18.11 Phase mapping

- **Phase 1:** charity account and fine routing (18.2 without donations UI), `fund_term_*` rules, new account list and NAV exclusions, `proposal_policies` seed and schema (even though voting UI is Phase 3).
- **Phase 2:** meeting reminders, final notice templates.
- **Phase 3:** weighted and unanimous voting, statuses (`inactive`), final notice and auto-suspension, settlement kinds, contact log, charity donations, constitution tab seeded from the private file.
- **Phase 4:** compliance checklist, feasibility file, levy, `member_qard`, `financing_arrangement`, property title fields, wind-up.
- **Phase 5:** zakat statement, annual audit sign-off, annual archive including charity statement.

### 18.12 Additional OWNER DECISION list for the group meeting

1. Fix the date conflict between 2.1 and 2.2 (due day, fine day).
2. Confirm member and share counts (7/19 in the document versus 8/20 in the sheet) and record the change.
3. Keep or remove fine waivers (the fine is charity money).
4. Do suspended members keep profit rights?
5. Amendment procedure (default unanimous).
6. What 'majority' means in 12.2 for investments (default share-weighted per 4.2).
7. Where the 10% early-exit charge goes (default fund income).
8. Capital ratio versus share ratio for profit and loss (18.4).
9. Replace the Google Sheet and WhatsApp proof with the app (3.2, 3.3).
10. Record the legacy 'Start Boost' as an approved contribution change (1.4).
11. Wind-up procedure at term end (default `wind_up` proposal, share basis).
12. Absence fine is per member (default) or per share.
13. Length of the final-notice period (default 7 days).

## 19. Amendments after design review (override earlier sections)

This section wins over Sections 0 to 18 where they differ.

### 19.1 Authentication without SMS OTP (replaces the auth part of Section 7)

The group issues credentials in person. No SMS is needed to log in.

- Remove the OTP flow: no `otp_codes` table, no `otp` notification template, no `/auth/otp/*` routes.
- `members.code` (text, unique, short like `M01`) is the login reference. Phone numbers are only for contact and optional SMS; they are visible to the cashier and auditor only.
- `users.status`: `pending_activation`, `active`, `disabled`. New users start as `pending_activation`.
- **Activation code:** the cashier (with step-up TOTP) calls `POST /members/:id/activation-code`. The server creates an 8-character code (Crockford base32), stores only its hash in `activation_codes(id, user_id, code_hash, expires_at, consumed_at, attempts, created_by, created_at)`, shows it once as text and as a QR payload (`barakah://activate?ref=M01&code=...`). Valid 24 hours, single use, at most 5 attempts; creating a new code invalidates earlier ones.
- **Activation:** `POST /auth/activate {member_ref, code, device:{label, platform, install_id}, pin}`. The member chooses their own PIN in front of the cashier; the cashier never learns it. PIN is 6 digits, rejected if on a deny-list (`000000`, `123456`, all-same digits, simple sequences). On success create the device record and return tokens.
- **Login:** `POST /auth/login {member_ref, pin, device_id}` works only on a registered device. 5 wrong PINs lock the account for 15 minutes; the cashier can unlock. Access and refresh tokens are bound to `device_id`.
- **Device policy:** rule `max_devices_per_member` = 1 (cashier and auditor: 2, for phone plus desktop). A second device returns `auth.device_limit`. Replacing a device (lost phone, forgotten PIN, new phone) happens only by a new activation code, which revokes all old devices and refresh tokens.
- **Device events feed:** table `device_events(id, user_id, kind in registered, revoked, reset, at, by)`. Every event shows in a security feed visible to all members ('Member M03: new device registered, 1 Jan'), sends a push to the auditor, and is written to `audit_log`. This is the control against the cashier activating someone else's account.
- **Cashier and auditor** must enrol TOTP at first login and use it for step-up (payment confirm, proposal execute, approvals, activation codes). If one of them loses TOTP, the other resets it with a notice to all members.
- **Install identity:** `install_id` is a random value generated on first run and kept in secure storage on Android (Capacitor secure storage) and IndexedDB on the PWA. The PWA shows a warning that clearing browser data needs reactivation. The Android APK is the recommended path.
- **SMS default off:** `settings.sms_enabled=false` by default and `SMS_PROVIDER=console`. Channel policy becomes push plus in-app inbox. The cashier dashboard shows a daily list 'members not reachable by push' (no token, push disabled, or not opened for the configured hours) so the cashier can phone them. If `sms_enabled` is turned on later, the existing fallback rules apply.
- **Tests:** activation code expiry, single use, attempt limit, new code invalidates old; device limit; lockout and cashier unlock; device reset revokes refresh tokens; device events visible to every member; PIN never stored or logged in clear; TOTP step-up required for activation-code creation.
- **UI:** screens are Activation (type code or scan QR) -> Set PIN -> Home, then PIN pad only on a registered device, plus a Bengali 'device reset needed, ask the cashier' screen. The OTP screen in the generated design is replaced by these.

### 19.2 NAV: assets still being acquired

An asset with status `acquiring` counts in net assets at the amount paid so far (sum of ledger postings to `INVESTMENTS_AT_COST` for that asset) until it becomes `held` with a valuation. Sold assets count zero. This corrects the omission of in-progress land purchases in Section 5.7.

### 19.3 Payment method labels

Data values stay `bkash`, `nagad`, `bank`, `cash`, `other`. UI labels must be unambiguous: **bKash**, **Nagad**, **Bank**, and **Cash in hand** (Bengali: হাতে নগদ). Do not label Nagad as 'নগদ'.

### 19.4 Audit log scope

Log every write and only sensitive reads: CSV and PDF exports, viewing raw SMS or payment proof images, security and device views. Do not log ordinary page or vote views.

### 19.5 Seed and sample data consistency

The seed fixture and any demo data must obey the rules: no spending before its approved proposal; rent status comes from one source (`rent_expected`) and every screen reads it; dashboard numbers are computed, never typed.

### 19.6 Reference design

The folder `design/` holds a generated UI (`Barakah_Fund_UI.html` and `.pdf`) plus a supplementary canvas of extra screens. Treat them as visual reference for layout, tone, colours and Bengali copy, **not** as code to copy. Known fixes are in `docs/UI-NOTES.md`.

### 19.7 Phase impact

Phase 1 now includes the activation-code auth in 19.1 instead of OTP login. Phase 2 sets SMS disabled by default and builds the 'not reachable by push' list.
