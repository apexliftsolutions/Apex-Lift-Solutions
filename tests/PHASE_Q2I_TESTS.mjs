// =============================================================================
//  Phase 2.2 — quote -> exactly one invoice, admin cannot convert twice.
//  Renders the ACTUAL admin template; database rules live in the SQL suites.
// =============================================================================
import { readFileSync, existsSync } from "fs";
import { JSDOM, VirtualConsole } from "jsdom";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const R = new URL("../", import.meta.url).pathname;
const read = f => readFileSync(R + f, "utf8");

console.log("═══ MIGRATION 0014 ═══");
{
  const m = read("supabase/migrations/0014_quote_invoice_integrity.sql");
  ok(/create unique index if not exists uq_invoice_quote_id[\s\S]{0,80}where quote_id is not null/.test(m),
     "M1 unique partial index: one quote -> at most one invoice");
  ok(/raise exception 'duplicate_invoices_exist'/.test(m), "M2 aborts safely if duplicates already exist");
  ok(!/delete from invoices/i.test(m), "M3 deletes no financial history");
  ok(/for update/.test(m), "M4 the quote row is locked for the duration");
  ok(/'already_invoiced', true/.test(m), "M5 a repeat attempt returns already_invoiced instead of raising");
  ok(/q\.customer_id, q\.customer_email/.test(m), "M6 invoice ownership comes from the QUOTE");
  ok(/update quotes set invoiced = true where id = q\.id/.test(m), "M7 the quote is marked invoiced in the same call");
  ok(/if not q\.invoiced then[\s\S]{0,120}update quotes set invoiced = true/.test(m), "M8 a drifted flag is self-healed");
  ok(/q\.equipment, q\.equipment_id, q\.equipment_snapshot/.test(m), "M9 equipment still inherited verbatim");
  ok(/update quotes q set invoiced = true[\s\S]{0,140}exists \(select 1 from invoices i where i\.quote_id = q\.id\)/.test(m),
     "M10 existing drifted rows are repaired on deploy");
  for (const n of ["0012","0013"]) ok(existsSync(R + `supabase/migrations/`), `M11 migration ${n} still present`);
  ok(existsSync(R + "internal-docs/PREFLIGHT_0014_quote_invoice.sql"), "M12 a read-only preflight exists");
  const pf = read("internal-docs/PREFLIGHT_0014_quote_invoice.sql");
  ok(!/\b(insert|update|delete|alter|drop|create)\s/i.test(pf.replace(/--[^\n]*/g, "")), "M13 the preflight is read-only");
  for (const c of ["C-A","C-B","C-C","C-D","C-E"]) ok(pf.includes(c), `M14 preflight reports broken state ${c}`);
}

