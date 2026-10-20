# Runbook

> The backup sidecar (`infra/backup`) exists and is part of the stack. A stack without working backups must
> not go live; see `docs/GO-LIVE.md`.

## Deployment

All commands from the repo root unless stated. Images are built off the server (a build can spike RAM by 1-2 GB).

1. Build both images: `docker buildx build -f infra/Dockerfile.api -t barakah-api:$TAG .` and
   `docker buildx build -f infra/backup/Dockerfile -t barakah-backup:$TAG infra/backup`.
2. Ship: push to a registry, or `docker save barakah-api:$TAG barakah-backup:$TAG | ssh server docker load`.
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
- `/system/status` (cashier and auditor, the "System" screen) shows the last backup, the weekly restore test, the daily ledger check, the job queue and free disk space. A failed backup or restore test also sends a push and an SMS to the cashier and auditor.

## Ledger verification

`pnpm verify-ledger` recomputes the hash chain and exits 1 with the first broken `seq`. The daily `verify-ledger` job (03:00) does the same, shows the result on the System screen and SMSes the cashier and auditor on failure. The System screen also has a "Check now" button. A failure means someone bypassed the triggers or the data was altered: stop, do not "fix" rows, restore from the last good backup and investigate.

## Backups

What runs by itself (the `backup` container, times in Asia/Dhaka):

- **02:00 every night:** a database dump, encrypted with `age` for three people (cashier, auditor and an automation key), stored on the `backups` volume and, if `RCLONE_REMOTE` is set, copied off-site. The uploaded files are backed up incrementally and encrypted (restic). Old dumps are thinned: everything for 30 days, then only the first backup of each month and the last of each year.
- **Sunday 03:30:** the restore test. It decrypts the newest backup with the automation key, restores it into a throwaway database, re-checks the whole ledger hash chain and compares every account balance and row count with what the system held when the backup was taken. The result is on the System screen. If it fails, the cashier and auditor get a push and an SMS.

Check the System screen at least once a week. Green on both the backup and the restore test is what "safe" means.

### One-time setup: the three keys

Make three keys on any computer (never on the server's only disk):

```
docker run --rm --entrypoint age-keygen barakah-backup:$TAG > cashier.key
docker run --rm --entrypoint age-keygen barakah-backup:$TAG > auditor.key
docker run --rm --entrypoint age-keygen barakah-backup:$TAG > automation.key
```

Each file holds a line `# public key: age1...` and a secret line starting `AGE-SECRET-KEY`.

- Put the three **public** keys (the `age1...` text), separated by commas, in `.env` as `BACKUP_AGE_RECIPIENTS`.
- Give `cashier.key` to the cashier and `auditor.key` to the auditor (they alone can open a backup). Keep a sealed paper copy of each with the auditor.
- Put `automation.key` on the server, set `AUTOMATION_KEY_FILE` to its path, and make it readable only by root.
- Set `RESTIC_PASSWORD` (a long random passphrase) and put a copy in the recovery kit.

### Doing a backup or restore test by hand

```
cd infra
docker compose --env-file ../.env exec backup /opt/backup/backup.sh
docker compose --env-file ../.env exec backup /opt/backup/restore-test.sh
```

### Opening a backup (for example to recover)

```
age -d -i cashier.key barakah-YYYYMMDD-HHMMSS.dump.age > barakah.dump
pg_restore --no-owner -d barakah barakah.dump
```

### Every month

Copy the newest encrypted backup (`*.dump.age`) to the external drive held by the auditor, then press "Confirm offline copy" on the System screen. The screen shows when this was last confirmed.

## Month end and year end (the cashier and auditor)

1. After the last day of a month: the cashier counts what is really in cash, bank, bKash and Nagad and enters it on **Reconcile**. The books' figure is computed by the system. A difference needs a note and the auditor is told.
2. The auditor approves the count, then locks the month. No entry can be dated in a locked month afterwards. An open objection in the month blocks the lock until it is resolved.
3. When all twelve months are locked: the cashier requests the annual audit, the auditor signs it, then the cashier creates the year's archive. The archive (statements, CSV files, the constitution in force, the documents, a fingerprint list) is written once to the `archives` volume, is included in the backups, and can be downloaded as a ZIP. It is never overwritten.

## Disaster recovery (RPO 24 h, RTO 4 h)

See `RECOVERY-KIT.md` for where credentials are.

1. Provision a new host with Docker.
2. Clone the private infra repo.
3. Place `.env` and keys from the recovery kit.
4. `cd infra && docker compose --env-file ../.env up -d db`
5. Restore the latest backup (`age -d -i <your key> ...dump.age > barakah.dump`, then `pg_restore --no-owner -d barakah barakah.dump` as the `barakah_migrator` role). Restore the files with `restic restore latest --target /` from the file repository.
6. `docker compose --env-file ../.env up -d`
7. Restart the tunnel.
8. Verify with `/ledger/verify` and the balances page.

## Operational notes

- The `backups` volume must be bind-mounted from a different disk or path than `pgdata`.
- Pin `cloudflared` to a tested tag before go-live.
- Seeding is for local development only; `pnpm seed` refuses non-local databases.
