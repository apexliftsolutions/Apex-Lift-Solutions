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
  // Phase 2.2 replaced the raising RPC with the idempotent quote_to_invoice_v2.
  ok(/admin\.rpc\('quote_to_invoice_v2'/.test(ciBlk), "I1 create-invoice delegates to the idempotent conversion RPC");
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
  // Bounded by the next case, not a fixed width: the error-mapping block grew.
  const ciS = a.indexOf("case 'create-invoice'");
  const ci = a.slice(ciS, a.indexOf("\n      case '", ciS + 40));
  ok(/admin\.rpc\('quote_to_invoice_v2'/.test(ci), "RK1 (K) admin-action delegates to the authoritative RPC");
  ok(!/from\('invoices'\)\.insert/.test(ci), "RK2 it no longer re-implements the insert");
  for (const e of ["quote_not_found","quote_not_approved"])
    ok(new RegExp(e).test(ci), `RK3 maps ${e} to a stable error response`);
  // already-invoiced is no longer an error at all: it returns 200 with the
  // existing invoice id, because the raise is what the browser swallowed.
  ok(/already_invoiced: true[\s\S]{0,140}invoice_id: res\.invoice_id/.test(ci),
     "RK3a an already-invoiced quote returns the EXISTING invoice, not an error");
  ok(!/updateQuoteField\(quoteId, \{ invoiced: true \}\)/.test(pa), "RK4 the browser no longer re-marks the quote invoiced");
  ok(/for update/.test(m) && /quote_already_invoiced/.test(m), "RN1 row lock + invoiced check serialise double conversion");
}


console.log("\n═══ INVOICE DISPLAY: ALL FOUR SURFACES ═══");
{
  const pa = read("docs/portal-admin.js"), pc = read("docs/portal-customer.js");
  // 1. admin list  2. admin detail  3. admin print  4. customer card  5. customer print
  ok(/data-action="invoice-view"/.test(pa), "V1 admin invoice list has a View control");
  ok(/async function viewInvoiceDetail\(id\)/.test(pa), "V2 admin invoice DETAIL view exists (there was none)");
  const det = pa.slice(pa.indexOf("async function viewInvoiceDetail"), pa.indexOf("async function printInvoicePDF"));
  ok(/Equipment: \$\{apexDocEquipment\(inv\)\}/.test(det), "V3 admin detail shows the frozen equipment");
  ok(/&#128668; \$\{esc\(apexDocEquipment\(i\)\)\}/.test(pa), "V4 admin list shows a compact equipment label");
  const aprint = pa.slice(pa.indexOf("async function printInvoicePDF"));
  ok(/<label>Equipment<\/label>\$\{esc\(apexDocEquipment\(inv\)\)\}/.test(aprint), "V5 admin PRINT/PDF shows it");
  const cprint = pc.slice(pc.indexOf("async function printInvoice"), pc.indexOf("async function printInvoice") + 2500);
  ok(/Equipment: \$\{esc\(apexDocEquipment\(i\)\)\}/.test(cprint), "V6 customer PRINT/PDF shows it");
  // Exactly ONE invoice Equipment row in the source: the shared .q-meta block,
  // which renders for every status. The paid-only grid must not repeat it.
  const invoiceEqRows = (pc.match(/Equipment<span>\$\{xss\(apexDocEquipment\(i\)\)\}/g) || []).length;
  ok(invoiceEqRows === 1, `V7 exactly one invoice Equipment row in source (${invoiceEqRows})`);
  const paidGrid = pc.slice(pc.indexOf("const body = i.status === 'paid'"), pc.indexOf("${workSummary}"));
  ok(!/apexDocEquipment/.test(paidGrid), "V7a the paid-only grid no longer repeats it");
  const sharedMeta = pc.slice(pc.indexOf('<div class="q-meta">', pc.indexOf("loadInvoices")), pc.indexOf("${body}"));
  ok(/apexDocEquipment\(i\)/.test(sharedMeta), "V7b the shared .q-meta block still carries it for every status");
  // Every surface reads the document, never the live equipment row.
  for (const f of [pa, pc]) ok(!/customer_equipment[\s\S]{0,120}invoice/i.test(f.slice(f.indexOf("apexDocEquipment"))),
    "V8 no surface joins the live customer_equipment row for document display");
}

console.log("\n═══ RENDERER BEHAVIOUR (real helper, real fixtures) ═══");
{
  const pa = read("docs/portal-admin.js");
  const src = pa.slice(pa.indexOf("function apexDocEquipment"), pa.indexOf("\n}", pa.indexOf("function apexDocEquipment")) + 2);
  const label = new Function(src + "; return apexDocEquipment;")();
  const FULL = { equipment_snapshot: { year: "2019", make: "Toyota", model: "8FGCU25", unit_number: "A-1", serial_number: "ABC" } };
  ok(label(FULL) === "2019 Toyota 8FGCU25 · #A-1 · SN ABC", "P1 full snapshot: year, make, model, unit, serial");
  for (const part of ["Toyota", "8FGCU25", "2019", "A-1", "ABC"]) ok(label(FULL).includes(part), `P2 output contains ${part}`);
  ok(label({ equipment_snapshot: { make: "Hyster", model: "H50" } }) === "Hyster H50", "P3 partial data: no empty separators");
  ok(label({ equipment_snapshot: { year: "2020", make: "Clark", model: "C25", unit_number: "B-2" } }) === "2020 Clark C25 · #B-2",
     "P4 no serial: that segment is omitted cleanly");
  ok(label({ equipment_snapshot: { nickname: "Dock 3", make: "Yale", model: "GLP" } }) === "Dock 3 (Yale GLP)", "P5 nickname form");
  ok(label({ equipment: "Toyota 8FGU25 (typed by hand)" }) === "Toyota 8FGU25 (typed by hand)", "P6 legacy free text fallback");
  ok(label({}) === "Not specified", "P7 no equipment at all");
  for (const bad of [{}, { equipment: null }, { equipment_snapshot: {} }, { equipment_snapshot: { make: null, model: undefined, year: "" } },
                     { equipment_snapshot: null, equipment: "  " }])
    ok(!/undefined|null|\[object Object\]|·\s*·|^\s*·|·\s*$/.test(label(bad)), `P8 no undefined/null/[object Object]/stray separator: ${JSON.stringify(bad)}`);
  // Snapshot WINS: the document never re-reads the live record.
  ok(label({ equipment_snapshot: { make: "Toyota", unit_number: "A-1" }, equipment: "LIVE VALUE" }) === "Toyota · #A-1",
     "P9 snapshot takes priority over the legacy text");
}

console.log("\n═══ SNAPSHOT IMMUTABILITY THROUGH THE RENDERER ═══");
{
  const pa = read("docs/portal-admin.js");
  const src = pa.slice(pa.indexOf("function apexDocEquipment"), pa.indexOf("\n}", pa.indexOf("function apexDocEquipment")) + 2);
  const label = new Function(src + "; return apexDocEquipment;")();
  // Quote made for A-1, converted to an invoice; the live unit is later renamed A-99.
  const snapshot = { year: "2019", make: "Toyota", model: "8FGCU25", unit_number: "A-1", serial_number: "ABC" };
  const quote   = { equipment_snapshot: snapshot, equipment: "2019 Toyota 8FGCU25 · #A-1 · SN ABC" };
  const invoice = { equipment_snapshot: snapshot, equipment: quote.equipment };   // inherited verbatim
  const liveNow = { unit_number: "A-99", nickname: "Renamed", make: "Toyota" };   // the live row today
  ok(label(quote) === label(invoice), "S1 quote and invoice render the SAME identity");
  ok(label(invoice).includes("A-1") && !label(invoice).includes("A-99"),
     "S2 the invoice still shows A-1 after the live unit became A-99");
  ok(!label(invoice).includes("Renamed"), "S3 and does not pick up the new nickname");
  ok(JSON.stringify(invoice.equipment_snapshot) === JSON.stringify(quote.equipment_snapshot), "S4 snapshots are identical objects");
}

console.log("\n═══ HOSTILE EQUIPMENT TEXT IS RENDERED AS TEXT ═══");
{
  const vc = new VirtualConsole();
  const dom = new JSDOM("<div id='out'></div>", { runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window;
  const pa = read("docs/portal-admin.js");
  w.eval(pa.slice(pa.indexOf("function apexDocEquipment"), pa.indexOf("\n}", pa.indexOf("function apexDocEquipment")) + 2));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  for (const payload of ["<script>alert(1)<\/script>", "<img src=x onerror=alert(1)>", '"><svg onload=alert(1)>']) {
    for (const doc of [{ equipment_snapshot: { make: payload, model: "X" } }, { equipment: payload }]) {
      w.document.getElementById("out").innerHTML = `<span>${esc(w.apexDocEquipment(doc))}</span>`;
      const html = w.document.getElementById("out").innerHTML;
      ok(!/<script|<img|<svg/i.test(html), `X1 ${payload.slice(0, 18)}… rendered as text`);
      ok(w.document.querySelectorAll("script,img,svg").length === 0, "X2 no element was created");
    }
  }
  ok(!/ on[a-z]+=/.test(read("docs/portal-admin.html")) && !/ on[a-z]+=/.test(read("docs/portal-customer.html")),
     "X3 no inline event handlers introduced");
}


console.log("\n═══ CUSTOMER INVOICE CARD RENDERS EQUIPMENT EXACTLY ONCE ═══");
{
  // Render the real template string for both statuses and COUNT the rows.
  const pc = read("docs/portal-customer.js");
  const start = pc.indexOf("wrap.innerHTML = '<div class=\"q-cards\">' + visible.map(i => {");
  const end = pc.indexOf("}).join('') + '</div>';", start);
  ok(start > -1 && end > start, "D0 invoice card template located (test is not vacuous)");
  const tpl = pc.slice(start, end);

  const vc = new VirtualConsole();
  const dom = new JSDOM("<div id='invoices-wrap'></div>", { runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window;
  w.eval(pc.slice(pc.indexOf("function apexDocEquipment"), pc.indexOf("\n}", pc.indexOf("function apexDocEquipment")) + 2));
  w.xss = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  w.bdate = (d) => d ? "1 Jan 2026" : "—";
  w.badgeHtml = (s2) => `<span>${s2}</span>`;
  w.lineItemsHtml = () => "";
  w.ApexPage = { moreButtonHtml: () => "" };
  // Stub the remaining helpers the card template calls. They render buttons,
  // not equipment, so a stub cannot mask the thing under test.
  w.invoiceActionHtml = () => "";
  w.correctionsByInvoice = {};

  const SNAP = { year: "2019", make: "Toyota", model: "8FGCU25", unit_number: "A-1", serial_number: "ABC" };
  const render = (inv) => {
    w.visible = [inv];
    w.eval(`const wrap = document.getElementById('invoices-wrap'); ${tpl}}).join('') + '</div>';`);
    return w.document.getElementById("invoices-wrap").innerHTML;
  };
  const countEq = (html) => (html.match(/>Equipment</g) || []).length;

  const paid   = render({ id: "INV-1", status: "paid", amount: "100.00", due: "2026-01-01", paid_at: "2026-01-02",
                          quote_id: "Q-1", items: [], equipment_snapshot: SNAP, equipment: "legacy text" });
  ok(countEq(paid) === 1, `D1 PAID invoice shows Equipment exactly once (${countEq(paid)})`);
  ok(paid.includes("2019 Toyota 8FGCU25") && paid.includes("A-1"), "D2 and it is the frozen snapshot identity");
  ok(!paid.includes("legacy text"), "D3 the snapshot beats the legacy free text");

  const unpaid = render({ id: "INV-2", status: "unpaid", amount: "100.00", due: "2026-02-01",
                          items: [], equipment_snapshot: SNAP });
  ok(countEq(unpaid) === 1, `D4 UNPAID invoice shows Equipment exactly once (${countEq(unpaid)})`);
  ok(unpaid.includes("2019 Toyota 8FGCU25"), "D5 and it is the same identity");

  const legacy = render({ id: "INV-3", status: "paid", amount: "50.00", due: "2026-01-01", paid_at: "2026-01-02",
                          items: [], equipment: "Toyota 8FGU25 (typed by hand)" });
  ok(countEq(legacy) === 1, `D6 historical invoice shows Equipment exactly once (${countEq(legacy)})`);
  ok(legacy.includes("typed by hand"), "D7 falling back to the legacy free text");

  const none = render({ id: "INV-4", status: "unpaid", amount: "10.00", due: "2026-01-01", items: [] });
  ok(countEq(none) === 0, `D8 an invoice with no equipment shows no Equipment row (${countEq(none)})`);

  // Hostile content still renders as text through the real template.
  const hostile = render({ id: "INV-5", status: "paid", amount: "10.00", due: "2026-01-01", paid_at: "2026-01-02",
                           items: [], equipment_snapshot: { make: "<img src=x onerror=alert(1)>", model: "X" } });
  ok(countEq(hostile) === 1, "D9 hostile invoice still shows Equipment once");
  ok(!/<img/i.test(hostile) && /&lt;img/.test(hostile), "D10 and the payload is escaped as text");
  ok(w.document.querySelectorAll("img,script,svg").length === 0, "D11 no element was created");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
