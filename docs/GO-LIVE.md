# Go-live checklist

Completed in Phase 6 (hardening and handover). Items that already block a launch are listed now so they cannot be forgotten.

## Blockers

- [ ] The backup sidecar `barakah-backup` is running, the System screen shows a green backup AND a green weekly restore test, and the three age keys are with the cashier, auditor and server (`docs/RUNBOOK.md`, Backups). The production compose file intentionally fails to start without it.
- [ ] An off-site copy is configured (`RCLONE_REMOTE`) and a file from it was opened once.
- [ ] Offline external copy of a monthly backup is held by the auditor.
- [ ] Production `.env` has no placeholder values (the API enforces this) and was generated, not copied from `.env.example`.
- [ ] Android keystore created, backed up (see `RECOVERY-KIT.md`), and the backup location confirmed by the auditor.
- [ ] `cloudflared` pinned to a tested tag.
- [ ] Owner decisions in `docs/ASSUMPTIONS.md` (section "OWNER DECISION") reviewed by the group; the rule-conflict banner is visible until resolved.

## Phase 6 items

- [ ] Security checklist (Doc.md 11), `pnpm audit` clean at `high`.
- [ ] Performance: p95 < 300 ms on main endpoints with 100k ledger rows.
- [ ] Accessibility pass on member screens (contrast, 200 % font scaling).
- [ ] Bengali copy review.
- [ ] Final docs.
