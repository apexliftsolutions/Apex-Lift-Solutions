#!/usr/bin/env node
/* One release string, one source of truth. package.json carries the canonical
   value; every cache-buster and client marker in docs/ must agree with it.
   A version that drifts is worse than none: it makes a stale bundle invisible. */
import { readdirSync, readFileSync } from "fs";
const ROOT = new URL("../", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(ROOT + "package.json", "utf8"));
// The literal is stored, not derived: deriving a cache-buster from a semver
// string is one transformation away from being subtly wrong, and a wrong
// version string is worse than none — it makes a stale bundle invisible.
const EXPECT = pkg.apexRelease;
if (!EXPECT) { console.log("FAIL package.json has no apexRelease"); process.exit(1); }
let bad = 0, seen = new Set();
for (const f of readdirSync(ROOT + "docs").filter(x => /\.(html|js)$/.test(x))) {
  for (const m of readFileSync(ROOT + "docs/" + f, "utf8").matchAll(/\d{4}-\d{2}-\d{2}\.v[\d.]+[a-z-]*/g)) {
    seen.add(m[0]);
    if (m[0] !== EXPECT) { bad++; console.log(`FAIL ${f}: ${m[0]} !== ${EXPECT}`); }
  }
}
// package-lock.json carries the version twice (root and packages[""]). Both must
// equal package.json or the lockfile is describing a different release.
const lock = JSON.parse(readFileSync(ROOT + "package-lock.json", "utf8"));
for (const [where, v] of [["package-lock root", lock.version], ['package-lock packages[""]', lock.packages?.[""]?.version]]) {
  if (v !== pkg.version) { bad++; console.log(`FAIL ${where} version ${v} !== package.json ${pkg.version}`); }
}
console.log(`package.json ${pkg.version} -> expects ${EXPECT}; lockfile ${lock.version} / ${lock.packages?.[""]?.version}`);
console.log(`distinct strings in docs/: ${[...seen].join(", ") || "none"}`);
console.log(bad ? `${bad} mismatch(es)` : "all release strings agree");
process.exit(bad ? 1 : 0);
