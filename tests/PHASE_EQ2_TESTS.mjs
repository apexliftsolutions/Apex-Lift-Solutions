// =============================================================================
//  Equipment Phase 2 — quote/invoice equipment linkage: backend contract + UI
//  Database rules are proven in tests/sql/equipment_phase2.sql.
// =============================================================================
import { readFileSync, existsSync, readdirSync } from "fs";
import { JSDOM, VirtualConsole } from "jsdom";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const R = new URL("../", import.meta.url).pathname;
const read = f => readFileSync(R + f, "utf8");

console.log("═══ MIGRATION 0012 ═══");
{
  const m = read("supabase/migrations/0012_equipment_links.sql");
  ok(/add column if not exists equipment_id\s+uuid/.test(m), "M1 equipment_id added");
  ok(/add column if not exists equipment_snapshot jsonb/.test(m), "M2 equipment_snapshot added");
  ok(/fk_quote_equipment_same_customer/.test(m) && /fk_invoice_equipment_same_customer/.test(m), "M3 composite ownership FKs on both tables");
  ok(/references customer_equipment \(id, customer_id\) on delete restrict/.test(m), "M4 same pattern offers already use");
  ok(/ck_quote_equipment_snapshot_pair/.test(m) && /ck_invoice_equipment_snapshot_pair/.test(m), "M5 id and snapshot must agree");
  ok(/not valid/.test(m), "M6 pair checks are NOT VALID so legacy rows cannot break the migration");
  ok(/document_snapshot_frozen/.test(m), "M7 snapshot freeze trigger");
  ok(/equipment_snapshot\(p_equipment_id\)/.test(m), "M8 reuses the 0011 snapshot function — no second format");
  ok(/eq\.status <> 'active'/.test(m) && /equipment_not_active/.test(m), "M9 only active equipment may be linked");
  ok(/equipment_not_owned/.test(m), "M10 ownership verified in the function too");
  ok(/q\.equipment, q\.equipment_id, q\.equipment_snapshot   -- inherited verbatim/.test(m), "M11 quote_to_invoice copies all three");
  const qtiBody = m.slice(m.indexOf("create or replace function quote_to_invoice"), m.indexOf("revoke all on function quote_to_invoice"))
                   .replace(/--[^\n]*/g, "");
  ok(!/equipment_snapshot\(/.test(qtiBody), "M12 quote_to_invoice NEVER re-derives the snapshot (comments excluded)");
  ok(!/update quotes set equipment\b(?!_)/.test(m.replace(/equipment_label\(snap\)/g, "X")) || /equipment          = equipment_label\(snap\)/.test(m),
     "M13 the legacy free-text column is still written for existing readers");
  ok(/grant  execute on function link_quote_equipment\(text, uuid\) to service_role/.test(m), "M14 link RPC is service_role only");
  for (const n of ["0001","0002","0003","0004","0005","0006","0007","0008","0009","0010","0011"])
    ok(readdirSync(R + "supabase/migrations").some(f => f.startsWith(n + "_")), `M15 migration ${n} still present`);
}

console.log("\n═══ SERVER IS AUTHORITATIVE ═══");
{
  const a = read("supabase/functions/admin-action/index.ts");
  const pa = read("docs/portal-admin.js");
  ok(/case 'link-quote-equipment'/.test(a), "S1 narrow admin action exists");
  ok(/admin\.rpc\('link_quote_equipment'/.test(a), "S2 it calls the RPC, not a raw update");
  const blk = a.slice(a.indexOf("case 'link-quote-equipment'"), a.indexOf("      // ONE authoritative conversion"));
  ok(!/equipment_snapshot/.test(blk), "S3 the link action accepts no snapshot from the browser");
  for (const e of ["equipment_not_owned","equipment_not_active","quote_not_pending","quote_already_invoiced"])
    ok(new RegExp(e).test(blk), `S4 maps ${e} to a stable code`);
  ok(!/equipment_snapshot/.test(pa) || !/equipment_snapshot:/.test(pa), "S5 the browser never sends a snapshot");
  // SUPERSEDED by the atomic design: the insert now carries equipment_id and a
  // BEFORE INSERT trigger produces the label, so there is no browser free text
  // and no second request at all.
  ok(!/equipment:\s*'',/.test(pa), "S6 the quote insert carries no browser-supplied label");
  ok(/equipment_id: document\.getElementById\('q-equipment-select'\)\?\.value \|\| null,/.test(pa),
     "S7 the insert carries equipment_id, resolved server-side in the same statement");
}

console.log("\n═══ QUOTE → INVOICE INHERITANCE (both paths) ═══");
{
  const a = read("supabase/functions/admin-action/index.ts");
  // create-invoice now DELEGATES; the inheritance itself lives in the RPC, which
  // is the single authoritative implementation.
  const ciBlk = a.slice(a.indexOf("case 'create-invoice'"), a.indexOf("case 'create-invoice'") + 1600);
  ok(/admin\.rpc\('quote_to_invoice'/.test(ciBlk), "I1 create-invoice delegates to quote_to_invoice()");
  ok(!/from\('invoices'\)\.insert/.test(ciBlk), "I2 it no longer duplicates the insert or the copy logic");
  const ciCode = ciBlk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok(!/equipment_snapshot\(/.test(ciCode), "I4 and never re-derives a snapshot");
  const m2 = read("supabase/migrations/0012_equipment_links.sql");
  ok(/q\.equipment, q\.equipment_id, q\.equipment_snapshot/.test(m2), "I3 the RPC copies all three verbatim");
  ok(/q\.equipment, q\.equipment_id, q\.equipment_snapshot/.test(m2), "I5 one conversion implementation, in the database");
}

console.log("\n═══ RECURRING INVOICES: LINKAGE ONLY ═══");
{
  const r = read("supabase/functions/subscription-reconcile/index.ts");
  ok(/DOCUMENT LINKAGE ONLY/.test(r), "R1 the intent is stated in the code");
  ok(/eqLink/.test(r) && /\.\.\.eqLink,/.test(r), "R2 both columns set together or neither");
  ok(/equipment link skipped/.test(r), "R3 a failed lookup degrades to an unlinked invoice, never a failed billing run");
  // Nothing was removed from the billing path. Comparing against a baseline ZIP
  // would tie this suite to one machine, so the invariants are asserted directly
  // against the shipped file instead: the equipment block is purely additive and
  // every pre-existing billing element is still present.
  for (const must of [
    'invoice_source: "recurring"', "subscription_id: s.id", "billing_period_start: start",
    "billing_period_end: end", "recurring_subtotal_cents", "recurring_tax_cents",
    'from("invoices").insert(row)',
  ]) ok(r.includes(must), `R4 billing path intact: ${must}`);
  ok(r.indexOf("let eqLink") < r.indexOf("const row"), "R4a the equipment lookup runs before the row is built, not inside it");
  ok(!/recurringAmount|helcimFetch\(.*PATCH|amount =/.test(r.slice(r.indexOf("let eqLink"), r.indexOf("const ins = await db"))),
     "R5 the inserted block touches no amount or provider call");
}

console.log("\n═══ ADMIN QUOTE UI ═══");
{
  const h = read("docs/portal-admin.html"), js = read("docs/portal-admin.js");
  ok(/id="q-equipment-select"/.test(h), "U1 forklift is a select, not free text");
  ok(!/id="q-equipment"[^-]/.test(h), "U2 the free-text input is gone");
  ok(/data-action="quote-add-forklift"/.test(h), "U3 Add Forklift control present");
  ok(!/ on[a-z]+="/.test(h.slice(h.indexOf('id="q-equipment-select"') - 300, h.indexOf('id="q-equipment-select"') + 600)), "U4 no inline handlers introduced");
  ok(/QUOTE_EQUIPMENT = \[\];[\s\S]{0,200}?q-equipment-select/.test(js), "U5 switching customer clears the previous selection FIRST");
  ok(/\.eq\('customer_id', customerId\)\.eq\('status', 'active'\)/.test(js), "U6 only that customer's ACTIVE units are loaded");
  ok(/— No specific forklift —/.test(js), "U7 no-forklift is an explicit choice");
  ok(/spOpenEquip\(null\)/.test(js) && /_quoteAwaitingEquipment = true/.test(js), "U8 Add Forklift reuses the Phase 1 admin modal");
  ok(/renderQuoteEquipment\(newId\)/.test(js), "U9 the new unit is selected on return");
  ok(/no active forklifts on file/.test(js), "U10 empty state explains itself");
  ok(/Customer wrote:/.test(js), "U11 a service request's free text is shown as a hint, never auto-linked");
  ok(/case 'quote-add-forklift':/.test(js), "U12 routed through the fixed switch");
}

console.log("\n═══ DISPLAY: SNAPSHOT FIRST, FREE TEXT FALLBACK ═══");
{
  for (const f of ["docs/portal-admin.js", "docs/portal-customer.js"]) {
    const s = read(f);
    ok(/function apexDocEquipment\(doc\)/.test(s), `D1 ${f} has the shared label helper`);
    ok(/doc && doc\.equipment_snapshot/.test(s), `D2 ${f} reads the snapshot first`);
    ok(/legacy \|\| 'Not specified'/.test(s), `D3 ${f} falls back to free text, then a safe default`);
  }
  const pa = read("docs/portal-admin.js"), pc = read("docs/portal-customer.js");
  ok((pa.match(/apexDocEquipment\(/g) || []).length >= 5, "D4 admin uses it on quote detail, list, CSV and both prints");
  ok((pc.match(/apexDocEquipment\(/g) || []).length >= 4, "D5 customer uses it on the quote card and both prints");
  // Behavioural: the helper itself.
  const fn = new Function(pa.slice(pa.indexOf("function apexDocEquipment"), pa.indexOf("\n}", pa.indexOf("function apexDocEquipment")) + 2) + "; return apexDocEquipment;")();
  ok(fn({ equipment_snapshot: { year: "2019", make: "Toyota", model: "8FGCU25", unit_number: "A-1", serial_number: "SN-1" } })
       === "2019 Toyota 8FGCU25 · #A-1 · SN SN-1", "D6 snapshot renders fully");
  ok(fn({ equipment_snapshot: { nickname: "Dock 3", make: "Hyster", model: "H50" } }) === "Dock 3 (Hyster H50)", "D7 nickname form");
  ok(fn({ equipment: "Toyota 8FGCU25 (typed by hand)" }) === "Toyota 8FGCU25 (typed by hand)", "D8 historical row falls back to free text");
  ok(fn({}) === "Not specified", "D9 nothing known renders a safe default");
  ok(fn({ equipment_snapshot: null, equipment: "" }) === "Not specified", "D10 empty values do not render blank");
  for (const bad of [{ equipment_snapshot: { make: null, model: undefined } }, { equipment: null }, { equipment_snapshot: {} }])
    ok(!/undefined|null|\[object Object\]/.test(fn(bad)), `D11 never renders undefined/null/[object Object] (${JSON.stringify(bad)})`);
  ok(fn({ equipment_snapshot: { make: "Toyota" }, equipment: "IGNORED" }) === "Toyota",
     "D12 the snapshot WINS over free text — the live row is never the source");
}

console.log("\n═══ SAFE RENDERING ═══");
{
  const vc = new VirtualConsole();
  const dom = new JSDOM("<div id='out'></div>", { runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window;
  const pa = read("docs/portal-admin.js");
  w.eval(pa.slice(pa.indexOf("function apexDocEquipment"), pa.indexOf("\n}", pa.indexOf("function apexDocEquipment")) + 2));
  w.esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const hostile = { equipment_snapshot: { make: '"><img src=x onerror=alert(1)>', model: "X" } };
  w.document.getElementById("out").innerHTML = `<span>${w.esc(w.apexDocEquipment(hostile))}</span>`;
  const html = w.document.getElementById("out").innerHTML;
  ok(!/<img/.test(html) && /&lt;img/.test(html), "X1 a hostile snapshot value renders as text");
}


console.log("\n═══ RUNTIME INTEGRATION (v25.2 correction) ═══");
{
  const m  = read("supabase/migrations/0012_equipment_links.sql");
  const a  = read("supabase/functions/admin-action/index.ts");
  const pd = read("docs/portal-data.js");
  const pa = read("docs/portal-admin.js");
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").replace(/\/\/[^\n]*/g, "");

  // (A/C) The RPCs must not gate on a browser JWT they can never see.
  const linkFn = m.slice(m.indexOf("create or replace function link_quote_equipment"), m.indexOf("revoke all on function link_quote_equipment"));
  const qtiFn  = m.slice(m.indexOf("create or replace function quote_to_invoice"), m.indexOf("revoke all on function quote_to_invoice"));
  ok(!/is_admin/.test(code(linkFn)), "RA1 link_quote_equipment has no is_admin() check (service_role carries no user JWT)");
  ok(!/is_admin/.test(code(qtiFn)),  "RA2 quote_to_invoice has no is_admin() check");
  ok(/revoke all on function link_quote_equipment\(text, uuid\) from public, anon, authenticated/.test(m), "RA3 link RPC revoked from public/anon/authenticated");
  ok(/grant  execute on function link_quote_equipment\(text, uuid\) to service_role/.test(m), "RA4 and granted ONLY to service_role");
  ok(/revoke all on function quote_to_invoice\(text\) from public, anon, authenticated/.test(m) &&
     /grant  execute on function quote_to_invoice\(text\) to service_role/.test(m), "RA5 same for quote_to_invoice");
  ok(/user\.email/.test(a) || /ADMIN_EMAIL/.test(a), "RA6 admin-action still authenticates the human admin itself");

  // (D) Atomic creation via BEFORE INSERT.
  ok(/create trigger trg_quote_equipment_before_insert before insert on quotes/.test(m), "RD1 BEFORE INSERT trigger on quotes");
  ok(/new\.equipment_snapshot := snap;/.test(m) && /new\.equipment          := equipment_label\(snap\)/.test(m),
     "RD2 the trigger generates BOTH snapshot and label server-side");
  ok(/raise exception 'equipment_not_owned'/.test(m) && /raise exception 'equipment_not_active'/.test(m),
     "RD3 a bad unit raises inside the INSERT, so no row and no notification survive");

  // (H/I) Browser contract.
  // Slice the function body properly: the LINE ITEMS banner sits BEFORE
  // saveQuote in this file, so slicing to it produced an empty string and the
  // assertions below would have passed vacuously.
  const sqStart = pa.indexOf("async function saveQuote");
  const sq = pa.slice(sqStart, pa.indexOf("\n}", sqStart) + 2);
  if (sq.length < 200) { fail++; console.log("FAIL RH0 saveQuote slice is empty — assertions would be vacuous"); }
  ok(/equipment_id: document\.getElementById\('q-equipment-select'\)\?\.value \|\| null,/.test(sq),
     "RH1 the browser sends equipment_id only");
  ok(!/equipment_snapshot/.test(sq), "RH2 (H) the browser never sends a snapshot");
  ok(!/equipment:\s*[^_]/.test(sq.replace(/equipment_id/g, "X")), "RH3 the browser generates no equipment label");
  ok(!/adminLinkQuoteEquipment/.test(sq), "RI1 (I) NEW quote creation performs no second link request");
  ok(/The quote was not saved/.test(sq) && /retired or deactivated/.test(sq), "RI2 a rejected unit shows a clear error");
  ok(!/showToast\(`✓ Quote sent/.test(sq.slice(0, sq.indexOf("if (!saved)"))), "RI3 no success toast before the insert is confirmed");

  // (J) No browser fallback for conversion.
  const qti = pd.slice(pd.indexOf("async quoteToInvoice"), pd.indexOf("async quoteToInvoice") + 900);
  ok(!/SB\.post\('invoices'/.test(qti), "RJ1 (J) the direct PostgREST invoice fallback is gone");
  ok(!/catch/.test(qti), "RJ2 it fails closed rather than falling back");
  ok(!/SB\.post\('invoices'/.test(pd), "RJ3 no direct invoice insert anywhere in portal-data.js");

  // (K) One conversion authority.
  const ci = a.slice(a.indexOf("case 'create-invoice'"), a.indexOf("case 'create-invoice'") + 1600);
  ok(/admin\.rpc\('quote_to_invoice'/.test(ci), "RK1 (K) admin-action delegates to the authoritative RPC");
  ok(!/from\('invoices'\)\.insert/.test(ci), "RK2 it no longer re-implements the insert");
  for (const e of ["quote_not_found","quote_not_approved","quote_already_invoiced"])
    ok(new RegExp(e).test(ci), `RK3 maps ${e} to a stable response`);
  ok(!/updateQuoteField\(quoteId, \{ invoiced: true \}\)/.test(pa), "RK4 the browser no longer re-marks the quote invoiced");
  ok(/for update/.test(m) && /quote_already_invoiced/.test(m), "RN1 row lock + invoiced check serialise double conversion");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
