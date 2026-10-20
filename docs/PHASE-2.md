# Phase 2: Notifications and automation

Status: **built and green; proceeding to Phase 3.** Core notification engine, pg-boss scheduler, SMS/fine/job automation and app-version wiring are implemented and pass `pnpm check`. Manual Android-build and device-lab checklist items are recorded below as known gaps.

## What was built

### Backend

- **Notification catalog and queueing** (`apps/api/src/notifications/`): templates for `due_reminder`, `fine_notice`, `payment_ack`, `final_notice`, `meeting_reminder`, `vote_open`, `vote_reminder`, `vote_result`, `pending_payment_alert`, `device_event`, `settlement_payout`, `escrow_payout`, and system alerts. Each template carries channel policy, quiet-hour handling, rate-limit windows and a `dedupe_key`.
- **Push and SMS providers** (`providers/push.ts`, `providers/sms.ts`): `FcmPushSender` (FCM HTTP v1 via `firebase-admin`) falls back to `ConsolePushSender` when `FCM_SERVICE_ACCOUNT_JSON_PATH` is not configured. `SmsProvider` interface with `ConsoleSmsProvider` (default) and `HttpSmsProvider`. `sms_enabled` defaults to `false`; no real gateway is configured.
- **Inbox and admin routes** (`routes/notifications.ts`): `GET /app/version`, `POST /devices`, `DELETE /devices/:id`, `GET /notifications`, `POST /notifications/:id/open`, `GET /notifications/admin?period`, `POST /notifications/nudge`. Admin list and daily "not reachable by push" list are available to cashier/auditor.
- **Job scheduler** (`apps/api/src/jobs/`): pg-boss backed by Postgres. Workers: `send-notifications`, `generate-dues`, `apply-fines`, `remind-dues`, `notify-fines`, `pending-payment-alert`, `cleanup`, `sms-fallback`. Cron schedules run in `Asia/Dhaka`.
- **Fines service** (`apps/api/src/fines/service.ts`): `applyFines` job inserts one non-compounding fine per late due, respecting rule `fine_day` and `fine_per_share_paisa`.
- **Settings service** (`apps/api/src/settings/service.ts`): typed read helpers for `settings` rows; app version defaults wired through env.
- **Environment additions** (`.env.example`): `APP_MIN_VERSION`, `APP_LATEST_VERSION`, `APK_DOWNLOAD_URL`, `FCM_SERVICE_ACCOUNT_JSON_PATH`, `SMS_PROVIDER`, `SMS_HTTP_*`, `SMS_ENABLED`.

### Web

- Notification inbox page under `/menu/notifications`.
- Admin notification log reachable from cashier menu (`/admin/notifications`).
- In-app update banner consumed from `GET /app/version` with force-update and available-update states.
- Device push token registration plumbing.

### Tests

- `apps/api/src/notifications/notifications.test.ts`: queue, dedupe, quiet hours, opt-out, SMS fallback, admin list, nudge rate limit, device registration.
- Existing Phase 1 test suite stays green after wiring.

Final run (2026-10-20): `pnpm check` green (0 lint errors, 5 expected `no-console` warnings; types pass; shared 76, web 9, api 323 tests pass; audit with one documented ignore).

## How to run

```bash
# Start the dev database if not running
docker compose -f infra/docker-compose.dev.yml up -d db

# For local dev, the notification providers log to the console by default.
pnpm dev

# Trigger a job manually by sending to pg-boss, or wait for cron.
pnpm dues:generate            # current period (kept as manual until jobs assume full scheduling)
pnpm check
```

The scheduler starts automatically when `apps/api/src/index.ts` boots; set `DISABLE_JOBS=1` to run without it.

## Known gaps

- **Manual Android build checklist**: `pnpm android:release`, signed debug APK install, and a real FCM test push are not completed. `docs/ANDROID.md` instructions are in place but untested on hardware.
- **Onboarding screens**: battery-optimisation and autostart-by-brand guidance pages exist as routes but have not been user-tested.
- **PWA update flow**: cache headers and `sw.js` no-cache handling are implemented (`app.ts` `NO_CACHE_FILES`); a full simulate-old-client update test is recorded but not manually verified end-to-end.
- **e2e scenario (3)**: the Playwright spec file is scaffolded but not yet recorded as passing against the real scheduler.
- **Real FCM credentials / SMS gateway**: environment variables exist but point to console providers in dev.

## Review checklist for the owner

1. Confirm `pnpm check` is green.
2. Decide whether to pause for the manual Android/PWA verification items above before Phase 3, or accept them as tracked gaps.
3. Supply real `FCM_SERVICE_ACCOUNT_JSON_PATH` and SMS gateway details only on a deployment, never in dev (per `CLAUDE.md`).
