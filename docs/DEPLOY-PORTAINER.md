# Deploying on ZimaOS with Portainer

Target: the Intel Core i5 (7th gen) ZimaOS server, reached at `https://app.moshiur.space` through a Cloudflare Tunnel. No router port is opened. GitHub builds the images; the server only pulls and runs them.

```
GitHub (push to main) --builds--> ghcr.io images --pulled by--> Portainer stack on ZimaOS
                                                                  db + migrate + api(+web) + backup + cloudflared
Member's phone --https--> Cloudflare --tunnel--> cloudflared --> api:3000
```

Vercel and Cloudflare Pages are not used: the API serves the web app itself, and the database must stay on your own server.

## 0. One-time prerequisites

- The domain `moshiur.space` uses Cloudflare's DNS (Cloudflare dashboard, Websites). If it does not, add it there first and change the name servers at the registrar.
- Portainer is installed on ZimaOS and you can log in.
- `private/prod.env` is never committed (the `private/` folder is git-ignored).

## 1. Build the images on GitHub

1. Push to `main` (already done for the app). The workflow `build-images` (`.github/workflows/build-images.yml`) builds three images: `tohobil-api`, `tohobil-backup`, `tohobil-db`.
2. On GitHub open the repo, **Actions**, the latest `build-images` run. The summary shows `Deploy tag: abc1234`. That 7-character id is your `TAG`.
3. First run only: the images are private. Create a read-only token so the server can pull them: GitHub, Settings, Developer settings, Personal access tokens (classic), scope **read:packages** only. Copy it.

## 2. Make the secrets file

On your Mac, in the project folder:

```
node scripts/make-prod-env.mjs app.moshiur.space
```

This writes `private/prod.env` with random passwords and keys. Open it and fill the `TODO` lines:

| Line | Value |
|---|---|
| `TAG` | the id from step 1 |
| `TUNNEL_TOKEN` | from step 3 |
| `BACKUP_AGE_RECIPIENTS` | from step 4 |

**Do not run the script again and do not edit the passwords or `APP_ENCRYPTION_KEY` after the first start.** Changing them on a running system locks you out of the data. Keep a copy in the recovery kit (`docs/RECOVERY-KIT.md`).

## 3. Cloudflare Tunnel

1. Cloudflare dashboard, **Zero Trust**, Networks, **Tunnels**, **Create a tunnel**, type **Cloudflared**, name it `barakah`.
2. Copy the **token** (the long text after `--token`) into `TUNNEL_TOKEN` in `private/prod.env`.
3. In the tunnel's **Public hostname** tab add: subdomain `app`, domain `moshiur.space`, service type **HTTP**, URL `api:3000`. (`api` is the container name; it only works because the tunnel runs in the same stack.)
4. Cloudflare creates the DNS record by itself.

## 4. Backup keys (once)

On your Mac:

```
brew install age
age-keygen -o cashier.key
age-keygen -o auditor.key
age-keygen -o automation.key
```

Each file prints a line `Public key: age1...`. Put the **three public keys**, comma separated, into `BACKUP_AGE_RECIPIENTS`.

- `cashier.key` goes to the cashier, `auditor.key` to the auditor (only they can open a backup). Keep a sealed paper copy of each with the auditor.
- `automation.key` goes on the server (below). Delete the copy on your Mac after the recovery kit is filled.

On the server, in ZimaOS **Files** create the folder `AppData/barakah` and upload `automation.key` into it, so its full path is `/DATA/AppData/barakah/automation.key` (the value already in `prod.env`). It must exist **as a file** before the stack starts, otherwise Docker makes a folder with that name and the backup fails.

Backups themselves are written to `/DATA/AppData/barakah/backups`. ZimaOS's own automatic backup should copy that folder, and you can also copy it by hand to Google Drive. A backup copy on the same disk is not a safe copy; the off-site or Drive copy is what saves you if the disk dies.

## 5. Connect Portainer to the image registry

Portainer, **Registries**, **Add registry**, **Custom registry**:

- Name `ghcr`, URL `ghcr.io`, Authentication on
- Username: your GitHub username, Password: the token from step 1.3

## 6. Create the stack

1. Portainer, your environment (local), **Stacks**, **Add stack**, name `barakah`.
2. Build method **Web editor**. Paste the whole content of `infra/docker-compose.portainer.yml`.
3. Under **Environment variables** choose **Load variables from .env file** and pick `private/prod.env`.
4. Click **Deploy the stack**.

What happens by itself: the database starts and creates its three roles, `migrate` builds the tables and exits, then `api`, `backup` and `cloudflared` start. The first start takes a minute or two.

Check:

- Portainer, the stack shows `db`, `api`, `backup`, `cloudflared` as running (`migrate` shows exited with code 0; that is correct).
- Open `https://app.moshiur.space/api/v1/health`. It must answer `ok`.
- Open `https://app.moshiur.space`. The login page appears.

## 7. First cashier account

The database starts empty, so there is no member yet. Members arrive with the legacy sheet import, which is planned for the rehearsal stage (see below). Once member `M01` exists, the first cashier gets in with a one-time activation code made on the server: Portainer, **Containers**, the `api` container, **Console**, command `/bin/sh`, then

```
node dist/cli/activation-code.js M01
```

Hand the printed code over in person. Do not seed fictional data in production: the seed refuses a non-local database.

> Open item: the importer (`pnpm import:load`) currently runs from a development machine and needs a database connection, but the production database is deliberately not reachable from outside the server. The import step for the server will be added before the rehearsal (a one-off container run from Portainer).

## 8. Updating later

1. Push to `main`, wait for the green `build-images` run, note the new `Deploy tag`.
2. Portainer, the stack, **Editor**, change `TAG` in the environment variables to the new id, **Update the stack**. Tick **Re-pull image**.
3. The `migrate` step runs first, so database changes apply automatically.
4. Check `/api/v1/health` and the System screen.

Roll back by setting `TAG` back to the previous id. Migrations are forward-only, so for a rollback after a schema change, restore from backup (`docs/RUNBOOK.md`).

## 9. Before real money

Everything in `docs/GO-LIVE.md` still applies. In short: System screen shows a green backup **and** a green weekly restore test; the sheet import was verified (`pnpm import:verify`); owner decisions agreed; set `CLOUDFLARED_TAG` to a tested version instead of `latest`.

## Running next to the Google Sheet until January

Keep the Google Sheet as the real record. Until the cutover, use the app with fictional or rehearsal data only, and re-import the sheet to rehearse. On the cutover day: freeze the sheet, run the final import, run `import:verify`, compare the totals with the sheet, then announce the app as the record.

## Resources on the server

The stack limits memory to about 1.1 GB in total (db 384 MB, api 384 MB, backup 256 MB, tunnel 64 MB), well inside the 2.7 GB currently free.
