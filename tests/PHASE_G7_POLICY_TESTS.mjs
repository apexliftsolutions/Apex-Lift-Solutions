// =============================================================================
//  GROUP 7 — policy accuracy and consistency
//  Asserts the policy set matches the implementation and does not contradict
//  itself or overclaim. Run: node tests/PHASE_G7_POLICY_TESTS.mjs
// =============================================================================
import { readFileSync, existsSync, readdirSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const POLICIES = ["privacy.html", "terms.html", "refund-policy.html", "cookie-policy.html", "accessibility.html"];
const pages = readdirSync(D).filter(f => f.endsWith(".html"));
const text = f => read(f).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("═══ PAGES EXIST AND ARE REACHABLE ═══");
for (const p of POLICIES) ok(existsSync(D + p), `E1 ${p} exists`);
{
  const linked = pages.filter(p => /id="apex-cookie-settings"/.test(read(p)));
  ok(linked.length >= 11, `E2 the legal footer appears on ${linked.length} pages`);
  for (const target of POLICIES) {
    const from = pages.filter(p => new RegExp(`href="${target}"`).test(read(p)));
    ok(from.length >= 10, `E3 ${target} is linked from ${from.length} pages`);
  }
  // No dead internal policy links.
  const dead = [];
  for (const p of pages) for (const m of read(p).matchAll(/href="([a-z0-9-]+\.html)"/g))
    if (!existsSync(D + m[1])) dead.push(`${p} -> ${m[1]}`);
  ok(dead.length === 0, `E4 no dead policy links (${dead.join(", ") || "none"})`);
}

console.log("\n═══ DRAFT MARKERS ═══");
for (const p of POLICIES)
  ok(/^<!-- DRAFT — REQUIRES OWNER \/ LEGAL REVIEW/.test(read(p)), `D1 ${p} carries the source draft marker`);

console.log("\n═══ NO OVERCLAIMING ═══");
const BANNED = [
  [/fully (WCAG|compliant)/i, "claims full WCAG compliance"],
  [/100% accessible/i, "claims 100% accessible"],
  [/we are (GDPR|CCPA|SHIELD)[- ]?(Act )?compliant/i, "claims statutory compliance"],
  [/we never share (your )?(data|information)/i, "claims data is never shared"],
  [/we do not collect any/i, "claims no collection"],
  [/all (payments|purchases) (are )?(fully )?refundable/i, "promises universal refunds"],
  [/no refunds under any circumstance/i, "promises no refunds ever"],
  [/lorem ipsum/i, "placeholder text"],
];
for (const p of POLICIES) {
  const t = text(p);
  const hits = BANNED.filter(([re]) => re.test(t)).map(([, l]) => l);
  ok(hits.length === 0, `O1 ${p} makes no unsupported claim (${hits.join("; ") || "clean"})`);
}

console.log("\n═══ MATCHES THE IMPLEMENTATION ═══");
{
  // Fixed term, not indefinite auto-renewal. This is the claim most likely to
  // drift away from the code, and the one with legal weight.
  const t = text("terms.html");
  ok(/does not renew automatically/i.test(t), "M1 Terms state plans do not auto-renew");
  ok(/fixed number of monthly payments/i.test(t), "M2 Terms describe a fixed number of payments");
  for (const p of POLICIES) {
    const s = text(p);
    ok(!/(renews?|renewal) (automatically )?(forever|indefinitely|until cancell?ed)/i.test(s),
       `M3 ${p} never implies indefinite auto-renewal`);
  }
  ok(/does not (automatically )?refund|does not refund payments already/i.test(text("refund-policy.html")),
     "M4 Refund policy states cancellation does not refund past charges");
  ok(/cancel/i.test(text("terms.html")) && /refund/i.test(text("terms.html")),
     "M5 Terms cross-reference cancellation and refunds");
}
{
  // No card data is stored — the schema has no such column.
  const schema = readFileSync(new URL("../supabase/migrations/0001_fresh_test_only.sql", import.meta.url).pathname, "utf8");
  ok(!/card_number|cvv|routing_number/i.test(schema), "M6 schema really has no card/CVV/routing columns");
  ok(/payment (credentials|details)[^.]*(provider|Helcim)/i.test(text("privacy.html")) ||
     /Helcim/i.test(text("privacy.html")), "M7 Privacy names the payment processor");
}
{
  // Analytics claims must match Group 4's consent gate.
  const c = text("cookie-policy.html");
  ok(/off (until|unless) you/i.test(c), "M8 Cookie policy states analytics is off until accepted");
  ok(/Accept analytics|Reject non-essential|Manage preferences/i.test(c) ||
     /Cookie Settings/i.test(c), "M9 Cookie policy uses the real UI wording");
  ok(!/advertis|personalis|personaliz|social media (pixel|tracking)/i.test(c),
     "M10 no invented advertising/personalisation categories");
  // GA must genuinely not be on the portals.
  for (const p of ["portal-admin.html", "portal-customer.html"])
    ok(!/googletagmanager/.test(read(p)), `M11 ${p} loads no analytics, as the policy says`);
}
{
  // No marketing/SMS features exist, so no marketing boilerplate.
  const anySms = POLICIES.some(p => /\bSMS\b|text message marketing/i.test(text(p)));
  ok(!anySms, "M12 no SMS marketing language (no SMS feature exists)");
  ok(/not marketing|are not marketing/i.test(text("terms.html")),
     "M13 Terms state service email is transactional, not marketing");
}

console.log("\n═══ OWNER DECISIONS ARE FLAGGED, NOT INVENTED ═══");
{
  const flagged = POLICIES.reduce((n, p) => n + (read(p).match(/OWNER POLICY REQUIRED|OWNER DECISION REQUIRED/g) || []).length, 0);
  ok(flagged >= 10, `F1 ${flagged} owner decisions explicitly flagged rather than answered`);
  const t = text("terms.html");
  // Numbers that would be invented if we were careless.
  ok(!/\b\d+% (interest|per month)/i.test(t), "F2 no invented interest rate");
  ok(!/late fee of \$/i.test(t), "F3 no invented late fee");
  ok(!/\$\d+ (service call|diagnostic|travel) fee/i.test(t), "F4 no invented service-call fee");
  ok(/OWNER POLICY REQUIRED/.test(read("refund-policy.html")), "F5 refund eligibility left to the owner");
}

console.log("\n═══ NO SECRETS OR IMPLEMENTATION LEAKAGE ═══");
for (const p of POLICIES) {
  const s = read(p);
  const leaks = [/SIGNATURE_IP_SALT/, /SERVICE_ROLE/, /api-token/i, /RECONCILE_WORKER_KEY/,
                 /supabase\.co\/functions/, /maxCycles/, /eyJ[A-Za-z0-9]{20,}/];
  const hit = leaks.find(re => re.test(s));
  ok(!hit, `S1 ${p} exposes no secret or internal identifier${hit ? " (" + hit + ")" : ""}`);
}
ok(/salted|one-way/i.test(text("privacy.html")) && !/SIGNATURE_IP_SALT/.test(read("privacy.html")),
   "S2 Privacy explains IP hashing in plain language without naming the secret");

console.log("\n═══ SEO / STRUCTURE ═══");
for (const p of POLICIES) {
  const s = read(p);
  ok(/<title>[^<]{15,90}<\/title>/.test(s), `Q1 ${p} has a meaningful title`);
  ok(/<meta name="description" content="[^"]{40,}"/.test(s), `Q2 ${p} has a meta description`);
  ok((s.match(/<h1/g) || []).length === 1, `Q3 ${p} has exactly one h1`);
  ok(/<main id="main-content"/.test(s), `Q4 ${p} has a main landmark`);
  ok(/skip-link/.test(s), `Q5 ${p} has a skip link`);
}


console.log("\n═══ FOLLOW-UP: STALE THIRD-PARTY CLAIMS ═══");
{
  // The cookie policy must not name a runtime third party the code no longer
  // contacts. Group 5 self-hosted both of these; the policy said otherwise.
  const c = read("cookie-policy.html");
  const canonicalHasFonts = pages.some(p => /fonts\.(googleapis|gstatic)\.com/.test(read(p)));
  const canonicalHasJsDelivr = pages.some(p => /cdn\.jsdelivr\.net/.test(read(p)));
  ok(!canonicalHasFonts, "SF1 canonical docs/ contacts no Google Fonts origin");
  ok(!canonicalHasJsDelivr, "SF2 canonical docs/ contacts no jsDelivr origin");
  ok(canonicalHasFonts || !/Google Fonts/i.test(c),
     "SF3 cookie policy does not claim Google Fonts is a runtime third party");
  ok(canonicalHasJsDelivr || !/jsDelivr/i.test(c),
     "SF4 cookie policy does not claim jsDelivr is a runtime third party");
  ok(/Supabase/.test(c) && /Helcim/.test(c) && /Google Analytics/.test(c),
     "SF5 cookie policy names the origins that ARE contacted");
  ok(!/schema\.org|w3\.org|tools\.google\.com/.test(c),
     "SF6 ordinary link targets are not listed as processors");
}

console.log("\n═══ FOLLOW-UP: NOTHING UNRESOLVED IS CUSTOMER-VISIBLE ═══");
{
  const visible = f => read(f).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
  for (const p of POLICIES) {
    const t = visible(p);
    for (const marker of ["OWNER POLICY REQUIRED", "OWNER DECISION REQUIRED",
                          "LEGAL REVIEW REQUIRED", "Draft for review", "Draft — requires"]) {
      ok(!t.includes(marker), `PV1 ${p} does not display "${marker}"`);
    }
    ok(/^<!-- DRAFT — REQUIRES OWNER \/ LEGAL REVIEW/.test(read(p)),
       `PV2 ${p} keeps the source-level draft comment`);
  }
  const doc = new URL("../internal-docs/GROUP7_OWNER_POLICY_DECISIONS.md", import.meta.url).pathname;
  ok(existsSync(doc), "PV3 the internal owner-decision register exists");
  const d = readFileSync(doc, "utf8");
  for (const section of ["BUSINESS IDENTITY", "QUOTES AND SERVICE CALLS", "PAYMENTS",
                         "FIXED-TERM SERVICE PLANS", "REFUNDS", "WARRANTY AND LIABILITY",
                         "ELECTRONIC SIGNATURES", "GOVERNING LAW", "DATA RETENTION"]) {
    ok(d.includes(section), `PV4 register covers ${section}`);
  }
  ok(/A\.[\s\S]*B\.[\s\S]*C\.[\s\S]*D\./.test(d), "PV5 early-cancellation options A–D posed without an answer chosen");
}

console.log("\n═══ FOLLOW-UP: FIXED-TERM CANCELLATION IS NOT DECIDED IN COPY ═══");
{
  const t = text("terms.html"), r = text("refund-policy.html");
  // Must not promise the remaining term is waived.
  for (const [name, s] of [["terms", t], ["refund policy", r]]) {
    ok(!/no further (charges|payments) (are|will be) (owed|due)/i.test(s),
       `FC1 ${name} does not promise nothing further is owed`);
    ok(!/cancel(l)?ing (the plan )?(ends|waives|cancels) (the )?(remaining|rest of)/i.test(s),
       `FC2 ${name} does not promise the remaining term is waived`);
  }
  ok(/future automatic charges/i.test(t) && /future automatic charges/i.test(r),
     "FC3 both describe stopping FUTURE AUTOMATIC CHARGES, not ending the contract");
  ok(/separate/i.test(t) && /separate/i.test(r),
     "FC4 both state the remaining obligation is a separate question");
  ok(/not the same as an entitlement|capability is not/i.test(r),
     "FC5 refund policy separates technical capability from entitlement");
}

console.log("\n═══ FOLLOW-UP: PRIVACY WORDING ═══");
{
  const p = text("privacy.html");
  ok(new RegExp("Last updated: 8 September 2026").test(p), "PW1 privacy carries the current revision date");
  ok(!/anonymous website analytics/i.test(p), "PW2 GA4 is no longer described as anonymous analytics");
  ok(/optional website usage analytics/i.test(p), "PW3 GA4 described as optional usage analytics");
  ok(/off unless you choose/i.test(p), "PW4 privacy matches the consent gate");
  ok(/cannot guarantee that usage analytics is anonymous/i.test(p),
     "PW5 privacy declines to claim anonymity");
  ok(!/Request deletion of your account by contacting us/i.test(p), "PW6 unqualified deletion promise removed");
  ok(/where we are able to/i.test(p) && /(legal|accounting|tax)/i.test(p),
     "PW7 deletion is qualified by records that must be retained");
  ok(!/\[OWNER DECISION REQUIRED/.test(p), "PW8 the retention placeholder is no longer rendered");
  ok(/as long as it is reasonably necessary/i.test(p), "PW9 retention stated generally, with no invented period");
  ok(!/\b(30|90|180) days\b|\b7 years\b/.test(p), "PW10 no invented retention period");
}

console.log("\n═══ FOLLOW-UP: NO NEW PAYMENT CHANNEL PROMISED ═══");
for (const p of POLICIES) {
  const t = text(p);
  ok(!/(take|takes|taking) (it|payment|your (card|payment)) over the (phone|telephone)/i.test(t),
     `AP1 ${p} does not promise telephone payment collection`);
  ok(!/read (us )?your card (number|details) over/i.test(t), `AP2 ${p} does not invite card details by phone`);
}
ok(/accessible option/i.test(text("accessibility.html")),
   "AP3 accessibility offers help without promising a new payment channel");

console.log("\n═══ FOLLOW-UP: SITEMAP ═══");
{
  const sm = read("sitemap.xml");
  for (const p of POLICIES) ok(sm.includes(`/${p}</loc>`), `SM1 sitemap lists ${p}`);
  for (const portal of ["portal-admin.html", "portal-customer.html", "portal-login.html",
                        "portal-forgot.html", "portal-reset.html"]) {
    ok(!sm.includes(portal), `SM2 sitemap excludes the authenticated page ${portal}`);
  }
  ok(/<lastmod>2026-09-09<\/lastmod>/.test(sm) && !/<lastmod>2026-09-0[1-8]<\/lastmod>/.test(sm),
     "SM3 lastmod reflects the v25 revision on every public page");
  const locs = (sm.match(/<loc>/g) || []).length;
  ok(locs === 11, `SM4 sitemap has 11 public URLs (${locs})`);
}

console.log("\n═══ FOLLOW-UP: DATES CONSISTENT ═══");
for (const p of POLICIES) ok(/8 September 2026/.test(text(p)), `DT1 ${p} carries the current revision date`);


console.log("\n═══ FINAL: CURRENT NY §527-a NOTE ═══");
{
  const note = readFileSync(new URL("../internal-docs/GROUP7_OWNER_POLICY_DECISIONS.md", import.meta.url).pathname, "utf8");
  const flat0 = note.replace(/\s+/g, " ");
  // Corrected: the 15–45 day window in § 527-a(1)(f) is CURRENT law. The earlier
  // assertion called it obsolete, which would have rejected accurate documentation.
  // Detect a CLAIM of obsolescence, not a denial of one. The note deliberately
  // contains the word while correcting the earlier mistake, so a naive match on
  // "obsolete" near "15–45" flags the very sentence that fixes the error.
  const obsoleteClaims = [...flat0.matchAll(/obsolete/gi)]
    .filter(m => !/not an $|not $|as "$/i.test(flat0.slice(Math.max(0, m.index - 8), m.index)));
  ok(obsoleteClaims.length === 0,
     `NY1 the note never asserts the 15–45 window is obsolete (${obsoleteClaims.length} unqualified use)`);
  ok(!/(no longer (applies|in force)|superseded|repealed)[^.]{0,40}15[–-]45/i.test(flat0),
     "NY1a nor describes it as superseded or repealed");
  ok(!/15[–-]45/.test(flat0) || /initial paid term of one year or longer/i.test(flat0),
     "NY1b where 15–45 appears it carries its statutory trigger (one-year initial term)");
  ok(!/15[–-]45/.test(flat0) || /renews for a paid term of six months or longer/i.test(flat0),
     "NY1c and the second trigger condition (six-month renewal term)");
  ok(/current law, not an obsolete provision/i.test(flat0),
     "NY1d the note states plainly that the window is current law");
  ok(!/Apex[^.]{0,80}(must|shall) (send|give)[^.]{0,40}(15|fifteen)[^.]{0,20}(45|forty-five)/i.test(flat0),
     "NY1e the window is not presented as an Apex obligation today");
  ok(/2025-11-07/.test(note), "NY2 the current revision date is recorded");
  ok(/nysenate\.gov\/legislation\/laws\/GBS\/527\b/.test(note) &&
     /nysenate\.gov\/legislation\/laws\/GBS\/527-A/.test(note),
     "NY3 both official statute URLs are cited as primary sources");
  ok(!/katten\.com|harrisbeach/.test(note),
     "NY4 superseded secondary summaries are no longer cited for operative requirements");
  ok(/RECHECK CURRENT LAW BEFORE LAUNCHING ANY FUTURE AUTO-RENEWAL PRODUCT/.test(note),
     "NY5 the note tells a future developer to recheck the then-current law");
  ok(/counsel should confirm before anyone relies/i.test(note),
     "NY6 framed as issue spotting, not a determination");
  ok(!/the law does not apply|is not subject to|statute does not apply/i.test(note),
     "NY7 never states definitively that the law does not apply");
  // The markdown wraps mid-quote, so collapse whitespace before matching.
  const flat = note.replace(/\s+/g, " ");
  ok(/personal, family, or household purposes/.test(flat) &&
     /automatically renewed at the end of a definite term/.test(flat),
     "NY8 quotes the two statutory definitions the distinction rests on");
  ok(/fixed number of monthly cycles|max_cycles/.test(note),
     "NY9 records the Apex implementation fact the distinction rests on");
}

console.log("\n═══ FINAL: TERMS WORDING ═══");
{
  const t = text("terms.html");
  ok(!/treated as authorised by you/i.test(t),
     "TW1 Terms no longer deem all account activity authorised by the holder");
  ok(/verify instructions or account activity/i.test(t),
     "TW2 Terms use narrow operational wording instead");
  ok(!/as valid as a paper one|legally equivalent to (a )?paper/i.test(t),
     "TW3 Terms make no legal-enforceability conclusion about electronic agreements");
  ok(/intend your typed name to serve as your electronic signature/i.test(t),
     "TW4 Terms express intent and consent to electronic records instead");
  ok(/receive and retain the agreement electronically/i.test(t),
     "TW5 Terms cover retention of the electronic record");
  const raw = read("terms.html");
  ok(/REQUIRES LEGAL REVIEW: ESIGN/.test(raw), "TW6 e-signature legal review flagged in source only");
  ok(/OWNER POLICY REQUIRED: account-risk/.test(raw), "TW7 account-risk decision flagged in source only");
}

console.log("\n═══ FINAL: NO PHONE-CREDENTIAL IMPLICATION ═══");
for (const p of POLICIES) {
  const t = text(p);
  ok(!/(take|process|accept)[^.]{0,40}payment[^.]{0,20}(over|by) (the )?(phone|telephone)/i.test(t),
     `PC1 ${p} does not offer to process payment by phone`);
  ok(!/by phone or in person[^.]{0,60}(handle|take)[^.]{0,30}payments/i.test(t),
     `PC2 ${p} does not imply handling payments by phone`);
}
ok(/help you access or arrange an available way/i.test(text("accessibility.html")),
   "PC3 accessibility offers assistance, not credential collection");

console.log("\n═══ FINAL: AUTHENTICATION WORDING ═══");
{
  const p = text("privacy.html");
  ok(!/Account credentials \(email and password\)/i.test(p),
     "AU1 the blunt 'email and password' collection claim is gone");
  ok(/processed through our authentication provider/i.test(p),
     "AU2 credentials described as processed by the auth provider");
  ok(/does not store plaintext passwords/i.test(p),
     "AU3 Data Security states Apex stores no plaintext passwords");
  ok(/Supabase/.test(p), "AU4 the authentication provider is named");
  ok(!/we hash your password|we salt and hash/i.test(p),
     "AU5 Apex does not claim to perform the hashing itself");
}

console.log("\n═══ FINAL: ANALYTICS PREFERENCE WORDING ═══");
{
  const c = text("cookie-policy.html");
  ok(!/no website can/i.test(c), "AN1 the universal 'no website can' claim is gone");
  ok(/stops future optional analytics collection from this site/i.test(c),
     "AN2 scoped to this site's future collection");
  ok(/does not retract information already sent/i.test(c),
     "AN3 still honest that prior transmissions cannot be retracted");
}


console.log("\n═══ FINAL: GOB § 5-903 ISSUE SPOTTING ═══");
{
  const note = readFileSync(new URL("../internal-docs/GROUP7_OWNER_POLICY_DECISIONS.md", import.meta.url).pathname, "utf8");
  const flat = note.replace(/\s+/g, " ");
  ok(/GOB § 5-903|General Obligations Law § ?5-903|§ 5-903/.test(flat), "GO1 GOB § 5-903 is covered");
  ok(/nysenate\.gov\/legislation\/laws\/GOB\/5-903/.test(note), "GO2 official § 5-903 source recorded");
  ok(/individual, firm, company, partnership or corporation/i.test(flat),
     "GO3 quotes the broad 'person' definition that reaches businesses");
  ok(/not limited to household consumers|no personal-family-household limit/i.test(flat),
     "GO4 states plainly it is not limited to consumers");
  ok(/service, maintenance or repair/i.test(flat), "GO5 records the covered subject matter");
  ok(/fifteen days and not more than thirty days/i.test(flat),
     "GO6 records the 15–30 day window, distinct from § 527-a's 15–45");
  ok(/one month or less/i.test(flat), "GO7 records the one-month-or-less exclusion");
  ok(/appears absent on current implementation facts|likely not triggered/i.test(flat),
     "GO8 current Apex effect classified, not concluded");
  ok(!/§ ?5-903 (applies|does not apply) to Apex/i.test(flat),
     "GO9 no settled conclusion either way about Apex");
  ok(/in addition to/i.test(flat) && /527/.test(flat),
     "GO10 future auto-renewal work told to review BOTH statutes");
  ok(/windows differ|do not conflate/i.test(flat),
     "GO11 warns the two statutes' notice windows are different");
  ok(/Insurance Law § 7902|section seven thousand nine hundred two/i.test(flat),
     "GO12 the § 527-a(4)(e) service-contract exemption flag is retained");
}

console.log("\n═══ FINAL: PUBLIC PAGES STAY SILENT ON STATUTES ═══");
for (const p of POLICIES) {
  const t = text(p);
  ok(!/5-903|527-a|General Obligations Law|General Business Law/i.test(t),
     `PS1 ${p} does not cite these statutes to customers`);
  ok(!/we comply with|Apex complies with|in compliance with (New York|the )/i.test(t),
     `PS2 ${p} claims no statutory compliance`);
  ok(!/automatically renew/i.test(t), `PS3 ${p} does not describe plans as auto-renewing`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
