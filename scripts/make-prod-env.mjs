// Writes a production env file with fresh random secrets, for pasting/uploading into Portainer.
//   node scripts/make-prod-env.mjs app.moshiur.space
// The file goes to private/prod.env (git-ignored). It refuses to overwrite an existing file, because
// regenerating APP_ENCRYPTION_KEY or the database passwords on a running system would lock you out.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const domain = process.argv[2];
if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error('Usage: node scripts/make-prod-env.mjs app.example.com');
  process.exit(1);
}
const out = 'private/prod.env';
if (existsSync(out)) {
  console.error(`${out} already exists. Delete it yourself only if you are sure (see docs/DEPLOY-PORTAINER.md).`);
  process.exit(1);
}

const hex = (bytes = 32) => randomBytes(bytes).toString('hex');
const migrator = hex(24);
const app = hex(24);
const readonly = hex(24);

const body = `# Production values for ${domain}. Generated ${new Date().toISOString()}. NEVER commit or share this file.
# Fill in the three blanks marked TODO, then upload the file in Portainer (docs/DEPLOY-PORTAINER.md).

TAG=TODO-short-commit-id-from-github-actions
PUBLIC_ORIGIN=https://${domain}
TUNNEL_TOKEN=TODO-from-cloudflare
CLOUDFLARED_TAG=latest

MIGRATOR_DB_PASSWORD=${migrator}
APP_DB_PASSWORD=${app}
READONLY_DB_PASSWORD=${readonly}
DATABASE_URL=postgres://barakah_app:${app}@db:5432/barakah
MIGRATOR_DATABASE_URL=postgres://barakah_migrator:${migrator}@db:5432/barakah

APP_ENCRYPTION_KEY=${hex(32)}
JWT_SECRET=${hex(32)}
TOKEN_PEPPER=${hex(32)}
INTERNAL_ALERT_SECRET=${hex(32)}

# Backups (docs/DEPLOY-PORTAINER.md, step 4)
BACKUP_AGE_RECIPIENTS=TODO-three-age-public-keys-comma-separated
AUTOMATION_KEY_FILE=/DATA/AppData/barakah/automation.key
BACKUP_DIR=/DATA/AppData/barakah/backups
RESTIC_PASSWORD=${hex(32)}
RCLONE_REMOTE=
RESTIC_REMOTE_REPOSITORY=
ALERT_PHONES=

LOG_LEVEL=info
SMS_PROVIDER=console
SMS_HTTP_URL=
SMS_HTTP_API_KEY=
SMS_SENDER_ID=
SMS_HTTP_BODY_TEMPLATE=
SHEETS_EXPORT_ENABLED=false
`;
mkdirSync('private', { recursive: true });
writeFileSync(out, body, { mode: 0o600 });
console.log(`Wrote ${out}. Open it, fill the TODO lines, and keep a copy in the recovery kit.`);
