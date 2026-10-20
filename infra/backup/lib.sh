#!/usr/bin/env bash
# Shared helpers for backup.sh and restore-test.sh.

STATUS_DIR="${STATUS_DIR:-/data/status}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Writes a status file atomically so the API never reads half a file.
write_status() { # file, json
  local file="$STATUS_DIR/$1"
  mkdir -p "$STATUS_DIR"
  printf '%s\n' "$2" > "$file.tmp" && mv "$file.tmp" "$file"
}

# age -r <key> for every recipient in BACKUP_AGE_RECIPIENTS (comma separated: cashier, auditor, automation).
age_encrypt() {
  local args=() r
  IFS=',' read -ra keys <<< "${BACKUP_AGE_RECIPIENTS:?BACKUP_AGE_RECIPIENTS is not set}"
  for r in "${keys[@]}"; do args+=(-r "$(echo "$r" | xargs)"); done
  age "${args[@]}"
}

# Tell the API; if it is down, text the cashier and auditor directly with the same SMS settings (spec 12).
alert() { # job
  local job="$1"
  if curl -fsS -m 10 -X POST "${API_URL:-http://api:3000}/api/v1/internal/alert" \
       -H "X-Alert-Secret: ${INTERNAL_ALERT_SECRET:-}" -H 'content-type: application/json' \
       -d "{\"job\":\"$job\"}" > /dev/null 2>&1; then
    return 0
  fi
  echo "[alert] API unreachable, sending SMS directly" >&2
  if [ "${SMS_PROVIDER:-console}" = "http" ] && [ -n "${SMS_HTTP_URL:-}" ] && [ -n "${ALERT_PHONES:-}" ]; then
    local phone body text="Barakah: $job failed. Check the server now."
    IFS=',' read -ra phones <<< "$ALERT_PHONES"
    for phone in "${phones[@]}"; do
      phone="$(echo "$phone" | xargs)"
      body="${SMS_HTTP_BODY_TEMPLATE:-{{phone}}&message={{text}}}"
      body="${body//\{\{phone\}\}/$(jq -rn --arg v "$phone" '$v|@uri')}"
      body="${body//\{\{text\}\}/$(jq -rn --arg v "$text" '$v|@uri')}"
      body="${body//\{\{sender\}\}/$(jq -rn --arg v "${SMS_SENDER_ID:-Barakah}" '$v|@uri')}"
      curl -fsS -m 15 -X POST "$SMS_HTTP_URL" -H 'content-type: application/x-www-form-urlencoded' \
        -H "x-api-key: ${SMS_HTTP_API_KEY:-}" -d "$body" > /dev/null 2>&1 || echo "[alert] SMS to $phone failed" >&2
    done
  else
    echo "[alert] no SMS gateway configured; nobody could be told" >&2
  fi
}

# Used by `trap ... ERR`: record the failure where /system/status shows it, then alert.
fail() { # job, status_file, started, message
  local job="$1" file="$2" started="$3" message="${4:-failed}"
  write_status "$file" "$(jq -nc --arg s "$started" --arg f "$(now_iso)" --arg e "$message" '{ok:false,started:$s,finished:$f,error:$e}')"
  alert "$job" || true
}
