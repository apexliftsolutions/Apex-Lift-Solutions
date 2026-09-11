#!/usr/bin/env node
/* Database rule tests. Builds a throwaway Postgres DB from the local auth shim
   + every migration, then runs each tests/sql/*.sql suite and exits non-zero on
   any FAIL line or psql ERROR.

   REQUIRES a local Postgres reachable via $APEX_PG_PSQL (a psql command prefix).
   If it is not configured this exits 3 with an explicit message — a required
   environment that is missing must never read as green. */
import { readdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
const ROOT = new URL("../", import.meta.url).pathname;
const PSQL = process.env.APEX_PG_PSQL;               // e.g. "psql -h /tmp/pgsock -U postgres"
if (!PSQL) {
  console.log("SQL SUITES NOT RUN: set APEX_PG_PSQL to a psql command prefix for a local Postgres (see tests/sql/README).");
  process.exit(3);
}
const DB = "apex_sqltest_" + Date.now();
const sh = (c) => execSync(c, { stdio: "pipe", encoding: "utf8" });
// process.exit() inside try/catch skips `finally`, so the throwaway DB leaked on
// every run. The exit code is recorded and applied only AFTER cleanup.
let exitCode = 0;
try {
  sh(`${PSQL} -d postgres -q -c 'create database ${DB}'`);
  sh(`${PSQL} -d ${DB} -v ON_ERROR_STOP=1 -q -f ${ROOT}tests/sql/_local_auth_shim.sql`);
  const migs = readdirSync(ROOT + "supabase/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const m of migs) sh(`${PSQL} -d ${DB} -v ON_ERROR_STOP=1 -q -f ${ROOT}supabase/migrations/${m}`);
  console.log(`db built: ${migs.length} migrations`);
  let failed = 0;
  for (const f of readdirSync(ROOT + "tests/sql").filter(x => x.endsWith(".sql") && !x.startsWith("_")).sort()) {
    const out = sh(`${PSQL} -d ${DB} -f ${ROOT}tests/sql/${f} 2>&1 || true`);
    const p = (out.match(/^PASS /gm) || []).length, fl = (out.match(/^FAIL /gm) || []).length;
    const errs = (out.match(/^psql:.*ERROR/gm) || []).length;
    console.log(`${fl || errs ? "FAIL" : "ok  "} ${f.padEnd(30)} ${p} passed, ${fl} failed, ${errs} harness errors`);
    if (fl || errs) { failed++; console.log(out.split("\n").filter(l => /^FAIL|^psql:.*ERROR/.test(l)).slice(0, 8).join("\n")); }
  }
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.log("SQL SUITE ERROR: " + String(e.stdout || e.message).slice(0, 400));
  exitCode = 1;
} finally {
  // FORCE closes any lingering session on the throwaway DB; without it Postgres
  // refuses the drop and a database leaks on every run. Log rather than swallow.
  try { sh(`${PSQL} -d postgres -q -c 'drop database if exists ${DB} with (force)'`); }
  catch (e) { console.log(`WARN could not drop ${DB}: ${String(e.stderr || e.message).slice(0, 120)}`); }
}
process.exit(exitCode);
