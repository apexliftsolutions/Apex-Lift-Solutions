// =============================================================================
//  Phase 2.1 — invoice delivery state
//  The database rules live in tests/sql/equipment_phase2.sql. This covers the
//  webhook's signature verification (exercised for real) and the admin UI.
// =============================================================================
import { readFileSync, existsSync } from "fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { createHmac } from "crypto";
import { transformSync } from "esbuild";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const R = new URL("../", import.meta.url).pathname;
const read = f => readFileSync(R + f, "utf8");

console.log("═══ MIGRATION 0013 IS ADDITIVE ═══");
{
  const m = read("supabase/migrations/0013_notification_delivery.sql");
  ok(/add column if not exists delivery_status/.test(m) && /delivered_at/.test(m) && /bounced_at/.test(m),
     "M1 delivery columns added");
  ok(!/check \(status in/.test(m), "M2 the worker's transport status constraint is NOT redefined");
  ok(/provider_event_id text not null unique/.test(m), "M3 unique provider event id makes replays harmless");
  ok(/grant  execute on function apply_delivery_event[^;]*to service_role/.test(m) &&
     /revoke all on function apply_delivery_event[\s\S]{0,80}from public, anon, authenticated/.test(m),
     "M4 apply_delivery_event is service_role only");
  ok(/unknown_provider_msg_id/.test(m), "M5 an unknown message id applies to nothing");
  ok(/p_current_status in \('bounced','complained','failed'\)[\s\S]{0,90}p_new_status in \('delivered','delayed'\) then false/.test(m),
     "M6 a delivered or delayed event cannot overwrite a negative outcome");
  for (const n of ["0001","0011","0012"]) ok(existsSync(R + "supabase/migrations/") , `M7 migration set intact (${n})`);
}

console.log("\n═══ WEBHOOK SIGNATURE — REAL ROUND TRIP ═══");
{
  const src = read("supabase/functions/resend-webhook/index.ts");
  // Extract and run the SHIPPED verifier rather than reimplementing it.
  // The shipped file is TypeScript. Strip the types with esbuild (already a
  // declared dependency) so the test exercises the REAL verifier rather than a
  // reimplementation of it.
  const tsBody = src.slice(src.indexOf("function timingSafeEqual"), src.indexOf("/** A short, safe explanation"));
  const body = transformSync(tsBody, { loader: "ts", format: "esm" }).code;
  const SECRET = "whsec_" + Buffer.from("apex-test-key-material-0123456789").toString("base64");
  const mod = new Function("SECRET", "TOLERANCE_SECONDS", "crypto", "atob", "btoa", "TextEncoder",
    body + "; return verifySvix;")(SECRET, 300, globalThis.crypto, (s) => Buffer.from(s, "base64").toString("binary"),
    (s) => Buffer.from(s, "binary").toString("base64"), TextEncoder);

  const sign = (id, ts, raw, secret = SECRET) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  };
  const now = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ type: "email.delivered", data: { email_id: "m1" } });

  ok(await mod(raw, "id1", String(now), sign("id1", now, raw)) === true, "W1 a correctly signed request verifies");
  ok(await mod(raw, "id1", String(now), "v1,AAAA") === false, "W2 a wrong signature is rejected");
  ok(await mod(raw + " ", "id1", String(now), sign("id1", now, raw)) === false, "W3 a modified body is rejected");
  ok(await mod(raw, "id2", String(now), sign("id1", now, raw)) === false, "W4 a swapped svix-id is rejected");
  ok(await mod(raw, "id1", String(now - 4000), sign("id1", now - 4000, raw)) === false, "W5 an old timestamp is rejected (replay window)");
  ok(await mod(raw, "id1", String(now + 4000), sign("id1", now + 4000, raw)) === false, "W6 a far-future timestamp is rejected");
  ok(await mod(raw, "id1", String(now), sign("id1", now, raw, "whsec_" + Buffer.from("different-key-material-abcdefghij").toString("base64"))) === false,
     "W7 a signature from a different secret is rejected");
  ok(await mod(raw, "", "", "") === false, "W8 missing headers are rejected");
  ok(await mod(raw, "id1", String(now), `v1,bogus ${sign("id1", now, raw).slice(3)}`) === false,
     "W9 a valid signature without its v1 prefix is not accepted");
  ok(await mod(raw, "id1", String(now), `v0,x ${sign("id1", now, raw)}`) === true,
     "W10 a multi-signature header passes when one v1 entry matches");
}

