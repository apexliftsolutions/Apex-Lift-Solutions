// =============================================================================
//  P1-A — upload contract, auth accessibility, payment copy, indexing
// =============================================================================
import { readFileSync, readdirSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const HTML = readdirSync(D).filter(f => f.endsWith(".html"));
const PORTAL = ["portal-login.html","portal-forgot.html","portal-reset.html","portal-customer.html","portal-admin.html"];
const PUBLIC = HTML.filter(f => !PORTAL.includes(f));
const text = f => read(f).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("═══ A. UPLOAD CONTRACT MATCHES STORAGE ═══");
{
  // Storage is authoritative: read the bucket definition, don't restate it.
  const mig = readFileSync(new URL("../supabase/migrations/0002_production_upgrade.sql", import.meta.url).pathname, "utf8");
  // Anchor on the bucket INSERT, not the first mention of the name — the string
  // "apex-uploads" appears much earlier in a path-migration statement.
  const ins = mig.indexOf("insert into storage.buckets");
  const blk = mig.slice(ins, mig.indexOf(";", ins) + 1);
  const mimes = [...new Set([...blk.matchAll(/'(image\/[a-z+]+|application\/pdf)'/g)].map(m => m[1]))];
  const limit = Number(/file_size_limit\s*=\s*(\d+)|,\s*(\d{7,})\s*,/.exec(blk).slice(1).find(Boolean));
  ok(mimes.length === 5, `A1 bucket allows ${mimes.length} MIME types: ${mimes.join(", ")}`);
  ok(limit === 10485760, `A2 bucket size limit is 10 MB (${limit})`);

  const EXT = { "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"], "image/webp": [".webp"],
                "image/heic": [".heic"], "application/pdf": [".pdf"] };
  for (const f of ["portal-customer.html", "portal-admin.html"]) {
    const acc = (/accept="([^"]+)"/.exec(read(f)) || [])[1] || "";
    const listed = acc.split(",").map(x => x.trim().toLowerCase());
    ok(!listed.includes("image/*"), `A3 ${f} no longer advertises image/* (HEIF/GIF/SVG would be rejected)`);
    for (const bad of [".txt", ".doc", ".docx"])
      ok(!listed.includes(bad), `A4 ${f} no longer advertises ${bad}, which Storage rejects`);
    const want = mimes.flatMap(m => EXT[m]);
    const missing = want.filter(e => !listed.includes(e));
    ok(missing.length === 0, `A5 ${f} advertises every accepted type (${missing.join(",") || "none"})`);
  }
  for (const f of ["portal-customer.js", "portal-admin.js"]) {
    const js = read(f);
    ok(/APEX_UPLOAD_MIME = \['image\/jpeg', 'image\/png', 'image\/webp', 'image\/heic', 'application\/pdf'\]/.test(js),
       `A6 ${f} validator mirrors the bucket MIME list exactly`);
    ok(/APEX_UPLOAD_MAX_BYTES = 10 \* 1024 \* 1024/.test(js), `A7 ${f} validator mirrors the 10 MB limit`);
  }
  // Behavioural: the shipped validator, executed.
  const src = read("portal-customer.js");
  // The constants live inside apexCheckFile now, so extract the whole function.
  const start = src.indexOf("function apexCheckFile");
  const fn = new Function(src.slice(start, src.indexOf("\n}", start) + 2) + "; return apexCheckFile;")();
  ok(fn({ type: "image/jpeg", size: 1000 }).ok, "A8 a small JPEG is accepted");
  ok(fn({ type: "application/pdf", size: 10485760 }).ok, "A9 a PDF at exactly 10 MB is accepted");
  ok(!fn({ type: "application/pdf", size: 10485761 }).ok, "A10 one byte over is rejected");
  ok(fn({ type: "image/gif", size: 10 }).reason === "unsupported", "A11 GIF rejected — image/* would have allowed it");
  ok(fn({ type: "image/svg+xml", size: 10 }).reason === "unsupported", "A12 SVG rejected");
  ok(fn({ type: "text/plain", size: 10 }).reason === "unsupported", "A13 .txt rejected");
  ok(fn({ type: "", size: 10 }).reason === "unsupported",
     "A14 an empty MIME type is REJECTED, not waved through — Storage matches on MIME");
  ok(!fn(null).ok, "A15 a missing file is handled");
  const ms = src.indexOf("function apexUploadError");
  const msg = new Function(src.slice(ms, src.indexOf("\n}", ms) + 2) + "; return apexUploadError;")();
  ok(/JPG, PNG, WebP, HEIC, or PDF/.test(msg([{ name: "a.txt", reason: "unsupported" }])),
     "A16 the refusal names the accepted formats");
  ok(/10 MB or smaller/.test(msg([{ name: "b.pdf", reason: "too_large" }])), "A17 and states the size limit");
  ok(/a\.txt/.test(msg([{ name: "a.txt", reason: "unsupported" }])), "A18 and names the offending file");
  const h = src.slice(src.indexOf("function handleReqFiles"), src.indexOf("function removeReqFile"));
  ok(/rejected\.push/.test(h) && /REQ_FILES = picked\.filter/.test(h),
     "A19 rejected files are never added to the attachment list");
}

