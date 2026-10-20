# Go-live checklist

Go through this before real members use the app with real money. Everything under "Built and checked" was verified during the build; everything under "You must do before launch" needs a person.

## Built and checked

- [x] Security checklist (Doc.md 11) reviewed against the code: strict CSP and headers, CORS limited to the app, argon2id PINs, hashed tokens and codes, encrypted authenticator secrets, parameterised SQL only, uploads sniffed and served only through the signed-in route, install scripts limited to an allowlist, rate limits (auth routes 10 per minute per IP, other routes 120 per minute per signed-in user), audit log of every write and every statement, export and archive download. Details in `docs/PHASE-6.md`.
- [x] Dependency audit: `pnpm audit --audit-level=high` is clean (two moderate advisories in build-time libraries are documented there).
- [x] Performance: with 100,000 ledger rows every main screen answers in under 40 ms at the 95th percentile (budget 300 ms); verifying the whole ledger takes about half a second (`pnpm perf`).
- [x] Accessibility: colour contrast meets WCAG AA in light and dark mode (automatic test over the theme), every member screen passes the axe checker in both modes, and text at 200% size fits a phone (`pnpm e2e`).
- [x] Bengali copy: `docs/BENGALI-REVIEW.md` lists every string next to its English meaning.
- [x] API description at `/api/v1/openapi.json` (signed-in users).
- [x] Backups: `pnpm backup:smoke` proves a backup restores and a tampered ledger is caught.
- [x] All tests green: `pnpm check` and `pnpm e2e`.

## You must do before launch

- [ ] **Backups on the real server.** The `backup` service runs, the System screen shows a green backup **and** a green weekly restore test, the three age keys are with the cashier, the auditor and the server, and an off-site copy (`RCLONE_REMOTE`) is configured and a file from it was opened once (`docs/RUNBOOK.md`, Backups).
- [ ] **Offline copy.** The auditor holds an offline external copy of a monthly backup and the System screen shows it confirmed.
- [ ] **Production `.env` was generated, not copied** from `.env.example` and has no placeholder values (the app refuses to start otherwise). The recovery kit (`docs/RECOVERY-KIT.md`) is filled in and sealed with the auditor.
- [ ] **`cloudflared` is pinned** to a tested version in `infra/docker-compose.yml` (it currently says `latest`).
- [ ] **Owner decisions** in `docs/ASSUMPTIONS.md` (section "OWNER DECISION") were agreed by the group. The rule-conflict banner stays visible until then.
- [ ] **A Bengali speaker has read `docs/BENGALI-REVIEW.md`** and the wording fixes were made in `packages/shared/src/i18n/bn.json`.
- [ ] **A real dry run:** follow `docs/TEST-GUIDE.md` start to finish on the production-like server with fictional members, then wipe it.
- [ ] **Import the real history** with the legacy importer (`pnpm import:convert && pnpm import:load && pnpm import:verify`) and check the totals against the Google Sheet before anyone pays through the app.
- [ ] **Seed the constitution** (the private PDF and its clauses) as version 1 through a `constitution_amendment` proposal, so members can read and acknowledge it.
- [ ] **Real SMS and push credentials** are set on the server only (`SMS_PROVIDER=http`, FCM file), never on a development machine.
- [ ] **Production deploy** is done by following `docs/RUNBOOK.md`, never from a development session.

## Optional

- [ ] Android app (`docs/ANDROID.md`): needs the Android SDK, a signing keystore backed up per the recovery kit, and the real https address. Members can use the installable web app until then.
- [ ] Sheet mirror (`SHEETS_EXPORT_ENABLED`): not built; nothing needs it.