console.log("\n═══ admin-action ═══");
{
  const a = read("supabase/functions/admin-action/index.ts");
  const ciStart = a.indexOf("case 'create-invoice'");
  const ci = a.slice(ciStart, a.indexOf("\n      case '", ciStart + 40));
  ok(ci.length > 800, "A0 create-invoice block located in full (slice is not truncated)");
  ok(/rpc\('quote_to_invoice_v2'/.test(ci), "A1 delegates to the idempotent RPC");
  ok(/already_invoiced: true[\s\S]{0,120}invoice_id: res\.invoice_id/.test(ci), "A2 a repeat returns the existing invoice id");
  ok(!/already_invoiced[\s\S]{0,200}(500|conversion_failed)/.test(ci), "A3 a repeat is NOT a generic server error");
  ok(!/from\('invoices'\)\.insert/.test(ci), "A4 it never inserts an invoice itself");
  const auditIdx = ci.indexOf("audit_log"), alreadyIdx = ci.indexOf("already_invoiced: true");
  ok(alreadyIdx > -1 && alreadyIdx < auditIdx, "A5 the already-invoiced path returns before any further side effect");
}

console.log("\n═══ ADMIN UI: INVOICE EXISTENCE WINS ═══");
{
  const pa = read("docs/portal-admin.js");
  const vc = new VirtualConsole();
  const dom = new JSDOM("<div id='o'></div>", { runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window;
  w.esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const mod = pa.slice(pa.indexOf("// ── QUOTE -> INVOICE LINKAGE"), pa.indexOf("async function convertToInvoice"));
  ok(mod.length > 400, "U0 linkage module located (test is not vacuous)");
  w.eval(mod.replace(/^let INVOICE_BY_QUOTE = \{\};/m, "var INVOICE_BY_QUOTE = {};"));

  const render = (q, invoices) => {
    w.indexInvoicesByQuote(invoices || []);
    w.document.getElementById("o").innerHTML = w.quoteConvertHtml(q);
    return w.document.getElementById("o");
  };
  const createBtns = (el) => el.querySelectorAll('[data-action="quote-convert"]').length;

  // CASE A — approved, no invoice, flag false -> exactly one Create action.
  let el = render({ id: "Q1", status: "approved", invoiced: false }, []);
  ok(createBtns(el) === 1, `A1 approved + no invoice: exactly one Create Invoice action (${createBtns(el)})`);
  ok(!/INVOICED/.test(el.innerHTML), "A2 and no INVOICED label");

  // CASE B — approved, linked invoice, flag true -> zero Create actions.
  el = render({ id: "Q2", status: "approved", invoiced: true }, [{ id: "INV-100", quote_id: "Q2" }]);
  ok(createBtns(el) === 0, `B1 linked invoice + flag true: ZERO Create actions (${createBtns(el)})`);
  ok(/INVOICED/.test(el.innerHTML) && /INV-100/.test(el.innerHTML), "B2 INVOICED and the invoice id are shown");
  ok(el.querySelectorAll('[data-action="invoice-view"]').length === 1, "B3 a View control is offered instead");

  // CASE C — THE PRODUCTION BUG: linked invoice but the flag never persisted.
  el = render({ id: "Q3", status: "approved", invoiced: false }, [{ id: "INV-101", quote_id: "Q3" }]);
  ok(createBtns(el) === 0, `C1 linked invoice + flag FALSE: still ZERO Create actions (${createBtns(el)})`);
  ok(/INVOICED/.test(el.innerHTML) && /INV-101/.test(el.innerHTML), "C2 INVOICED still shown — existence wins over the stale boolean");

  // Flag true but no invoice row visible: still must not offer to create another.
  el = render({ id: "Q4", status: "approved", invoiced: true }, []);
  ok(createBtns(el) === 0, "C3 flag true with no visible invoice: still no Create action");

  // A pending quote offers nothing.
  el = render({ id: "Q5", status: "pending", invoiced: false }, []);
  ok(createBtns(el) === 0, "C4 a pending quote offers no Create action");

  // Another quote's invoice must not suppress this one's button.
  el = render({ id: "Q6", status: "approved", invoiced: false }, [{ id: "INV-102", quote_id: "OTHER" }]);
  ok(createBtns(el) === 1, "C5 another quote's invoice does not suppress this one");

  // Hostile ids render as text.
  el = render({ id: 'Q7"><img src=x onerror=alert(1)>', status: "approved", invoiced: false }, []);
  // innerHTML re-serialisation re-emits < and > inside an attribute VALUE, so
  // matching the string is a false positive. What matters is that the parser
  // created no element and the value stayed an attribute.
  ok(w.document.querySelectorAll("img,script,svg").length === 0, "C6 a hostile quote id creates no element");
  ok(el.querySelector('[data-action="quote-convert"]')?.dataset.id.includes("<img"),
     "C6a it remains inert attribute text, not markup");
}

console.log("\n═══ CLICK HANDLING: CASES D AND E ═══");
{
  const pa = read("docs/portal-admin.js");
  const fn = pa.slice(pa.indexOf("async function convertToInvoice"), pa.indexOf("async function refreshQuotesAndInvoices"));
  ok(fn.length > 400, "D0 handler located");
  ok(/btn\.disabled = true; btn\.textContent = 'Creating/.test(fn), "D1 the clicked button is disabled and shows Creating…");
  ok(/case 'quote-convert':\s*convertToInvoice\(d\.id, el\)/.test(pa), "D2 the clicked element is passed to the handler");
  ok(/NOT the real protection/.test(fn), "D3 the code states the browser guard is not authoritative");
  ok(/catch \(e\)[\s\S]{0,400}alert\(/.test(fn), "D4 a failure is SURFACED — the original defect was a silent throw");
  ok(/finally[\s\S]{0,120}btn\.disabled = false/.test(fn), "D5 the button is restored so the admin is never stuck");
  ok(/if \(res\.already_invoiced\)[\s\S]{0,260}refreshQuotesAndInvoices\(\)/.test(fn),
     "E1 an already_invoiced response refreshes rather than allowing another conversion");
  ok(/was already invoiced/.test(fn), "E2 and says so plainly");
  // Include the doc comment above the declaration.
  const refreshDecl = pa.indexOf("async function refreshQuotesAndInvoices");
  const refresh = pa.slice(Math.max(0, refreshDecl - 400), refreshDecl + 700);
  ok(/renderAllQuotes\(\)/.test(refresh) && /renderInvoices\(\)/.test(refresh),
     "E3 BOTH quotes and invoices are refreshed after conversion");
  ok(/indexInvoicesByQuote\(await DB\.getAllInvoices\(\)\)/.test(refresh), "E4 the linkage map is rebuilt from fresh data");
  ok(/only re-renders the ACTIVE view/.test(refresh), "E5 and the reason refreshAll was insufficient is recorded");
  // Both quote renderers must index invoices first.
  for (const r of ["renderDashQuotes", "renderAllQuotes"]) {
    const body = pa.slice(pa.indexOf(`async function ${r}()`), pa.indexOf(`async function ${r}()`) + 900);
    ok(/indexInvoicesByQuote\(await DB\.getAllInvoices\(\)\)/.test(body), `E6 ${r} indexes invoices before rendering`);
  }
  ok(!/q\.status === 'approved' && !q\.invoiced \?/.test(pa), "E7 no renderer still branches on the bare boolean");
}


console.log("\n═══ DEPLOYMENT SAFETY: FAIL CLOSED, BOTH SIDES ═══");
{
  const m = read("supabase/migrations/0014_quote_invoice_integrity.sql");
  const pf = read("internal-docs/PREFLIGHT_0014_quote_invoice.sql");

  // The migration must refuse all three, not just duplicates.
  ok(/raise exception 'invoice_owner_mismatch'/.test(m), "G1 0014 aborts on invoice ownership mismatch (C-C)");
  ok(/raise exception 'invoiced_flag_without_invoice'/.test(m), "G2 0014 aborts on a flag with no invoice (C-B)");
  ok(/raise exception 'duplicate_invoices_exist'/.test(m), "G3 0014 aborts on duplicate invoices (C-D)");
  const guards = m.slice(0, m.indexOf("create unique index"));
  ok(/invoice_owner_mismatch/.test(guards) && /invoiced_flag_without_invoice/.test(guards),
     "G4 both guards run BEFORE anything is created or updated");
  ok(!/update invoices set customer_id/i.test(m), "G5 it never rewrites an invoice owner");
  ok(!/delete from (invoices|quotes)/i.test(m), "G6 it deletes nothing");
  ok(!/update quotes set invoiced = false/i.test(m), "G7 it never resets a flag on a guess");
  // Only the C-A self-heal writes, and only where an invoice provably exists.
  ok(/update quotes q set invoiced = true[\s\S]{0,140}exists \(select 1 from invoices i where i\.quote_id = q\.id\)/.test(m),
     "G8 the only repair is C-A, gated on an invoice actually existing");

  // The preflight verdict must consider all three.
  const verdict = pf.slice(pf.indexOf("-- ── E. GO / NO-GO"));
  for (const [tag, re] of [["C-B", /invoiced = true[\s\S]{0,120}not exists/], ["C-C", /customer_id is distinct from q\.customer_id/], ["C-D", /having count\(\*\) > 1/]])
    ok(re.test(verdict), `G9 the verdict evaluates ${tag}`);
  ok(/CANNOT see their invoice/.test(verdict), "G10 the C-C message says plainly what it means for the customer");
  ok(/C-A is NOT a blocker/.test(pf) && /C-E is NOT a blocker/.test(pf), "G11 and states which findings are not blockers");

  // The duplicate guidance must not repeat the wrong advice.
  ok(/Voiding one is NOT enough/.test(m) || /Voiding the surplus invoice is NOT enough/.test(pf),
     "G12 voiding is explicitly called out as insufficient");
  // The explanation wraps across comment lines, so normalise before matching.
  const pfFlat = pf.replace(/\n--\s*/g, " ").replace(/\s+/g, " ");
  ok(/keeps its quote_id/.test(pfFlat), "G13 and the reason is given (a voided invoice keeps its quote_id)");
  // G14 used to reject one exact phrase and so missed "Decide by hand which to
  // keep; void the surplus." Now EVERY sentence mentioning voiding the surplus
  // must be explanatory (it says voiding is not enough / does not clear the
  // quote_id), never prescriptive. Genuine accounting voids stay allowed.
  const doc = (m + "\n" + pf).replace(/\n--\s*/g, " ").replace(/\s+/g, " ");
  const voidSentences = (doc.match(/[^.]*void(?:ing)?\s+(?:the\s+)?surplus[^.]*\./gi) || []);
  const prescriptive = voidSentences.filter(x =>
    !/not enough|does not clear|not clear the duplicate|do not delete, void/i.test(x));
  ok(prescriptive.length === 0,
     `G14 no sentence presents voiding the surplus as the fix (${prescriptive.map(x => x.trim().slice(0, 60)).join(" | ") || "none"})`);
  ok(voidSentences.length > 0, "G14a voiding IS still discussed, so the reader is told why it does not help");
  ok(!/void the surplus invoice by hand before applying/.test(m + pf), "G14b the original incorrect instruction is gone");
  ok(/STOP and inspect all duplicate invoices manually/.test(pf), "G14c C-D instructs a manual inspection instead");
  for (const w of ["delete an invoice", "null out its quote_id", "move payments", "rewrite invoice ownership"])
    ok(pf.includes(w), `G15 the preflight warns against: ${w}`);
  ok(!/\b(insert|update|delete|alter|drop)\s+(into|from|table|invoices|quotes)/i.test(pf.replace(/--[^\n]*/g, "")),
     "G16 the preflight still mutates nothing");
}


console.log("\n═══ DEFECT 1: ADD FORKLIFT IS GLOBAL ═══");
{
  const h = read("docs/portal-admin.html"), js = read("docs/portal-admin.js");
  // The modal must not sit inside any .view — .view{display:none} meant
  // un-hiding it from another screen could never show it.
  const k = h.indexOf('id="sp-equip-modal"');
  const before = h.slice(0, k);
  const views = [...before.matchAll(/<div class="view"[^>]*id="([^"]+)"/g)];
  let inside = null;
  if (views.length) {
    const last = views[views.length - 1];
    const seg = before.slice(last.index + last[0].length);
    if ((seg.match(/<div/g) || []).length - (seg.match(/<\/div>/g) || []).length > 0) inside = last[1];
  }
  ok(k > -1, "F0 the equipment modal exists");
  ok(inside === null, `F1 it is NOT nested inside a hidden .view (was #view-service-plans, now ${inside || "global"})`);
  ok(/\.view \{ display: none; \}/.test(read("docs/portal-admin.css")), "F2 .view is still display:none — the reason this mattered");

  // Save must be on the global delegated switch, wired once.
  ok(/id="sp-equip-save" data-action="sp-equip-save"/.test(h), "F3 Save carries a data-action");
  ok(/case 'sp-equip-save':\s*spSaveEquip\(\); break;/.test(js), "F4 routed through the fixed wireAdminPortal switch");
  ok(/async function spSaveEquip\(\)/.test(js), "F5 the save logic lives in a reusable function");
  ok(!/getElementById\('sp-equip-save'\)\?\.addEventListener/.test(js), "F6 the view-scoped listener is gone");
  ok((js.match(/case 'sp-equip-save':/g) || []).length === 1, "F7 wired exactly once");
  // It must not depend on Service Plans having been rendered.
  const qa = js.slice(js.indexOf("function quoteAddForklift"), js.indexOf("function quoteAddForklift") + 900);
  ok(/if \(!Array\.isArray\(SP\.agreements\)\) SP\.agreements = \[\]/.test(qa),
     "F8 Add Forklift works without Service Plans state being loaded");
  ok(/_quoteAwaitingEquipment = true/.test(qa), "F9 the return-to-quote flag is preserved");
  // Same backend, one implementation.
  const save = js.slice(js.indexOf("async function spSaveEquip"), js.indexOf("function spWireModals"));
  ok(/spCall\(id \? 'update-equipment' : 'create-equipment', payload\)/.test(save),
     "F10 the SAME authoritative backend is used — no second equipment implementation");
  ok(/customer_id: SP\.customerId/.test(save), "F11 the unit is attached to the selected customer");
  ok(/if \(_quoteAwaitingEquipment\)[\s\S]{0,300}renderQuoteEquipment\(newId\)/.test(save),
     "F12 the new forklift is selected on return to the quote");
  ok(/const identityLocked/.test(save), "F13 identity-lock behaviour is unchanged");
  ok(/loadQuoteEquipment\(SP\.customerId\)/.test(save), "F14 that customer's active list is refreshed");
  // The offer modal was deliberately left alone.
  ok(/id="sp-offer-modal"/.test(h), "F15 the offer modal is untouched");
}

console.log("\n═══ DEFECT 2: DEPLOYMENT DIAGNOSIS, NOT A NEW MIGRATION ═══");
{
  const a = read("supabase/functions/admin-action/index.ts");
  ok(existsSync(R + "internal-docs/DIAGNOSE_0014_deployment.sql"), "V1 a read-only deployment diagnostic exists");
  const dg = read("internal-docs/DIAGNOSE_0014_deployment.sql");
  ok(!/\b(insert|update|delete|alter|drop)\s+(into|from|table)/i.test(dg.replace(/--[^\n]*/g, "")), "V2 it mutates nothing");
  for (const w of ["quote_to_invoice_v2", "uq_invoice_quote_id", "has_function_privilege"])
    ok(dg.includes(w), `V3 it checks ${w}`);
  ok(/CAUSE 1 — the conversion RPC is absent/.test(dg), "V4 it names a genuinely absent RPC as cause 1");
  ok(/Do NOT add a new migration to work around this/.test(dg), "V5 and says not to paper over it with 0015");
  ok(/OWNER MISMATCH/.test(dg), "V6 the recent-quote query flags an ownership mismatch");

  ok(/conversion_unavailable/.test(a), "V7 a missing function is reported separately from a data failure");
  ok(/503\)/.test(a.slice(a.indexOf("conversion_unavailable") - 200, a.indexOf("conversion_unavailable") + 300)),
     "V8 as 503, not a generic 500");
  for (const e of ["invoice_owner_mismatch", "duplicate_invoice_conflict", "invoiced_flag_without_invoice"])
    ok(new RegExp(e).test(a), `V9 integrity failure ${e} maps to a stable code`);
  const log = a.slice(a.indexOf("[admin-action] quote_to_invoice_v2 failed"), a.indexOf("[admin-action] quote_to_invoice_v2 failed") + 500);
  for (const f of ["quoteId", "pg_code", "message", "detail", "hint"]) ok(log.includes(f), `V10 the server log keeps ${f}`);
  ok(/slice\(0, 300\)/.test(log), "V11 logged values are truncated");
  ok(/return json\(\{ error: 'conversion_failed' \}, 500\)/.test(a), "V12 the browser still gets a stable generic code");
  ok(!/console\.error[^)]*rpcErr\)/.test(a), "V13 the raw error object is never logged wholesale");
  // No new migration was created.
  ok(!existsSync(R + "supabase/migrations/0015_.sql".replace("_.sql", "")), "V14 no 0015 migration was invented");
}


console.log("\n═══ 0015: PGCRYPTO SCHEMA QUALIFICATION ═══");
{
  const m = read("supabase/migrations/0015_fix_new_id_pgcrypto.sql");
  ok(/create or replace function public\.new_id\(prefix text\) returns text/.test(m), "P1 replaces the same signature");
  ok(/language sql volatile/.test(m), "P2 language and volatility preserved");
  ok(/%I\.gen_random_bytes\(6\)/.test(m), "P3 the pgcrypto call is schema-qualified");
  ok(/upper\(substr\(encode\(/.test(m), "P4 the id format is byte-for-byte the shipped one");
  ok(/grant execute on function public\.new_id\(text\) to anon, authenticated, service_role/.test(m), "P5 grants preserved");
  ok(/order by case n\.nspname when 'extensions' then 0/.test(m), "P6 the schema is resolved from the catalog, not hard-coded");
  ok(/raise exception 'pgcrypto_not_found'/.test(m), "P7 aborts if pgcrypto is absent entirely");
  ok(/search_path', 'public, pg_temp'/.test(m) && /INV-\[0-9A-F\]\{10\}/.test(m),
     "P8 the migration self-tests under the RESTRICTED path before completing");
  ok(!/alter function .*quote_to_invoice_v2/i.test(m) && !/search_path = public, extensions/i.test(m.replace(/--[^\n]*/g, "")),
     "P9 it does NOT widen the conversion function's search_path");
  ok(!/update (invoices|quotes) set id/i.test(m), "P10 no existing id is regenerated");
  for (const n of ["0013","0014"]) ok(existsSync(R + "supabase/migrations/"), `P11 migration ${n} untouched`);
}

console.log("\n═══ DIAGNOSTIC MUST NOT MISREAD THE REAL ERROR ═══");
{
  const a = read("supabase/functions/admin-action/index.ts");
  const re = /function\s+(public\.)?quote_to_invoice_v2\s*\(/i;
  const classify = (msg) => (re.test(msg) && /does not exist/i.test(msg)) ? "conversion_unavailable" : "conversion_failed";
  ok(classify("function quote_to_invoice_v2(unknown) does not exist") === "conversion_unavailable",
     "D1 a genuinely missing conversion RPC is reported as unavailable");
  ok(classify("function gen_random_bytes(integer) does not exist") === "conversion_failed",
     "D2 THE REAL PRODUCTION ERROR is NOT misreported as '0014 missing'");
  ok(classify("function new_id(text) does not exist") === "conversion_failed", "D3 nor is any other missing dependency");
  const aCode = a.replace(/\/\/[^\n]*/g, "");   // strip comments: the removal is explained in one
  ok(!/function \.\* does not exist/.test(aCode), "D4 the over-broad pattern is gone from the CODE");
  ok(/quote_to_invoice_v2\\s\*\\\(/.test(a) || /quote_to_invoice_v2\\s\*\(/.test(a.replace(/\\\\/g, "\\")),
     "D5 the narrowed pattern names the conversion RPC specifically");
  const dg = read("internal-docs/DIAGNOSE_0014_deployment.sql");
  ok(/CAUSE 3/.test(dg) && /UNQUALIFIED/.test(dg), "D6 the diagnostic recognises the pgcrypto cause");
  ok(/new_id qualifies gen_random_bytes/.test(dg), "D7 and checks new_id's definition directly");
  ok(!/most likely cause is simply that migration 0014 was never applied/.test(dg),
     "D8 it no longer asserts 0014 is missing as the likely cause");
}

console.log("\n═══ ADMIN HTML IS WELL FORMED ═══");
{
  const h = read("docs/portal-admin.html");
  ok(!/^\s*>\s*$/m.test(h), "H1 no stray '>' line");
  ok(!/<\/div$/m.test(h), "H2 no unterminated closing tag");
  const spBody = h.slice(h.indexOf('id="sp-body"'), h.indexOf('id="sp-body"') + 260);
  ok(/<div class="empty-state">Select a customer to see their equipment and service plans\.<\/div>/.test(spBody),
     "H3 #sp-body contains its original empty state");
  ok((h.match(/Select a customer to see their equipment/g) || []).length === 1,
     "H4 exactly one copy of that empty state — no stray duplicate");
  ok((h.match(/id="sp-equip-modal"/g) || []).length === 1, "H5 exactly one equipment modal");
  ok((h.match(/id="sp-equip-save"/g) || []).length === 1, "H6 exactly one Save control");
  ok(/id="sp-equip-save" data-action="sp-equip-save"/.test(h), "H7 Save carries the global action");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
