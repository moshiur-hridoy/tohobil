#!/usr/bin/env bash
# Installs the two schedules (Asia/Dhaka) and runs cron in the foreground.
set -euo pipefail
STATUS_DIR="${STATUS_DIR:-/data/status}"
mkdir -p /etc/crontabs "$STATUS_DIR" /backups/daily 2> /dev/null || true
cat > /etc/crontabs/root <<'CRON'
0 2 * * * /opt/backup/backup.sh > /proc/1/fd/1 2>&1
30 3 * * 0 /opt/backup/restore-test.sh > /proc/1/fd/1 2>&1
CRON
echo "backup sidecar ready: backup 02:00 daily, restore test Sunday 03:30 (Asia/Dhaka)"
# Run now with `docker compose exec backup /opt/backup/backup.sh` (or restore-test.sh).
exec crond -f -l 8
