import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const customerPath = path.join(root, "supabase/functions/service-plans-customer/index.ts");
const adminPath = path.join(root, "supabase/functions/service-plans-admin/index.ts");
const emailPath = path.join(root, "supabase/functions/_shared/email.ts");
const customer = fs.readFileSync(customerPath, "utf8");
const admin = fs.readFileSync(adminPath, "utf8");
let pass = 0;
function ok(name, cond) {
  if (!cond) { console.error(`FAIL ${name}`); process.exitCode = 1; }
  else { console.log(`PASS ${name}`); pass++; }
}

ok("H1 customer contractual actions are active-account gated",
  customer.includes('["preview-agreement", "sign", "decline-offer"].includes(action)') &&
  customer.includes('account.status !== "active"') && customer.includes('account_not_active'));
ok("H2 agreement-url is not included in the active-account gate",
  !customer.includes('["preview-agreement", "sign", "decline-offer", "agreement-url"]'));
ok("H3 SIGNATURE_IP_SALT has no public fallback",
  !customer.includes('?? "apex-service-plans"') && customer.includes('SIGNATURE_IP_SALT is not configured'));
ok("H4 signing fails closed before atomic RPC if salt is absent",
  customer.indexOf('error: "server_config_error"') < customer.indexOf('db.rpc("accept_offer_and_sign_agreement"'));
ok("H5 admin send-offer loads owner and requires active status",
  admin.includes('equipment_id, customer_id') && admin.includes('customer.status !== "active"') && admin.includes('account_not_active'));

// Execute the actual shipping render() function without contacting Resend.
//
// Transpile with the esbuild API from package.json — NOT a global `tsc`. An
// earlier version spawned `tsc`, which happened to exist on the authoring
// machine via a global npm prefix and does not exist after a clean `npm ci`.
// A release gate must depend only on what the lockfile installs.
//
// esbuild strips types without type-checking, which is exactly right here: the
// module targets Deno, whose globals are not typed for Node, and we only need
// the emitted JS to run render().
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-email-test-"));
const tmp = path.join(tmpDir, "email.js");
let transpiled = false, transpileError = "";
try {
  buildSync({
    entryPoints: [emailPath],
    outfile: tmp,
    bundle: false,          // single file; keep its imports (none are used by render())
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
  });
  transpiled = fs.existsSync(tmp);
} catch (e) {
  transpileError = String(e && e.message || e).slice(0, 160);
}
ok("H6 email.ts transpiled for smoke test via esbuild", transpiled);
if (!transpiled) {
  // Do not fall through to `await import(nonexistent)` — that would replace a
  // clean, attributable failure with a confusing module-not-found stack.
  console.error(`FAIL H6 detail: ${transpileError || "no output file"}`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
globalThis.Deno = { env: { get: () => undefined } };
const { render } = await import(pathToFileURL(tmp).href + `?v=${Date.now()}`);

const payload = {
  customer_name: "Test O'Brien", company: "Testing LLC", customer_email: "test@example.com",
  plan_name: "Monthly Planned Maintenance", unit_number: "TEST-01", equipment: "Toyota 8FGCU25",
  serial_number: "SER123", service_location: "Test Yard", payment_method: "ach",
  ach_subtotal_cents: 100, ach_tax_cents: 9, ach_total_cents: 109,
  card_subtotal_cents: 110, card_tax_cents: 9, card_total_cents: 119,
  subtotal_cents: 100, tax_cents: 9, total_cents: 109, term_months: 6,
  activation_date: "2026-09-15", expires_at: "2026-09-30",
  signer_name: "Test O'Brien", signer_title: "Owner", agreement_id: "AGR-TEST",
  agreement_version: "TEST", included_services: ["Inspection"], exclusions: ["Parts"]
};
for (const type of ["service_plan_offer_sent", "service_plan_agreement_signed", "service_plan_agreement_signed_admin"]) {
  const out = render(type, payload);
  ok(`EMAIL ${type} does not use generic fallback`, !out.subject.includes(`— ${type}`) && !out.html.includes(`<pre>`));
  ok(`EMAIL ${type} exposes no private storage path`, !/apex-agreements|pdf_path|bucket|storage\/v1/i.test(out.html + out.text));
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
if (!process.exitCode) console.log(`All ${pass} hardening assertions passed.`);
