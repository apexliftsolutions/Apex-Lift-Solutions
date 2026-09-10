// =============================================================================
//  P2-B — cache and asset delivery
//  GitHub Pages sets no custom headers, so the strategy IS the URL. This asserts
//  the two-tier rule: code assets always versioned, content assets bare by
//  decision, and no orphaned bytes in the publishing root.
// =============================================================================
import { readFileSync, readdirSync, existsSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const HTML = readdirSync(D).filter(f => f.endsWith(".html"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"));
const V = pkg.apexRelease;

console.log("═══ TIER 1: EVERY CODE ASSET IS VERSIONED ═══");
{
  const bare = [], wrong = [];
  for (const f of HTML) {
    for (const m of read(f).matchAll(/(?:src|href)="([^"]+\.(?:js|css))(\?[^"]*)?"/g)) {
      const [, path, q = ""] = m;
      if (/^(https?:|\/\/)/.test(path)) continue;
      if (!q.includes("?v=")) bare.push(`${f}: ${path}`);
      else if (new URLSearchParams(q.slice(1)).get("v") !== V) wrong.push(`${f}: ${path}${q}`);   // exact, not substring
    }
  }
  ok(bare.length === 0, `C1 no first-party JS/CSS is referenced without a version (${bare.slice(0,3).join(" | ") || "none"})`);
  ok(wrong.length === 0, `C2 every version parameter equals apexRelease (${wrong.slice(0,2).join(" | ") || "none"})`);
  // The specific files that were bare — a stale portal-login.js after the
  // handler migration meant buttons wired to functions never attached.
  for (const f of ["main.js", "portal-login.js", "portal-forgot.js", "portal-auth.css", "style.css", "portal-data.js"]) {
    const users = HTML.filter(p => new RegExp(`(?:src|href)="${f.replace(".", "\\.")}`).test(read(p)));
    const unversioned = users.filter(p => !new RegExp(`${f.replace(".", "\\.")}\\?v=${V.replace(/\./g, "\\.")}`).test(read(p)));
    ok(unversioned.length === 0, `C3 ${f}: versioned on all ${users.length} page(s) that load it (bare on: ${unversioned.join(",") || "none"})`);
  }
  ok(/vendor\/supabase-js-2\.116\.0\.umd\.js\?v=/.test(read("portal-admin.html")),
     "C4 the vendored SDK is versioned by filename AND parameter");
}

console.log("\n═══ TIER 2: CONTENT ASSETS ARE BARE BY DECISION ═══");
{
  // Fonts are referenced from a versioned stylesheet, so a font change that
  // needs a CSS edit already busts the CSS. Not versioning them is the decision.
  const css = read("style.css");
  const fontRefs = [...css.matchAll(/url\('(assets\/fonts\/[^'?]+)(\?[^']*)?'\)/g)];
  ok(fontRefs.length === 7, `C5 seven font references in style.css (${fontRefs.length})`);
  ok(fontRefs.every(m => !m[2]), "C6 fonts are deliberately unversioned — the stylesheet that names them is versioned");
  ok(fontRefs.every(m => existsSync(D + m[1])), "C7 every referenced font file exists");
  const doc = readFileSync(new URL("../internal-docs/CACHE_STRATEGY.md", import.meta.url).pathname, "utf8");
  ok(/bare by decision/i.test(doc), "C8 the decision is documented, not implicit");
  ok(/does not allow custom response headers/i.test(doc), "C9 the platform header constraint is recorded");
  ok(/immutable/.test(doc) && /hosting decision/i.test(doc), "C10 long-lived caching is correctly attributed to a host change, not code");
}

console.log("\n═══ NO ORPHANED BYTES IN THE PUBLISHING ROOT ═══");
{
  const all = HTML.map(read).join("\n") + readdirSync(D).filter(f => /\.(js|css|xml|txt)$/.test(f)).map(read).join("\n");
  const assets = readdirSync(D).filter(f => /\.(png|jpe?g|ico|svg|webp)$/.test(f));
  const orphans = assets.filter(a => !all.includes(a));
  ok(orphans.length === 0, `O1 every image in docs/ is referenced by something (${orphans.join(",") || "none"})`);
  ok(!existsSync(D + "og-image.png"), "O2 the 182 KB unreferenced og-image.png is gone");
  ok(existsSync(D + "og-image.jpg"), "O3 the referenced og-image.jpg remains");
  const og = [...read("index.html").matchAll(/og:image"[^>]*content="([^"]+)"/g)].map(m => m[1]);
  ok(og.length === 1 && og[0].endsWith("/og-image.jpg"), `O4 og:image points at the JPEG (${og.join(",")})`);
}

console.log("\n═══ PRELOADS MATCH REAL FILES ═══");
for (const f of HTML) {
  for (const m of read(f).matchAll(/<link rel="preload" href="([^"]+)"/g))
    ok(existsSync(D + m[1].split("?")[0]), `P1 ${f} preloads an existing file (${m[1]})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
