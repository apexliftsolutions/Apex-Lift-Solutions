# Database rule tests

Run with a local Postgres:

    APEX_PG_PSQL="psql -h /tmp/pgsock -U postgres" node tools/run-sql-tests.mjs

`_local_auth_shim.sql` stands in for Supabase's `auth`/`storage` schemas so the
production migrations apply unchanged. `set request.jwt.claims = '{"sub":…}'`
impersonates a user exactly as PostgREST does.

Each suite prints `PASS`/`FAIL` lines. The runner fails on any FAIL or psql
ERROR, and **exits 3 if no database is configured** — never green by default.