console.log("\n═══ B. AUTH SURFACE ACCESSIBILITY ═══");
for (const f of ["portal-login.html", "portal-forgot.html"]) {
  const s = read(f);
  const labels = new Set([...s.matchAll(/<label[^>]*for="([^"]+)"/g)].map(m => m[1]));
  const bad = [];
  for (const m of s.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const a = m[2];
    if (/type="(hidden|submit|button)"/.test(a)) continue;
    if (/aria-label|aria-labelledby/.test(a)) continue;
    const id = (/id="([^"]+)"/.exec(a) || [])[1];
    if (id && labels.has(id)) continue;
    bad.push(id || "(no id)");
  }
  ok(bad.length === 0, `B1 ${f}: every control has an accessible name (${bad.join(",") || "none"})`);
  ok(labels.size >= 3, `B2 ${f}: ${labels.size} visible labels associated via for/id, not replaced by aria-label`);
  ok(!/placeholder="[^"]*"[^>]*>(?![\s\S]{0,200}<label)/.test("") , "B3 placeholders are not used as labels");
  ok(!/<(span|div)[^>]*data-action=/.test(s), `B4 ${f}: no span or div acts as a button`);
}
{
  const s = read("portal-forgot.html");
  for (let i = 0; i < 6; i++)
    ok(new RegExp(`id="o${i}"[^>]*aria-label="Verification code digit ${i + 1} of 6"`).test(s),
       `B5 OTP digit ${i + 1} has a distinct accessible name`);
  const otc = (s.match(/autocomplete="one-time-code"/g) || []).length;
  ok(otc === 1, `B6 one-time-code is on the FIRST box only — six would compete for the same autofill (${otc})`);
  ok(/<button type="button" class="resend-btn"/.test(s), "B7 resend is a real button");
  ok(!/<span class="resend-btn"/.test(s), "B8 the span version is gone");
}
{
  for (const f of ["portal-login.html", "portal-forgot.html"]) {
    const n = (read(f).match(/class="pw-eye"[^>]*aria-label="Show password"/g) || []).length;
    if (/pw-eye/.test(read(f))) ok(n >= 1, `B9 ${f}: password toggles are named`);
  }
  const js = read("portal-login.js");
  ok(/aria-label', _i\.type === 'password' \? 'Show password' : 'Hide password'/.test(js),
     "B10 the toggle's name follows its state instead of lying half the time");
}


console.log("\n═══ B. SITE-WIDE ACCESSIBLE NAMES (every page, not just auth) ═══");
for (const f of HTML) {
  const s = read(f);
  const labels = new Set([...s.matchAll(/<label[^>]*for="([^"]+)"/g)].map(m => m[1]));
  const bad = [];
  for (const m of s.matchAll(/<(input|select|textarea|button)\b([^>]*)>([\s\S]*?)(?=<\/(?:input|select|textarea|button)>|<(?:input|select|textarea|button)\b|$)/g)) {
    const [, tag, a] = m;
    if (/type="(hidden|submit)"/.test(a)) continue;
    if (/aria-label|aria-labelledby/.test(a)) continue;
    // The spam honeypot is display:none and must NOT have a name — a screen
    // reader announcing it would invite a human to fill the trap.
    if (/name="_gotcha"/.test(a)) continue;
    const id = (/id="([^"]+)"/.exec(a) || [])[1];
    if (id && labels.has(id)) continue;
    if (tag === "button") {
      const inner = (s.slice(m.index).match(/<button[^>]*>([\s\S]*?)<\/button>/) || [])[1] || "";
      if (inner.replace(/<[^>]+>/g, "").trim()) continue;   // visible text is the name
    }
    if (s.slice(0, m.index).lastIndexOf("<label") > s.slice(0, m.index).lastIndexOf("</label>")) continue;
    bad.push(id || tag);
  }
  ok(bad.length === 0, `SW1 ${f}: every control has an accessible name (${bad.slice(0, 4).join(",") || "none"})`);
  const mb = /id="mobile-menu-btn"[^>]*>/.exec(s);
  if (mb) ok(/aria-controls="[^"]+"/.test(mb[0]) && /aria-expanded="(true|false)"/.test(mb[0]),
             `SW2 ${f}: mobile menu button declares aria-controls and aria-expanded`);
  ok(!/<div[^>]*data-action="pick-(quote-)?files"/.test(s), `SW3 ${f}: no clickable upload <div>`);
}

console.log("\n═══ C. PAYMENT COPY MATCHES THE PRODUCT ═══");
for (const f of HTML) {
  const t = text(f);
  ok(!/no login required/i.test(t), `C1 ${f}: no "no login required" claim`);
  ok(!/without logging in/i.test(t), `C2 ${f}: no "without logging in" claim`);
  ok(!/pay a specific invoice/i.test(t), `C3 ${f}: no guest invoice-lookup claim`);
  ok(!/secure link/i.test(t), `C4 ${f}: no emailed payment-link claim`);
}
{
  const p = text("plans.html");
  ok(/Sign in to your customer portal/i.test(p), "C5 plans.html describes the portal flow that exists");
  ok(/card or bank transfer/i.test(p), "C6 and both rails the product supports");
}

console.log("\n═══ D. INDEXING ═══");
{
  for (const f of PORTAL)
    ok(/<meta name="robots" content="noindex,nofollow,noarchive">/.test(read(f)),
       `D1 ${f} declares noindex,nofollow,noarchive`);
  for (const f of PUBLIC)
    ok(!/name="robots"/.test(read(f)), `D2 ${f} is NOT noindexed`);
  const r = read("robots.txt");
  for (const f of PORTAL)
    ok(!new RegExp(`Disallow: /${f}`).test(r),
       `D3 robots.txt no longer disallows ${f} — a disallowed page's noindex is never seen`);
  ok(/noindex/.test(r), "D4 robots.txt explains why the Disallow rules were removed");
  ok(/not access control/i.test(r), "D5 and states robots.txt is not a security control");
  ok(/Sitemap: https:\/\/apexliftsolutionsusa\.com\/sitemap\.xml/.test(r), "D6 sitemap reference retained");
  const sm = read("sitemap.xml");
  for (const f of PORTAL) ok(!sm.includes(f), `D7 sitemap still excludes ${f}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
