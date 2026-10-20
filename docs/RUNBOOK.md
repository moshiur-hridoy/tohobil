# Runbook

> Phase 0 status: the stack below is defined but the backup sidecar (Phase 5) does not exist yet.
> **Do not go live before it does**; see `docs/GO-LIVE.md`.

## Deployment

All commands from the repo root unless stated. Images are built off the server (a build can spike RAM by 1-2 GB).

1. Build: `docker buildx build -f infra/Dockerfile.api -t barakah-api:$TAG .`
2. Ship: push to a registry, or `docker save barakah-api:$TAG | ssh server docker load`.
3. On the server, in `infra/`: set `TAG` (and everything else from `.env.example`) in the repo-level `.env`, then
   `cd infra && docker compose --env-file ../.env up -d`
4. The `migrate` service applies pending migrations first (as `barakah_migrator`); the `api` starts only after it succeeds. No manual SQL in production.
5. Start the tunnel when ready: `docker compose --env-file ../.env --profile tunnel up -d cloudflared`.
6. Smoke test: `curl https://<domain>/api/v1/health` returns `{"status":"ok","db":"connected"}`, then `/api/v1/ledger/verify` once it exists (Phase 1).

First start on an empty volume runs `infra/initdb/10-roles.sh`, which creates `barakah_app` and `barakah_readonly` from `APP_DB_PASSWORD` / `READONLY_DB_PASSWORD`. These run only on a _new_ data directory: changing the passwords later needs `ALTER ROLE`.

Production environment values must not be placeholders; the API refuses to start otherwise (`apps/api/src/lib/env.ts`).

## Monitoring

- Point an external uptime monitor (UptimeRobot, Healthchecks.io, ...) at `GET https://<domain>/api/v1/health`. It returns **503** when the database is unreachable, so a plain HTTP check is enough. It is exempt from rate limiting.
- Container healthchecks run `node dist/healthcheck.js` every 30 s.
- `/system/status` (Phase 5) shows last backup, restore test, ledger verify, queue depth and disk space.

## Ledger verification

`pnpm verify-ledger` recomputes the hash chain and exits 1 with the first broken `seq`. The daily `verify_ledger` job (Phase 2) does the same and SMSes the cashier and auditor on failure. A failure means someone bypassed the triggers or the data was altered: stop, do not "fix" rows, restore from the last good backup and investigate.

## Backups (Phase 5)

- Check `/system/status` for the last backup time and result.
- Monthly: copy the encrypted monthly backup to the offline drive held by the auditor and record the confirmation in the app.

## Disaster recovery (RPO 24 h, RTO 4 h)

See `RECOVERY-KIT.md` for where credentials are.

1. Provision a new host with Docker.
2. Clone the private infra repo.
3. Place `.env` and keys from the recovery kit.
4. `cd infra && docker compose --env-file ../.env up -d db`
5. Restore the latest backup (`age` decrypt, `pg_restore`).
6. `docker compose --env-file ../.env up -d`
7. Restart the tunnel.
8. Verify with `/ledger/verify` and the balances page.

## Operational notes

- The `backups` volume must be bind-mounted from a different disk or path than `pgdata`.
- Pin `cloudflared` to a tested tag before go-live.
- Seeding is for local development only; `pnpm seed` refuses non-local databases.
