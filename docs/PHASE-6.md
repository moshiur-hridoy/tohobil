# Phase 6: Hardening and handover

Status: **built and green.** What is left is on the people side: `docs/GO-LIVE.md`, "You must do before launch".

## Security (Doc.md section 11)

Each requirement was checked against the code. Result:

| Requirement | Result |
| --- | --- |
| HTTPS only, tunnel trusted for `X-Forwarded-*`, helmet, HSTS, strict CSP, CORS limited | In place (`app.ts`): `default-src 'self'`, no third-party scripts or fonts, CORS limited to the app and the Capacitor origins. |
| Secrets only from the environment; TOTP encrypted at rest; PINs argon2id; tokens and codes hashed | In place. The app refuses to start in production with placeholder secrets. |
| Rate limits: auth 10 per minute per IP, others 120 per minute **per user** | The per-user part was missing (everything was per IP). Fixed: a signed-in member is counted by the user in their **verified** token, everyone else by IP. A forged or invented identity falls back to the shared IP allowance, so it cannot be used to dodge the limit (tests in `app.test.ts`). |
| Uploads sniffed, 10 MB, EXIF stripped, outside any static path, served only through the signed-in route | In place (Phase 1). |
| SQL only through parameterised queries | Checked by scanning every query: the only interpolations are fixed column lists and placeholder numbers. No user input is ever concatenated into SQL. |
| Privacy inside the group | Members never get other members' phone numbers, raw SMS, proofs or devices. The new CSV exports leave all of these out. |
| Audit log covers writes and sensitive reads | Every statement, export and archive download is logged (Phase 5). |
| No super-admin, no impersonation; triggers block edits to append-only tables | In place; the daily ledger check and the restore test both catch tampering. |
| Dependencies: audit in `pnpm check`, install-script allowlist | `pnpm audit --audit-level=high` is clean. Two moderate advisories remain in build-time libraries (`uuid` through firebase-admin, `postcss-selector-parser` through tailwind): neither is reachable from user input. |
| Devices listable and revocable; refresh-token reuse revokes the device | In place. Sign-in from any device (owner decision, `ASSUMPTIONS.md` 80) makes the security feed and the auditor's push more important: every new device alerts the auditor. |

Residual risk worth knowing: because a member can sign in from anywhere with only a 6-digit PIN, anyone who knows a member ID can lock that member out for 15 minutes by guessing. The per-IP limit slows this down; a stricter per-IP failed-login limit can be added if it ever happens.

## Performance

`pnpm perf` loads 100,000 ledger rows and measures 14 endpoints, 40 requests each (budget: 300 ms at the 95th percentile). Result on a laptop:

| | p95 |
| --- | --- |
| Ledger (newest 50, by account, by member, by date range) | 4 to 5 ms |
| Account balances, NAV, members | 35 ms |
| Matrix, dues, payments, me, assets, proposals, periods | under 6 ms |
| Verify the entire ledger (100,000 rows) | 0.4 s |
| Export the entire ledger as CSV | 0.3 s |

No index or query changes were needed.

## Accessibility

- **Colour contrast**: an automatic test reads the real theme and checks 24 colour pairs in light and dark mode against WCAG AA. It found four shortfalls in the light theme (muted text on soft panels, green and amber text on their tinted chips, and field outlines at 1.5:1 instead of 3:1); the theme tokens were darkened. Hard-coded colours in five screens were replaced by theme tokens so dark mode covers them.
- **axe-core in the browser** runs over all 11 member screens in light and dark mode and fails on any serious or critical problem. It found an unlabelled file input on Pay, now labelled.
- **200% text**: text sizes were fixed pixels, which ignore the phone's font-size setting; they are now `rem`. A browser test sets the page to 200% and checks that no member screen scrolls sideways; it found the bottom menu and the copy buttons on Pay overflowing, both fixed.

## Bengali copy

`docs/BENGALI-REVIEW.md` (regenerate with `pnpm i18n:report`) lists all 1,149 strings, Bengali beside English, with the doubtful ones first. Tests enforce identical keys and placeholders in both languages and the spec rule that Nagad is never written "নগদ". Fixes made: the cash-account pickers wrongly used "নগদ" for Nagad, and the backup-failure alert used the English word "Backup".

## API description

`GET /api/v1/openapi.json` (signed-in users) describes every route from the same zod schemas that validate requests, so it cannot drift. A test checks that a sample from every area is listed.

## Decisions

See `docs/ASSUMPTIONS.md` 81: no Kysely (parameterised `pg` queries instead; the unused library and the planned type generator were dropped), PDFKit for PDFs, per-user rate limits, and a restore test that needs no Docker socket.

## Handover documents

- `docs/TEST-GUIDE.md`: the owner's step-by-step test plan.
- `docs/GO-LIVE.md`: what is verified and what a person must still do.
- `docs/RUNBOOK.md` and `docs/RECOVERY-KIT.md`: running the server, backups, month end and year end, disaster recovery.
- `docs/BENGALI-REVIEW.md`: wording review.
