# Phase 5: Audit and operations

Status: **built and green.** The one optional item (a Google Sheet mirror) is deliberately not built.

## What it does

### Month end, year end
- **Reconcile** (cashier and auditor): at month end the cashier enters what is really in cash, bank, bKash and Nagad. The books' figure is computed by the server and cannot be supplied, so a count can only be compared with the ledger, never tuned to match it. A difference needs a note and the auditor is told. The auditor approves the count and locks the month; after that the database refuses any ledger entry dated in it. An open objection in the month blocks the lock.
- **Annual audit**: when all twelve months are locked the cashier requests the audit, the auditor signs (never the same person), then the cashier creates the **archive**: `annual-summary.pdf`, one statement per member, the CSV files (ledger, payments, dues, fines, votes, proposals, assets, valuations, members, charity statement), the constitution in force, the attached documents, `SHA256SUMS` and a plain-language `README.txt`. It is written once to the `archives` volume (part of the backups) and can be downloaded as a ZIP. An existing archive is never overwritten.

### Reports
- Member statement (month or year) and zakat information as Bengali PDFs; members get their own, the cashier and auditor anyone's. The zakat statement gives figures only (capital, an estimated share value, what is owed); members work out zakat themselves. The cashier sets a notice date in Settings and a daily job sends the notice that day.
- CSV exports of the ledger, payments, dues and votes. Payments never include SMS text or screenshots, phone numbers are not exported, and a cell that starts with `=`, `+`, `-` or `@` is neutralised so a spreadsheet cannot run it.
- Every statement, export and archive download is written to the audit log.

### Watching the system
- **System screen** (`GET /system/status`): last backup, last weekly restore test, the daily ledger check, queued jobs, free disk and the last confirmed offline copy. A "Check now" button re-verifies the whole ledger hash chain.
- A daily `verify-ledger` job (03:00) records the result and, on a break, pushes and SMSes the cashier and auditor.
- `POST /internal/alert` lets the backup sidecar raise `backup_failed` with the shared secret; if the API is down the sidecar texts `ALERT_PHONES` itself.

### Backup and restore (`infra/backup`)
- 02:00 nightly: dump, encrypted with `age` for the cashier, auditor and an automation key; local copy plus optional off-site (`rclone`); incremental encrypted file backup (`restic`); thinning (30 days, then first of each month and last of each year). The dump and a manifest of balances and row counts are taken from one database snapshot so they always agree.
- Sunday 03:30: the restore test restores the newest backup into a throwaway PostgreSQL, re-checks the whole ledger chain and compares balances and counts with the manifest.
- `pnpm backup:smoke` proves all of this with only Docker: it backs up a throwaway database, restores it, then tampers with one ledger row and checks that the restore test now fails.

## Decisions worth knowing
- **PDF engine**: PDFKit, not `pdf-lib`. `pdf-lib` ignores the font's mark positioning, which garbled Bengali conjuncts such as শ্রদ্ধা and সন্ধ্যা; PDFKit renders them correctly. The font package ships Bengali and Latin as separate files, so text is drawn in runs with the right font for each.
- **Restore test without Docker access**: the sidecar installs PostgreSQL and runs a throwaway server in a temporary folder, so it never needs the Docker socket.
- Locking, approval and sign-off all need the auditor's authenticator step-up; the cashier cannot approve their own count or sign their own audit request.

## Known gaps
- **Sheet mirror** (`SHEETS_EXPORT_ENABLED`) is not built. It is optional and off by default.
- The sidecar's off-site copy and the restic remote are untested against a real cloud account (the commands are standard `rclone` and `restic`); configure one and run a manual backup before go-live.
- The archive's member statements are generated sequentially; with hundreds of members it will take a minute or two.
- Statement PDFs list dues as of their current status, not as they stood at the end of the period.
