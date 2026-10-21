#!/usr/bin/env bash
# End-to-end proof that backups can be restored (spec 12, Phase 5 test): needs only Docker.
#   pnpm backup:smoke
# It builds the backup image, creates a throwaway PostgreSQL with the real schema and a few ledger rows,
# runs a backup, restores it into another throwaway database and verifies it, then tampers with one ledger
# row and checks that the restore test now FAILS. Everything it creates is removed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=smoke-$$
NET=barakah-smoke-net-$$
PG=barakah-smoke-pg-$$
WORK="$(mktemp -d)"
FILES_VOL=barakah-smoke-files-$$
IMAGE=barakah-backup:$TAG
cleanup() {
  docker rm -f "$PG" > /dev/null 2>&1 || true
  docker volume rm -f "$FILES_VOL" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  docker rmi "$IMAGE" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> building the backup image"
docker build -q -f infra/backup/Dockerfile -t "$IMAGE" infra/backup > /dev/null
docker network create "$NET" > /dev/null

echo "==> starting a throwaway PostgreSQL with the real schema"
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=smoke postgres:16-alpine > /dev/null
for _ in $(seq 1 40); do docker exec "$PG" pg_isready -U postgres > /dev/null 2>&1 && break; sleep 1; done
sleep 2
for f in db/migrations/*.sql; do sed '/^-- Down Migration/,$d' "$f"; done | docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres > /dev/null
docker exec "$PG" psql -q -U postgres -c "
  INSERT INTO ledger_entries (entry_date, debit_account, credit_account, amount_paisa, ref_type, memo) VALUES
    ('2026-01-05','BANK','MEMBER_CAPITAL',500000,'import','smoke 1'),
    ('2026-01-06','CASH','MEMBER_CAPITAL',250000,'import','smoke 2'),
    ('2026-01-07','BKASH','MEMBER_CAPITAL',125000,'import','smoke 3');" > /dev/null

echo "==> keys, volumes"
mkdir -p "$WORK/backups" "$WORK/status" "$WORK/keys"
for k in cashier auditor automation; do docker run --rm --entrypoint age-keygen "$IMAGE" 2> /dev/null > "$WORK/keys/$k.key"; done
RECIPIENTS="$(for k in cashier auditor automation; do grep -o 'age1[a-z0-9]*' "$WORK/keys/$k.key" | head -1; done | paste -sd, -)"
docker volume create "$FILES_VOL" > /dev/null
docker run --rm -v "$FILES_VOL":/d alpine sh -c "mkdir -p /d/ab && echo 'a stored proof image' > /d/ab/blob" > /dev/null

side() { # script
  docker run --rm --network "$NET" --entrypoint "$1" \
    -v "$WORK/backups:/backups" -v "$WORK/status:/data/status" -v "$FILES_VOL":/data/files:ro \
    -v "$WORK/keys/automation.key:/run/backup/automation.key:ro" \
    -e "DATABASE_URL=postgres://postgres:smoke@$PG:5432/postgres" -e "BACKUP_AGE_RECIPIENTS=$RECIPIENTS" \
    -e RESTIC_PASSWORD=smoke -e INTERNAL_ALERT_SECRET=x -e API_URL=http://127.0.0.1:1 "$IMAGE"
}
status() { jq -r ".$2" "$WORK/status/$1"; }

echo "==> backup"
side /opt/backup/backup.sh
[ "$(status status.json ok)" = "true" ] || { echo "FAIL: backup did not report ok"; exit 1; }

echo "==> restore test on the untouched backup (must pass)"
side /opt/backup/restore-test.sh
[ "$(status restore-status.json ok)" = "true" ] || { echo "FAIL: restore test did not pass"; exit 1; }
[ "$(status restore-status.json ledger_rows)" = "3" ] || { echo "FAIL: expected 3 ledger rows"; exit 1; }

echo "==> tamper with one ledger row, back up again, restore test must FAIL"
docker exec "$PG" psql -q -U postgres -c "ALTER TABLE ledger_entries DISABLE TRIGGER no_mutation_ledger; UPDATE ledger_entries SET amount_paisa = amount_paisa + 1 WHERE seq = 1; ALTER TABLE ledger_entries ENABLE TRIGGER no_mutation_ledger;" > /dev/null
sleep 1
side /opt/backup/backup.sh > /dev/null
if side /opt/backup/restore-test.sh > /dev/null 2>&1; then echo "FAIL: restore test passed on a tampered ledger"; exit 1; fi
[ "$(status restore-status.json ok)" = "false" ] || { echo "FAIL: failure was not recorded"; exit 1; }
echo "    recorded: $(status restore-status.json error)"

echo "BACKUP SMOKE TEST PASSED: backups restore, and a tampered ledger is caught."
