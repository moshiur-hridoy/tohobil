# Go-live checklist

Completed in Phase 6 (hardening and handover). Items that already block a launch are listed now so they cannot be forgotten.

## Blockers

- [ ] Backup sidecar image `barakah-backup` exists and the first encrypted backup was restored on a throwaway database (Phase 5). The production compose file intentionally fails to start without it.
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
