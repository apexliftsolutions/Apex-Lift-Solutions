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
  const ci = a.slice(a.indexOf("case 'create-invoice'"), a.indexOf("case 'create-invoice'") + 2400);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