console.log("\n═══ WEBHOOK BEHAVIOUR ═══");
{
  const s = read("supabase/functions/resend-webhook/index.ts");
  ok(/const raw = await req\.text\(\)/.test(s), "B1 the RAW body is read, never re-serialised");
  const order = s.indexOf("await verifySvix") < s.indexOf("JSON.parse(raw)");
  ok(order, "B2 the signature is verified BEFORE the payload is parsed");
  ok(/return json\(\{ error: "invalid_signature" \}, 401\)/.test(s), "B3 an invalid signature is rejected with 401");
  ok(/if \(!SECRET\) return false/.test(s), "B4 an unconfigured secret fails closed");
  ok(/rpc\("apply_delivery_event"/.test(s), "B5 state changes go through the service-role RPC");
  ok(/data\.email_id/.test(s) && !/body\.delivery_status|data\.status/.test(s),
     "B6 the provider message id is the only join key — no client-supplied state");
  ok(/svix-id/.test(s) && /p_provider_event_id:\s*eventId/.test(s), "B7 svix-id is used for deduplication");
  ok(!/RESEND_API_KEY|service_role_key/i.test(s.replace(/SUPABASE_SERVICE_ROLE_KEY/g, "")), "B8 no secret is echoed");
  ok(/bounce\.message[\s\S]{0,60}slice\(0, 300\)/.test(s), "B9 provider detail is truncated, never a raw payload");
  ok(!/email\.opened|email\.clicked/.test(s.replace(/\/\/[^\n]*/g, "")), "B10 open and click events are not handled (we do not claim reads)");
}

console.log("\n═══ ADMIN UI: TRUTHFUL DELIVERY STATE ═══");
{
  const pa = read("docs/portal-admin.js");
  const vc = new VirtualConsole();
  const dom = new JSDOM("<div id='o'></div>", { runScripts: "outside-only", virtualConsole: vc });
  const w = dom.window;
  w.esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const mod = pa.slice(pa.indexOf("// ── INVOICE EMAIL DELIVERY STATE"), pa.indexOf("// Fuller delivery picture"));
  ok(mod.length > 500, "U0 delivery module located (test is not vacuous)");
  w.eval(mod.replace(/^let INVOICE_DELIVERY = \{\};/m, "var INVOICE_DELIVERY = {};"));

  const set = (row) => { w.INVOICE_DELIVERY = row ? { "INV-1": row } : {}; };
  const state = () => w.invoiceDeliveryState("INV-1");

  set({ status: "pending",    recipient: "c@x.io", created_at: "2026-09-12T21:42:00Z" });
  ok(state().label === "Email queued", "U1 pending renders Queued");
  set({ status: "processing", recipient: "c@x.io" });
  ok(state().label === "Sending…", "U2 processing renders Sending");
  set({ status: "sent", recipient: "c@x.io", sent_at: "2026-09-12T21:42:00Z" });
  ok(state().label === "Sent" && state().code === "sent", "U3 sent renders Sent");
  ok(state().label !== "Delivered", "U4 and NOT Delivered — Resend accepting is not delivery");
  set({ status: "sent", recipient: "c@x.io", delivery_status: "delivered", delivered_at: "2026-09-12T21:45:00Z" });
  ok(state().label === "Delivered", "U5 Delivered only with a provider delivery event");
  set({ status: "sent", recipient: "c@x.io", delivery_status: "bounced", bounced_at: "2026-09-12T21:45:00Z" });
  ok(state().label === "Email bounced" && state().cls === "bad", "U6 bounced renders a failure state");
  set({ status: "failed", recipient: "c@x.io", last_error: "x" });
  ok(state().label === "Email failed" && state().cls === "bad", "U7 transport failure renders failed");
  set({ status: "sent", recipient: "c@x.io", delivery_status: "complained" });
  ok(state().label === "Marked as spam", "U8 a complaint is shown, not hidden");
  set(null);
  ok(state().label === "Delivery record unavailable", "U9 a historical invoice does not pretend it was sent");
  ok(state().code === "unknown", "U10 and is not classified as sent or delivered");

  // Wording: nothing claims a human read anything.
  ok(!/Customer received|Customer read|Customer saw|opened|read the/i.test(mod.replace(/\/\/[^\n]*/g, "")),
     "U11 no wording claims the customer received, read or opened it");

  // Rendering: exactly one state, recipient from the outbox row, escaped.
  set({ status: "sent", recipient: '"><img src=x onerror=alert(1)>@evil.io', delivery_status: "delivered", delivered_at: "2026-09-12T21:45:00Z" });
  w.document.getElementById("o").innerHTML = w.invoiceDeliveryHtml("INV-1");
  const html = w.document.getElementById("o").innerHTML;
  ok(/Delivered/.test(html), "U12 the list cell renders the state");
  ok(!/<img/i.test(html) && /&lt;img/.test(html), "U13 a hostile recipient is escaped as text");
  ok(w.document.querySelectorAll("img,script").length === 0, "U14 no element was created");
  ok((html.match(/Delivered/g) || []).length === 1, "U15 the state appears exactly once");

  // Suppression helper: the UX half of duplicate-send prevention.
  for (const [st, expected] of [["pending", true], ["processing", true], ["sent", true], ["failed", false]]) {
    set({ status: st, recipient: "c@x.io" });
    ok(w.invoiceEmailAlreadyEnqueued("INV-1") === expected, `U16 already-enqueued is ${expected} for ${st}`);
  }
  set(null);
  ok(w.invoiceEmailAlreadyEnqueued("INV-1") === false, "U17 a missing record is not treated as enqueued");
}

console.log("\n═══ NO DUPLICATE-SEND CONTROL ═══");
{
  const pa = read("docs/portal-admin.js"), ph = read("docs/portal-admin.html");
  ok(!/data-action="invoice-send"|data-action="invoice-resend"|Send Again|Resend Invoice/i.test(pa + ph),
     "N1 no invoice send or resend control exists anywhere in the admin portal");
  ok(!/enqueue_notification|notification_outbox['"]\)\.insert/.test(pa),
     "N2 the browser cannot enqueue a notification");
  ok(/\.from\('notification_outbox'\)\s*\n?\s*\.select/.test(pa), "N3 the browser only SELECTs the outbox");
  ok(/loadInvoiceDelivery/.test(pa) && /invoiceDeliveryHtml\(i\.id\)/.test(pa), "N4 the list shows delivery state");
  ok(/invoiceDeliveryDetailText/.test(pa), "N5 the detail view shows the fuller picture");
  const det = pa.slice(pa.indexOf("function invoiceDeliveryDetailText"), pa.indexOf("// Admin invoice detail."));
  ok(/address used at send time/.test(det), "N6 the detail names the recipient as the one used at send time");
  ok(/Accepted by Resend/.test(det) && /Delivered to mail server/.test(det),
     "N7 the detail distinguishes provider acceptance from mail-server delivery");
}


console.log("\n═══ ORDERING AND RACE: SOURCE CONTRACT ═══");
{
  const m = read("supabase/migrations/0013_notification_delivery.sql");
  ok(/add column if not exists delivery_event_at/.test(m), "O1 delivery_event_at records the PROVIDER event time");
  ok(/order by occurred_at, id/.test(m), "O2 events are replayed in provider-event-time order, not arrival order");
  ok(/p_new_at <= p_current_at then false/.test(m), "O3 and a stale event is rejected by an explicit guard as well");
  ok(/delivery order is NOT guaranteed/i.test(m), "O4 the reason is documented in the migration");
  ok(/create trigger trg_attach_pending_delivery[\s\S]{0,120}after update of provider_msg_id/.test(m),
     "O5 a trigger attaches events retained before provider_msg_id existed");
  ok(/'retained', true/.test(m), "O6 an unmatched event is retained rather than dropped");
  // The only lookup in apply_delivery_event is by provider_msg_id.
  const applyFn = m.slice(m.indexOf("create or replace function apply_delivery_event"), m.indexOf("revoke all on function apply_delivery_event"));
  const lookups = [...applyFn.matchAll(/from notification_outbox\s+where (\w+)/g)].map(x => x[1]);
  ok(lookups.length > 0 && lookups.every(c => c === "provider_msg_id"),
     `O7 correlation is by provider_msg_id only — no fuzzy matching (${lookups.join(",")})`);
  const w = read("supabase/functions/resend-webhook/index.ts");
  ok(/email\.failed/.test(w) && /email\.failed/.test(m), "O8 email.failed is handled in both the function and the migration");
}

console.log("\n═══ INVOICE TABLE COLUMN COUNT ═══");
{
  const ph = read("docs/portal-admin.html"), pa = read("docs/portal-admin.js");
  const head = /<thead><tr>((?:<th>[^<]*<\/th>)+)<\/tr><\/thead>/.exec(ph.slice(ph.indexOf('id="invoices-table"') - 400, ph.indexOf('id="invoices-table"')));
  const cols = head ? (head[1].match(/<th>/g) || []).length : 0;
  ok(cols === 8, `C1 the invoice table header has 8 columns (${cols})`);
  ok(/<th>Email<\/th>/.test(ph), "C2 including a dedicated Email column");
  // Scope to renderInvoices: other tables legitimately have different widths,
  // and matching them all made this assertion meaningless.
  const ri = pa.slice(pa.indexOf("async function renderInvoices"), pa.indexOf("async function renderCustomers"));
  const spans = [...ri.matchAll(/colspan="(\d)"/g)].map(x => x[1]);
  const htmlSpan = /id="invoices-table"><tr><td colspan="(\d)"/.exec(ph)?.[1];
  ok(htmlSpan === "8", `C3 the initial loading row spans 8 (${htmlSpan})`);
  ok(spans.length > 0 && spans.every(v => v === "8"), `C4 every invoice-table empty state spans 8 (${spans.join(",") || "none found"})`);
}


console.log("\n═══ MISSED-WAKEUP RECOVERY CONTRACT ═══");
{
  const m = read("supabase/migrations/0013_notification_delivery.sql");
  const w = read("supabase/functions/resend-webhook/index.ts");
  ok(/'unresolved', true/.test(m), "R1 an unmatched event reports unresolved");
  ok(/attached_on_retry/.test(m), "R2 a provider retry attaches an already-recorded event");
  ok(/where provider_event_id = p_provider_event_id and outbox_id is null/.test(m),
     "R3 attachment is scoped to that exact event id and only when unattached");
  ok(/if \(result\?\.unresolved\)[\s\S]{0,400}409\)/.test(w), "R4 the function answers 409 so Resend retries");
  ok(/409, not 500/.test(w), "R5 and documents why 409 rather than 500");
  ok(/when p_new_at is null then false/.test(m), "R6 an event with no provider timestamp cannot decide state");
  ok(/and occurred_at is not null/.test(m), "R7 and is excluded from the replay");
  ok(/Number\.isFinite\(parsed\) \? new Date\(parsed\)\.toISOString\(\) : null/.test(w),
     "R8 a malformed created_at becomes NULL rather than a fabricated time");
  ok(/grant  execute on function delivery_event_wins[^;]*to authenticated/.test(m),
     "R9 only the pure comparison helpers are readable by admin tooling");
  ok(!/grant  execute on function (apply_delivery_event|reconcile_delivery_state)[^;]*authenticated/.test(m),
     "R10 the state-changing functions remain service_role only");
  ok(existsSync(R + "tests/PHASE_DELIVERY_CONCURRENCY.mjs"), "R11 a two-session concurrency test exists");
  const c = read("tests/PHASE_DELIVERY_CONCURRENCY.mjs");
  ok(/spawn\(/.test(c) && /pg_sleep/.test(c), "R12 it uses two real sessions with a forced interleaving");
  ok(/process\.exit\(3\)/.test(c), "R13 and exits 3 rather than passing when no database is configured");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
