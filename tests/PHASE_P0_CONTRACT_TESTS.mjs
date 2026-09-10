// =============================================================================
//  P0 — public form <-> Edge Function contract, and service-request truthfulness
//  Cross-boundary: the frontend field names are read from the real HTML and
//  checked against the real server allow-list and required-field rules.
// =============================================================================
import { readFileSync, existsSync } from "fs";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const D = new URL("../docs/", import.meta.url).pathname;
const read = f => readFileSync(D + f, "utf8");
const SRV = readFileSync(new URL("../supabase/functions/public-contact/index.ts", import.meta.url).pathname, "utf8");

// Parse the ACTUAL server contract rather than restating it.
const LIMITS = Object.fromEntries(
  [...SRV.slice(SRV.indexOf("const LIMITS"), SRV.indexOf("};", SRV.indexOf("const LIMITS")))
     .matchAll(/(\w+)\s*:\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
const reqService = [...SRV.matchAll(/form === "request_service" && \(([^)]*)\)/g)][0][1]
  .match(/clean\.(\w+)/g).map(s => s.replace("clean.", ""));
const reqCareers = [...SRV.matchAll(/form === "careers" && \(([^)]*)\)/g)][0][1]
  .match(/clean\.(\w+)/g).map(s => s.replace("clean.", ""));

// The frontend normaliser, taken from the shipped module's own rule.
const norm = k => k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const fieldsOf = f => [...read(f).matchAll(/<(?:input|select|textarea)\b[^>]*\sname="([^"]+)"/g)]
  .map(m => m[1]).filter(n => n !== "_gotcha" && n !== "_next")
  .filter(n => !/^(viewport|theme-color|description|referrer)$/.test(n));

console.log("═══ SERVER CONTRACT AS SHIPPED ═══");
ok(Object.keys(LIMITS).length >= 16, `S1 allow-list has ${Object.keys(LIMITS).length} fields`);
ok(reqService.join(",") === "name,phone,issue,zip", `S2 request_service requires ${reqService.join(", ")}`);
ok(reqCareers.join(",") === "name,email,about", `S3 careers requires ${reqCareers.join(", ")}`);

console.log("\n═══ EVERY POSTED FIELD SURVIVES THE ALLOW-LIST ═══");
for (const [f, type] of [["index.html", "request_service"], ["contact.html", "request_service"],
                         ["careers.html", "careers"]]) {
  const dropped = fieldsOf(f).map(norm).filter(k => !(k in LIMITS));
  ok(dropped.length === 0, `A1 ${f}: no field is silently discarded (${dropped.join(", ") || "none"})`);
}
{
  // The specific fields that were being thrown away.
  for (const k of ["service_needed", "number_of_forklifts"])
    ok(k in LIMITS, `A2 ${k} is accepted by the server`);
  for (const k of ["position", "availability", "portfolio_link"])
    ok(k in LIMITS, `A3 ${k} is accepted by the server`);
}

console.log("\n═══ EVERY REQUIRED FIELD IS COLLECTED *AND* REQUIRED IN MARKUP ═══");
// Which controls actually carry the `required` attribute, by posted field name.
const requiredInMarkup = (f) => {
  const out = new Set();
  for (const m of read(f).matchAll(/<(?:input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[1];
    const nm = /\sname="([^"]+)"/.exec(attrs);
    if (nm && /\srequired(?=[\s/>=])/.test(attrs + " ")) out.add(norm(nm[1]));
  }
  return out;
};
for (const [f, req] of [["index.html", reqService], ["contact.html", reqService], ["careers.html", reqCareers]]) {
  const posted = fieldsOf(f).map(norm);
  const missing = req.filter(k => !posted.includes(k));
  ok(missing.length === 0, `R1 ${f} collects every required field (missing: ${missing.join(", ") || "none"})`);
  // Presence is not enough: a server-required field that is optional in the
  // browser lets an empty submission through to a guaranteed missing_fields.
  const marked = requiredInMarkup(f);
  const optional = req.filter(k => !marked.has(k));
  ok(optional.length === 0,
     `R1b ${f}: every server-required field is also required in markup (optional: ${optional.join(", ") || "none"})`);
}
{
  // Named explicitly because this is the field that slipped through.
  ok(requiredInMarkup("contact.html").has("issue"),
     "R1c contact.html's message textarea carries required");
  for (const k of ["name", "phone", "issue", "zip"])
    ok(requiredInMarkup("contact.html").has(k), `R1d contact.html requires ${k} in markup`);
  // And optional fields must NOT have been swept up.
  for (const k of ["company", "service_needed", "number_of_forklifts"])
    ok(!requiredInMarkup("contact.html").has(k), `R1e ${k} stays optional`);
  const labelled = (read("contact.html").match(/<label[^>]*>[^<]*\*/g) || []).length;
  ok(labelled >= 5, `R1f ${labelled} labels carry a visible required marker`);
}
{
  // This is the exact defect: contact.html posted no phone and no zip.
  const c = fieldsOf("contact.html").map(norm);
  ok(c.includes("phone"), "R2 contact.html posts a canonical `phone`");
  ok(c.includes("zip"), "R3 contact.html posts a `zip` — request_service requires it");
  const html = read("contact.html");
  ok(/<input[^>]*name="phone"[^>]*\srequired/.test(html), "R4 phone is marked required in the markup");
  ok(/<input[^>]*name="zip"[^>]*\srequired/.test(html), "R5 zip is marked required in the markup");
  ok(!/name="Phone Number"|name="Service Needed"|name="Number of Forklifts"/.test(html),
     "R6 no pretty label text is used as an API field name");
  ok(!/name="Position"|name="Availability"|name="Portfolio Link"/.test(read("careers.html")),
     "R7 careers likewise uses canonical names");
}

console.log("\n═══ SERVER ROBUSTNESS ═══");
ok(/if \(subErr \|\| !sub\?\.id\)/.test(SRV), "B1 a failed submission insert is handled, not dereferenced");
ok(!/sub!\.id/.test(SRV.replace(/\/\/[^\n]*/g, "")), "B2 no sub!.id remains in code");
ok(/submission_failed/.test(SRV) && !/PGRST|postgres|supabase\.co/i.test(SRV.split("submission_failed")[1].slice(0, 200)),
   "B3 the error response leaks no provider detail");
ok(/rlErr/.test(SRV) && /upErr/.test(SRV), "B4 rate-limit read and upsert errors are handled");
ok(/enqueue failed/.test(SRV), "B5 a queueing failure does not fail the submission");
ok(/CONTACT_IP_HASH_SALT/.test(SRV) && /server_misconfigured/.test(SRV), "B6 salt still fails closed");
ok(/_gotcha/.test(SRV), "B7 honeypot preserved");
ok(/RATE_PER_HOUR/.test(SRV), "B8 rate limiting preserved");

console.log("\n═══ SERVICE REQUEST TELLS THE TRUTH ═══");
{
  const js = read("portal-customer.js");
  const fn = js.slice(js.indexOf("async function submitRequest"), js.indexOf("// ── CONFIRM MODAL"));
  ok(/if \(reqErr \|\| !savedReq\) \{/.test(fn), "T1 a save failure is detected");
  ok(/throw new Error\('request_not_saved'\)/.test(fn), "T2 and throws instead of continuing");
  const okIdx = fn.indexOf("✓ Request sent!"), errIdx = fn.indexOf("request_not_saved");
  ok(errIdx > -1 && errIdx < okIdx, "T3 the failure check runs BEFORE the success message");
  ok(/failedUploads\+\+/.test(fn), "T4 attachment failures are counted");
  ok(/could not be uploaded/.test(fn), "T5 a partial upload failure is reported honestly");
  ok(/\$\{warn\}/.test(fn), "T6 the warning is part of the success message");
  ok(!/const fileLinks/.test(fn), "T7 the dead fileLinks variable is gone");
  ok(/Your service request was not saved, so your form details are still here/.test(fn),
     "T8 the error state is scoped to the FORM, not to everything");
  ok(!/Nothing was saved/.test(fn),
     "T8a it does not claim nothing at all was saved — uploads run before the insert");
  ok(!/files? (were|was) (deleted|removed)/i.test(fn), "T8b and never claims uploads were deleted");
  ok(!/msgEl\.textContent = '[^']*<a /.test(fn), "T9 no literal markup inside textContent");
  ok(/document\.createElement\('a'\)/.test(fn), "T10 the phone link is built as a real node");
  const clearIdx = fn.indexOf("req-equip').value   = ''");
  ok(clearIdx > errIdx, "T11 the form is only cleared after the insert is confirmed");
}

console.log("\n═══ FOLLOW-UPS AND STALE CLAIMS ═══");
{
  const fu = new URL("../internal-docs/SERVICE_REQUESTS_2_FOLLOWUP.md", import.meta.url).pathname;
  ok(existsSync(fu), "F1 the Service Requests 2.0 follow-up is recorded");
  const t = readFileSync(fu, "utf8");
  ok(/orphan/i.test(t), "F2 it names the orphaned-object problem");
  ok(/Do not solve this by letting customers delete arbitrary Storage objects/i.test(t),
     "F3 and warns against weakening Storage RLS to fix it");
  const pf = read("public-forms.js");
  ok(!/The Edge Function is\s*\n?\s*not modified/.test(pf),
     "F4 public-forms.js no longer claims the Edge Function was not modified");
  ok(/authorised P0 pass/.test(pf), "F5 it records that public-contact was changed later");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
