#!/usr/bin/env bash
# Daily 02:00 Asia/Dhaka (spec 12): dump, encrypt to cashier + auditor + automation keys, store locally and
# remotely, back up the uploaded files incrementally, thin out old dumps, write status.json.
set -Eeuo pipefail
# shellcheck source=lib.sh
. /opt/backup/lib.sh

STARTED="$(now_iso)"
trap 'fail backup status.json "$STARTED" "backup step failed (line $LINENO)"' ERR

DIR="$BACKUP_DIR/daily"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DUMP="$DIR/barakah-$STAMP.dump.age"
MANIFEST="$DIR/barakah-$STAMP.manifest.json.age"

# One snapshot for both the dump and the manifest, so the restore test can compare them exactly even
# if a payment is confirmed while the backup runs.
coproc PSQL { psql -qAtX "${DATABASE_URL:?DATABASE_URL is not set}" 2>&1; }
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" >&"${PSQL[1]}"
echo "SELECT 'SNAPSHOT:' || pg_export_snapshot();" >&"${PSQL[1]}"
SNAPSHOT=""
while IFS= read -r -t 20 line <&"${PSQL[0]}"; do
  case "$line" in SNAPSHOT:*) SNAPSHOT="${line#SNAPSHOT:}"; break ;; esac
done
[ -n "$SNAPSHOT" ] || { echo "could not export a snapshot" >&2; exit 1; }

pg_dump --format=custom --no-owner --snapshot="$SNAPSHOT" "$DATABASE_URL" | age_encrypt > "$DUMP.tmp"

cat >&"${PSQL[1]}" <<'SQL'
SELECT 'MANIFEST:' || json_build_object(
  'taken_at', now(),
  'balances', (SELECT json_object_agg(code, balance_paisa) FROM v_account_balances),
  'counts', json_build_object(
    'ledger_entries', (SELECT count(*) FROM ledger_entries),
    'members', (SELECT count(*) FROM members),
    'payments', (SELECT count(*) FROM payments),
    'dues', (SELECT count(*) FROM dues),
    'proposals', (SELECT count(*) FROM proposals),
    'files', (SELECT count(*) FROM files)),
  'last_ledger_hash', (SELECT hash FROM ledger_entries ORDER BY seq DESC LIMIT 1));
SQL
MANIFEST_JSON=""
while IFS= read -r -t 20 line <&"${PSQL[0]}"; do
  case "$line" in MANIFEST:*) MANIFEST_JSON="${line#MANIFEST:}"; break ;; esac
done
echo "COMMIT;" >&"${PSQL[1]}"; echo "\\q" >&"${PSQL[1]}"
wait "$PSQL_PID" 2>/dev/null || true
[ -n "$MANIFEST_JSON" ] || { echo "no manifest" >&2; exit 1; }

printf '%s' "$MANIFEST_JSON" | age_encrypt > "$MANIFEST.tmp"
mv "$DUMP.tmp" "$DUMP"; mv "$MANIFEST.tmp" "$MANIFEST"
SIZE="$(wc -c < "$DUMP" | tr -d ' ')"
SHA="$(sha256sum "$DUMP" | cut -d' ' -f1)"
[ "$SIZE" -gt 1000 ] || { echo "dump is suspiciously small ($SIZE bytes)" >&2; exit 1; }

# Uploaded files: incremental, encrypted (restic), to the local repository and, if set, a remote one.
if [ -d /data/files ] && [ -n "${RESTIC_PASSWORD:-}" ]; then
  REPO="${RESTIC_REPOSITORY:-$BACKUP_DIR/restic}"
  restic -r "$REPO" cat config > /dev/null 2>&1 || restic -r "$REPO" init > /dev/null
  restic -r "$REPO" backup /data/files --quiet
  if [ -n "${RESTIC_REMOTE_REPOSITORY:-}" ]; then
    restic -r "$RESTIC_REMOTE_REPOSITORY" cat config > /dev/null 2>&1 || restic -r "$RESTIC_REMOTE_REPOSITORY" init > /dev/null
    restic -r "$RESTIC_REMOTE_REPOSITORY" backup /data/files --quiet
  fi
fi

# Off-site copy of the encrypted dump and manifest.
if [ -n "${RCLONE_REMOTE:-}" ]; then
  rclone copyto "$DUMP" "$RCLONE_REMOTE/daily/$(basename "$DUMP")" --quiet
  rclone copyto "$MANIFEST" "$RCLONE_REMOTE/daily/$(basename "$MANIFEST")" --quiet
fi

# Retention: every dump for 30 days; older ones only if it is the first backup of its month or the last of a year.
CUTOFF="$(date -u -d "@$(( $(date +%s) - 30 * 86400 ))" +%Y%m%d)"
declare -A FIRST_OF_MONTH LAST_OF_YEAR
for f in $(ls -1 "$DIR"/barakah-*.dump.age | sort); do
  d="$(basename "$f" | sed -E 's/barakah-([0-9]{8}).*/\1/')"
  [ -n "${FIRST_OF_MONTH[${d:0:6}]:-}" ] || FIRST_OF_MONTH[${d:0:6}]="$f"
  LAST_OF_YEAR[${d:0:4}]="$f"
done
for f in $(ls -1 "$DIR"/barakah-*.dump.age | sort); do
  d="$(basename "$f" | sed -E 's/barakah-([0-9]{8}).*/\1/')"
  if [ "$d" -lt "$CUTOFF" ]; then
    [ "${FIRST_OF_MONTH[${d:0:6}]}" = "$f" ] && continue
    # the last backup of a year that is over (December 31 at the latest) is kept forever
    [ "${LAST_OF_YEAR[${d:0:4}]}" = "$f" ] && [ "${d:4:2}" = "12" ] && continue
    rm -f "$f" "${f%.dump.age}.manifest.json.age"
    [ -z "${RCLONE_REMOTE:-}" ] || { rclone deletefile "$RCLONE_REMOTE/daily/$(basename "$f")" --quiet || true; rclone deletefile "$RCLONE_REMOTE/daily/$(basename "${f%.dump.age}.manifest.json.age")" --quiet || true; }
  fi
done

write_status status.json "$(jq -nc --arg s "$STARTED" --arg f "$(now_iso)" --arg n "$(basename "$DUMP")" --argjson size "$SIZE" --arg sha "$SHA" '{ok:true,started:$s,finished:$f,file:$n,size:$size,sha256:$sha}')"
echo "backup ok: $(basename "$DUMP") ($SIZE bytes)"
