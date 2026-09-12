#!/usr/bin/env node
/* Runs every JS suite in tests/ and every parse check, in one command.
   Exits non-zero if ANY suite fails — a green summary must mean everything
   passed, not "the ones I remembered to run". */
import { readdirSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
const ROOT = new URL("../", import.meta.url).pathname;
const parseOnly = process.argv.includes("--parse-only");
let failed = 0;

console.log("── frontend parse ──");
for (const f of readdirSync(ROOT + "docs").filter(x => x.endsWith(".js"))) {
  try { execFileSync("node", ["--check", ROOT + "docs/" + f], { stdio: "pipe" }); }
  catch (e) { failed++; console.log(`FAIL parse docs/${f}`); }
}
console.log(`   ${readdirSync(ROOT + "docs").filter(x => x.endsWith(".js")).length} files checked`);

if (!parseOnly) {
  console.log("\n── suites ──");
  const suites = readdirSync(ROOT + "tests")
    // PHASE_DELIVERY_CONCURRENCY needs a live Postgres and belongs to `npm run
    // test:sql`. Running it here would fail a database-free gate.
    .filter(f => /\.(mjs|cjs)$/.test(f) && !f.startsWith("_") && f !== "edge_harness.mjs" && f !== "PHASE_DELIVERY_CONCURRENCY.mjs")
    .sort();
  for (const f of suites) {
    let out = "", code = 0;
    try { out = execFileSync("node", [ROOT + "tests/" + f], { encoding: "utf8", timeout: 180000 }); }
    catch (e) { code = 1; out = (e.stdout || "") + (e.stderr || ""); }
    const last = out.trim().split("\n").pop() || "(no output)";
    if (code || /\b[1-9]\d* failed/.test(last)) { failed++; console.log(`FAIL ${f.padEnd(34)} ${last}`); }
    else console.log(`ok   ${f.padEnd(34)} ${last}`);
  }
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
