# The backup and restore-test sidecar (spec 12): alpine + postgresql + age + restic + rclone + cron.
# Build off the server:  docker buildx build -f infra/backup/Dockerfile -t barakah-backup:$TAG infra/backup
FROM alpine:3.20

# postgresql16 (the server) is only used by the weekly restore test, in a throwaway data directory.
RUN apk add --no-cache bash curl jq tzdata su-exec age restic rclone \
      postgresql16 postgresql16-client postgresql16-contrib \
 && cp /usr/share/zoneinfo/Asia/Dhaka /etc/localtime \
 && echo "Asia/Dhaka" > /etc/timezone \
 && mkdir -p /opt/backup /backups /data/status

ENV TZ=Asia/Dhaka
COPY lib.sh backup.sh restore-test.sh entrypoint.sh /opt/backup/
RUN chmod +x /opt/backup/*.sh

# Runs as root because cron needs it; the restore test drops to the `postgres` user for its throwaway server.
ENTRYPOINT ["/opt/backup/entrypoint.sh"]
