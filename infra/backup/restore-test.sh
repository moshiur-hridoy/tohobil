#!/usr/bin/env bash
# Weekly, Sunday 03:30 Asia/Dhaka (spec 12): prove the newest backup can really be restored. Decrypt it with
# the automation key, restore it into a throwaway PostgreSQL, re-check the ledger hash chain, compare account
# balances and row counts with the manifest taken at backup time, and write restore-status.json.
set -Eeuo pipefail
# shellcheck source=lib.sh
. /opt/backup/lib.sh

STARTED="$(now_iso)"
WORK="$(mktemp -d /tmp/restore.XXXXXX)"
PGDATA="$WORK/pgdata"
KEY="${AUTOMATION_KEY_FILE:-/run/backup/automation.key}"
cleanup() {
  su-exec postgres pg_ctl -D "$PGDATA" -m immediate stop > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'fail restore-test restore-status.json "$STARTED" "restore test failed (line $LINENO)"' ERR

[ -r "$KEY" ] || { echo "automation key not readable at $KEY" >&2; exit 1; }
LATEST="$(ls -1 "$BACKUP_DIR"/daily/barakah-*.dump.age 2> /dev/null | sort | tail -1)"
[ -n "$LATEST" ] || { echo "no backup to test" >&2; exit 1; }
MANIFEST_FILE="${LATEST%.dump.age}.manifest.json.age"

age -d -i "$KEY" "$LATEST" > "$WORK/db.dump"
age -d -i "$KEY" "$MANIFEST_FILE" > "$WORK/manifest.json"

chown postgres "$WORK"
su-exec postgres initdb -D "$PGDATA" -A trust -U postgres > /dev/null
su-exec postgres pg_ctl -D "$PGDATA" -w -o "-p 55432 -c listen_addresses='' -c unix_socket_directories='$WORK' -c fsync=off" start > /dev/null
PSQL=(psql -qAtX -h "$WORK" -p 55432 -U postgres)
"${PSQL[@]}" -d postgres -c "CREATE DATABASE restore" > /dev/null
# Roles from the live system do not exist here, so ownership and grants are skipped; the data is what is tested.
pg_restore --no-owner --no-privileges -h "$WORK" -p 55432 -U postgres -d restore "$WORK/db.dump" > "$WORK/restore.log" 2>&1 || {
  # pg_restore exits non-zero on harmless warnings (e.g. missing roles); only a missing ledger is fatal.
  "${PSQL[@]}" -d restore -c "SELECT 1 FROM ledger_entries LIMIT 1" > /dev/null || { cat "$WORK/restore.log" >&2; exit 1; }
}

# The same canonical form the ledger trigger and the API use (spec 5.6).
read -r BAD COUNT <<< "$("${PSQL[@]}" -d restore -F ' ' -c "
  WITH c AS (
    SELECT hash, prev_hash,
           lag(hash) OVER (ORDER BY seq) AS expected_prev,
           encode(digest(prev_hash || '|' || concat_ws('|', seq, to_char(entry_date,'YYYY-MM-DD'), debit_account,
             credit_account, amount_paisa, COALESCE(member_id::text,''), COALESCE(ref_type,''), COALESCE(ref_id::text,''),
             COALESCE(memo,''), COALESCE(created_by::text,''),
             to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')), 'sha256'), 'hex') AS calc
    FROM ledger_entries)
  SELECT count(*) FILTER (WHERE hash <> calc OR prev_hash <> COALESCE(expected_prev, repeat('0',64))), count(*) FROM c")"

PROBLEMS=()
[ "$BAD" = "0" ] || PROBLEMS+=("ledger chain broken in $BAD row(s)")

# Balances and counts must equal what was true when the backup was taken.
ACTUAL="$("${PSQL[@]}" -d restore -c "SELECT json_build_object(
  'balances', (SELECT json_object_agg(code, balance_paisa) FROM v_account_balances),
  'counts', json_build_object('ledger_entries',(SELECT count(*) FROM ledger_entries),'members',(SELECT count(*) FROM members),
    'payments',(SELECT count(*) FROM payments),'dues',(SELECT count(*) FROM dues),'proposals',(SELECT count(*) FROM proposals),
    'files',(SELECT count(*) FROM files)),
  'last_ledger_hash', (SELECT hash FROM ledger_entries ORDER BY seq DESC LIMIT 1))")"
for part in balances counts last_ledger_hash; do
  want="$(jq -cS ".$part" "$WORK/manifest.json")"; got="$(printf '%s' "$ACTUAL" | jq -cS ".$part")"
  [ "$want" = "$got" ] || PROBLEMS+=("$part differ from the manifest")
done

if [ "${#PROBLEMS[@]}" -gt 0 ]; then
  MSG="$(IFS='; '; echo "${PROBLEMS[*]}")"
  fail restore-test restore-status.json "$STARTED" "$MSG"
  echo "restore test FAILED: $MSG" >&2
  exit 1
fi
write_status restore-status.json "$(jq -nc --arg s "$STARTED" --arg f "$(now_iso)" --arg n "$(basename "$LATEST")" --argjson rows "$COUNT" '{ok:true,verified:true,started:$s,finished:$f,backup:$n,ledger_rows:$rows}')"
echo "restore test ok: $(basename "$LATEST") ($COUNT ledger rows verified)"
