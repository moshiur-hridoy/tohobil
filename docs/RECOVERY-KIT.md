# Recovery Kit

This document lists where critical secrets and credentials are stored.
No actual secrets are stored in this repository.

## Server Access

- Location: [sealed envelope with auditor]
- Contents: SSH key, server IP, root password

## Environment file

- `.env` on the server (generated from `.env.example`): database role passwords (`MIGRATOR_DB_PASSWORD`, `APP_DB_PASSWORD`, `READONLY_DB_PASSWORD`), `APP_ENCRYPTION_KEY`, `JWT_SECRET`, `TOKEN_PEPPER`, `INTERNAL_ALERT_SECRET`, `TUNNEL_TOKEN`.
- Losing `APP_ENCRYPTION_KEY` makes every enrolled TOTP secret unreadable (members re-enrol); losing `TOKEN_PEPPER` or `JWT_SECRET` only signs everyone out.
- A copy is in the sealed envelope held by the auditor.

## Age Encryption Keys

- Cashier key: [location]
- Auditor key: [location]
- Automation key: on server at /etc/barakah/backup-key.txt

## Android Keystore

- Location: [sealed envelope with auditor]
- Alias: barakah-release
- Note: Loss of the keystore means no more updates under package id `app.barakah.fund`; users would have to reinstall a re-signed app.
- Build procedure: `docs/ANDROID.md`

## Firebase Project

- Project ID: [in sealed envelope]
- Service account: deployed as Docker secret

## SMS Gateway

- Provider: [TBD - chosen by owner]
- Account credentials: [sealed envelope]

## Domain and Cloudflare

- Domain registrar: [details in sealed envelope]
- Cloudflare account: [details in sealed envelope]
- Tunnel token: in .env on server

## Registry and Git

- Git hosting: [private repo URL]
- Container registry: [registry URL]
- Access tokens: [sealed envelope]

## Paper Backup

A sealed paper copy of all secrets is kept by the auditor.
