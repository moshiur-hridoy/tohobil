#!/bin/sh
# Creates the two least-privilege database roles (spec 6). Runs once, when the Postgres data
# directory is first initialised, in BOTH the dev and production compose files, so every
# environment has the same role model.
#
#   barakah_migrator  the bootstrap user (POSTGRES_USER): owns the objects, runs migrations. It is only
#                     ever handed to the one-shot `migrate` service.
#   barakah_app       the API: DML only. The migration revokes UPDATE/DELETE/TRUNCATE on the
#                     append-only tables from it.
#   barakah_readonly  the ledger verifier: SELECT only, and no access to credential tables.
#
# Table-level grants are applied by the migration itself (it runs after this script).
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"
: "${READONLY_DB_PASSWORD:?READONLY_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$APP_DB_PASSWORD" -v ro_pw="$READONLY_DB_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE barakah_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
CREATE ROLE barakah_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'ro_pw';

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO barakah_app, barakah_readonly;

-- Nobody but the owner creates objects in the public schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
