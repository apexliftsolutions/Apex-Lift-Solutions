// =============================================================================
//  Equipment Phase 1 — function contract + UI wiring
//  The database rules are proven in tests/sql/equipment_phase1.sql against a
//  real Postgres. This file covers what static/jsdom can prove about the Edge
//  Function and the portal wiring.
// =============================================================================
import { readFileSync, existsSync } from "fs";
import { JSDOM, VirtualConsole } from "jsdom";
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };
const R = new URL("../", import.meta.url).pathname;
const read = f => readFileSync(R + f, "utf8");
const tick = () => new Promise(r => setTimeout(r, 10));

console.log("═══ MIGRATION 0011 EXISTS AND IS ADDITIVE ═══");
{
  const m = read("supabase/migrations/0011_equipment_core.sql");
  ok(existsSync(R + "supabase/migrations/0011_equipment_core.sql"), "M1 0011 present");
  ok(!/create table/i.test(m), "M2 creates no new table — customer_equipment is reused");
  ok(/add column if not exists nickname/.test(m) && /power_type/.test(m) && /capacity_lbs/.test(m) && /retired_at/.test(m), "M3 the four justified columns");
  ok(/'N\/A','NA','UNKNOWN','NONE','TBD'/.test(m), "M4 placeholder serials rejected");
  ok(/equipment_customer_immutable/.test(m) && /equipment_under_signed_agreement/.test(m) && /equipment_has_live_subscription/.test(m) && /equipment_delete_forbidden/.test(m) && /equipment_retired_is_terminal/.test(m), "M5 all five protections present");
  ok(/not in \('cancelled','completed','failed_setup'\)/.test(m), "M6 live = not terminal, using the REAL 0006 enum");
  ok(!/grant (insert|update)/i.test(m), "M7 no new write grant to authenticated — writes stay behind the function");
  for (const n of ["0001","0002","0003","0004","0005","0006","0007","0008","0009","0010"])
    ok(readFileSync(R + `supabase/migrations/${n}_${{ "0001":"fresh_test_only","0002":"production_upgrade","0003":"feesaver","0004":"tax","0005":"refund_void_v22","0006":"service_plans","0007":"service_plan_notifications","0008":"recurring_operations","0009":"recurring_admin_ops","0010":"recurring_provider_ops" }[n]}.sql`, "utf8").length > 0, `M8 ${n} untouched (exists)`);
}

console.log("\n═══ IDENTITY LOCK = ANY AGREEMENT EVER, EVERYWHERE ═══");
{
  // Every service_plan_agreements row is a signed contract; superseded and
  // cancelled are later states of that contract. No place may filter on
  // status='signed' when deciding whether identity is locked.
  const m  = read("supabase/migrations/0011_equipment_core.sql");
  const ec = read("supabase/functions/equipment-customer/index.ts");
  const sa = read("supabase/functions/service-plans-admin/index.ts");
  const pa = read("docs/portal-admin.js");
  const lockBlock = m.slice(m.indexOf("-- B. Identity lock"), m.indexOf("-- C. Retire guard"));
  ok(/where a\.equipment_id = old\.id\)/.test(lockBlock) && !/a\.status = 'signed'/.test(lockBlock), "K1 0011 trigger: any agreement row, no status filter");
  const listBlock = ec.slice(ec.indexOf('case "list"'), ec.indexOf('case "create"'));
  ok(/from\("service_plan_agreements"\)\.select\("equipment_id"\)\.in\("equipment_id", ids\)/.test(listBlock) && !/eq\("status", "signed"\)/.test(listBlock), "K2 equipment-customer identity_locked: no status filter");
  const adminPre = sa.slice(sa.indexOf('case "update-equipment"'), sa.indexOf("// ── OFFERS"));
  ok(/\.select\("id"\)\.eq\("equipment_id", id\)\.limit\(1\)/.test(adminPre) && !/eq\("status", "signed"\)/.test(adminPre), "K3 service-plans-admin pre-check: no status filter");
  ok(/const locked = !!\(eq && SP\.agreements\.some\(a => a\.equipment_id === eq\.id\)\);/.test(pa), "K4 portal-admin lock calc: no status filter");
  ok(/including agreements since cancelled or superseded/.test(m), "K5 the database error text says so");
}

console.log("\n═══ equipment-customer CONTRACT ═══");
{
  const f = read("supabase/functions/equipment-customer/index.ts");
  ok(/auth\.getUser\(\)/.test(f), "F1 identity from auth.getUser()");
  ok(/\.eq\("id", user\.id\)\.maybeSingle\(\)/.test(f), "F2 customers row resolved from the session user id");
  ok(/account\.status !== "active"/.test(f) && /account_not_active/.test(f), "F3 requires customers.status = active");
  ok(/const customerId: string = account\.id;/.test(f), "F4 the ONLY customer id used is the resolved one");
  ok(/if \("customer_id" in body\) return j\(\{ error: "customer_id_not_accepted"/.test(f), "F5 a body.customer_id is REJECTED, not ignored");
  const fCode = f.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  ok(!/select\("\*"\)|select\('\*'\)/.test(fCode), "F6 no select('*') in code (comment explaining the rule is not a hit)");
  ok(/id, unit_number, nickname, year, make, model, serial_number, equipment_type, power_type/.test(f), "F7 explicit customer-safe column list");
  ok(!/created_by/.test(f.slice(f.indexOf("const CUSTOMER_COLS"), f.indexOf("const DESCRIPTIVE"))), "F8 created_by is not returned to the customer");
  ok(/identity_locked: lockedSet\.has/.test(f) && /has_live_service_plan: liveMap\.has/.test(f), "F9 list derives identity_locked + has_live_service_plan server-side");
  ok(/status: "active"/.test(f) && /if \("status" in body\) return j\(\{ error: "status_not_editable"/.test(f), "F10 status is server-controlled; update refuses it");
  ok(/case "retire"/.test(f) && /update\(\{ status: "retired" \}\)/.test(f) && !/\.delete\(/.test(f), "F11 retire updates status; nothing deletes");
  ok(/\.eq\("id", id\)\.eq\("customer_id", customerId\)/.test(f), "F12 every write is scoped by the resolved customer id");
  ok(/equipment_under_signed_agreement/.test(f) && /409/.test(f), "F13 identity lock surfaced as friendly 409");
  ok(/equipment_has_live_subscription/.test(f), "F14 live-plan retire refusal surfaced");
  ok(/"setup_pending", "method_verified", "active", "past_due", "paused", "cancel_requested"/.test(f), "F15 live-status list matches the database trigger");
  ok(!/error\.message \}/.test(f) && /dbError\(error\.message\)/.test(f), "F16 raw database messages never returned");
  ok(/case "list"|case "create"|case "update"|case "retire"/.test(f) && (f.match(/case "/g) || []).length === 4, "F17 exactly four actions");
}

console.log("\n═══ ADMIN PATH: REUSED, NOT DUPLICATED ═══");
{
  const a = read("supabase/functions/service-plans-admin/index.ts");
  ok(!existsSync(R + "supabase/functions/equipment-admin"), "A1 no second admin equipment endpoint");
  ok(/case "create-equipment"/.test(a) && /case "update-equipment"/.test(a), "A2 existing admin actions reused");
  ok(/nickname: str\(body\.nickname\)/.test(a) && /power_type: str\(body\.power_type\)/.test(a) && /capacity_lbs:/.test(a), "A3 create accepts the new columns");
  ok(/"nickname", "power_type"\]/.test(a), "A4 update accepts the new columns");
  ok(/equipment_has_live_subscription/.test(a) && /equipment_retired_is_terminal/.test(a), "A5 admin maps the 0011 raises to stable codes");
  ok(/v25\.1\.0-equipment-phase1/.test(a), "A6 admin function version bumped");
  for (const fn of ["payment-checkout","payment-validate","payment-refund","payment-events","subscription-activate","subscription-reconcile","subscription-verify-checkout","subscription-verify-validate","outbox-worker"])
    ok(existsSync(R + `supabase/functions/${fn}/index.ts`), `A7 ${fn} still present (frozen)`);
}

console.log("\n═══ CUSTOMER PORTAL WIRING ═══");
{
  const html = read("docs/portal-customer.html"), js = read("docs/portal-customer.js");
  ok(/data-view="forklifts"/.test(html), "U1 My Forklifts nav item");
  ok(/id="view-forklifts"/.test(html) && /id="fk-dialog"/.test(html), "U2 view + dialog present");
  ok(/if \(v === 'forklifts'\) loadForklifts\(\);/.test(js), "U3 showView loads it");
  for (const a of ["fk-open","fk-close","fk-save","fk-retire","fk-reload"]) ok(new RegExp(`case '${a}':`).test(js), `U4 ${a} routed through the fixed switch`);
  ok(!/ on[a-z]+="/.test(html.slice(html.indexOf('id="view-forklifts"'), html.indexOf("AGREEMENT REVIEW"))), "U5 no inline handlers in the new markup");
  const mod = js.slice(js.indexOf("// ── MY FORKLIFTS"), js.indexOf("/* ── Event wiring (CSP readiness, Surface C)"));
  ok(!/customer_id:/.test(mod), "U6 the UI never sends customer_id");
  ok(/functions\/v1\/equipment-customer/.test(mod), "U7 calls the narrow function, not PostgREST");
  ok(!/from\('customer_equipment'\)\.(insert|update|delete)/.test(js), "U8 no direct table writes from the portal");
  ok(/f\(k\)\.disabled = locked/.test(mod) && /fk-lock-note/.test(mod), "U9 identity fields disabled + explained when locked");
  ok(/named in a signed service agreement \(including any since cancelled or superseded\)\. Equipment identity cannot be changed/.test(html),
     "U10 lock explanation states the rule covers cancelled and superseded agreements");
  ok(/don't enter N\/A or Unknown/.test(html), "U11 serial guidance discourages placeholders");
  // Superseded by retire_blocked_reason, which distinguishes a live plan from an
  // open offer. Asserting the specific reason is stronger than a boolean.
  ok(/e\.retire_blocked_reason \? ` disabled/.test(mod), "U12 Retire disabled when the server reports a blocking reason");
  ok(/account_not_active/.test(mod) && /setAttribute\('hidden'/.test(mod), "U13 pending account: no add control, explanation shown");
  ok(!/Request Service|request-service/.test(mod), "U14 no dead Request-Service control in this slice");
  // Every form control in the dialog has a label.
  const dlg = html.slice(html.indexOf('id="fk-dialog"'), html.indexOf('id="fk-save-btn"'));
  const ids = [...dlg.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map(m => m[1]).filter(i => i !== "fk-id");
  const labelled = ids.filter(i => new RegExp(`<label for="${i}"`).test(dlg));
  ok(labelled.length === ids.length, `U15 all ${ids.length} dialog controls labelled (${ids.length - labelled.length} missing)`);
}

console.log("\n═══ CUSTOMER PORTAL: DOM BEHAVIOUR ═══");
{
  const vc = new VirtualConsole();
  const dom = new JSDOM(read("docs/portal-customer.html"), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, d = w.document;
  const js = read("docs/portal-customer.js");
  const mod = js.slice(js.indexOf("// ── MY FORKLIFTS"), js.indexOf("/* ── Event wiring (CSP readiness, Surface C)"));
  w.xss = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  w.SB_URL = "https://x.supabase.co"; w.sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  w.eval(mod.replace(/^let FK_LIST = \[\];/m, "var FK_LIST = [];"));
  // Render with a hostile fixture: names must stay text, flags must gate controls.
  w.FK_LIST = [
    { id: "u1", nickname: '"><img src=x onerror=alert(1)>', make: "Toyota", model: "8FG", year: "2019", serial_number: "SN-1", status: "active", identity_locked: true, has_live_service_plan: true, service_plan_status: "active", retire_blocked_reason: "live_plan", power_type: "electric", capacity_lbs: 5000 },
    { id: "u2", make: "Hyster", model: "H50", status: "active", identity_locked: false, has_live_service_plan: false, retire_blocked_reason: null },
    { id: "u3", make: "Old", model: "One", status: "retired", retired_at: "2026-01-01T00:00:00Z" },
    { id: "u4", make: "Crown", model: "FC", status: "active", identity_locked: false, has_open_offer: true, retire_blocked_reason: "open_offer" },
    { id: "u5", make: "Clark", model: "C25", status: "inactive", identity_locked: false, retire_blocked_reason: null },
  ];
  w.renderForklifts();
  const body = d.getElementById("fk-body").innerHTML;
  ok(!/<img/.test(body) && /&lt;img/.test(body), "B1 hostile nickname rendered as text");
  ok(/🔒 Named in a signed service agreement/.test(body), "B2 lock indicator shown");
  const retireBtns = [...d.querySelectorAll('[data-action="fk-retire"]')];
  ok(retireBtns.find(b => b.dataset.id === "u1")?.disabled === true, "B3 Retire disabled for the unit with a live plan");
  ok(retireBtns.find(b => b.dataset.id === "u2")?.disabled === false, "B4 Retire enabled for the free unit");
  const offerBtn = retireBtns.find(b => b.dataset.id === "u4");
  ok(offerBtn?.disabled === true && /offer waiting for you/.test(offerBtn.title),
     "B4a Retire disabled for the unit with an open offer, with the offer reason");
  ok(/Service plan offer awaiting your response/.test(body), "B4b the open offer is stated on the card");
  ok(!retireBtns.find(b => b.dataset.id === "u5") && !d.querySelector('[data-action="fk-open"][data-id="u5"]'),
     "B4c an inactive unit exposes no Edit or Retire control");
  ok(/Marked inactive by Apex/.test(body), "B4d and explains why");
  ok(/In service/.test(body) && !/>active</.test(body), "B4e status pills use customer wording, not raw enum values");
  ok(!retireBtns.find(b => b.dataset.id === "u3"), "B5 retired unit has no Edit/Retire controls");
  ok(/Plan: active/.test(body), "B6 plan state shown");
  ok(/Retired \d/.test(body), "B7 retired date shown");
  w.fkOpen("u1");
  ok(d.getElementById("fk-make").disabled && d.getElementById("fk-serial").disabled, "B8 identity fields disabled for a locked unit");
  ok(!d.getElementById("fk-nick").disabled, "B9 descriptive fields remain editable");
  ok(d.getElementById("fk-lock-note").style.display === "block", "B10 lock explanation visible");
  w.fkOpen("u2");
  ok(!d.getElementById("fk-make").disabled && d.getElementById("fk-lock-note").style.display === "none", "B11 unlocked unit: identity editable, no note");
  w.fkOpen(null);
  ok(d.getElementById("fk-title").textContent === "Add forklift" && d.getElementById("fk-id").value === "", "B12 add mode resets the form");
}


console.log("\n═══ BUG 1: LOCKED UNIT, DESCRIPTIVE EDIT MUST SUCCEED ═══");
{
  const sa = read("supabase/functions/service-plans-admin/index.ts");
  const pa = read("docs/portal-admin.js");
  const blk = sa.slice(sa.indexOf('case "update-equipment"'), sa.indexOf('case "create-offer"'));
  ok(/const changing = submitted\.filter\(\(f\) => norm\(patch\[f\]\) !== norm\(cur\[f\]\)\)/.test(blk),
     "X1 backend compares requested vs stored identity values");
  ok(/if \(changing\.length\) \{[\s\S]{0,400}?service_plan_agreements/.test(blk),
     "X2 the agreement lookup happens ONLY when something is really changing");
  ok(/for \(const f of submitted\) delete patch\[f\]/.test(blk),
     "X3 unchanged identity keys are dropped so the DB trigger is not tripped either");
  ok(/const norm = \(v\) => \(v === "" \|\| v == null \? null : String\(v\)\)/.test(blk),
     "X4 '' and null are normalised — an empty control must not read as a change");
  ok(!/\("serial_number" in patch \|\| "make" in patch/.test(blk),
     "X5 the old key-presence rejection is gone");
  // Frontend: identity is added only when unlocked.
  // The save logic moved out of spWireModals() into the globally-routed
  // spSaveEquip() so Add Forklift works without opening Service Plans first.
  const save = pa.slice(pa.indexOf("async function spSaveEquip"), pa.indexOf("function spWireModals"));
  ok(save.length > 400, "X5a spSaveEquip located (slice is not vacuous)");
  ok(/const identityLocked = !!\(id && SP\.agreements\.some\(a => a\.equipment_id === id\)\)/.test(save),
     "X6 admin save computes lock from agreement history");
  ok(/if \(!identityLocked\) \{[\s\S]{0,300}?payload\.serial_number/.test(save),
     "X7 identity fields are added to the payload only when unlocked");
  const payloadLiteral = save.slice(save.indexOf("const payload = {"), save.indexOf("};", save.indexOf("const payload = {")));
  for (const f of ["year", "make", "model", "serial_number"])
    ok(!new RegExp(`^\\s*${f}:`, "m").test(payloadLiteral), `X8 ${f} is not in the unconditional payload`);
  for (const f of ["unit_number", "service_location", "notes", "nickname", "power_type", "capacity_lbs"])
    ok(new RegExp(`${f}:`).test(payloadLiteral), `X9 descriptive field ${f} is always sent`);
}

console.log("\n═══ BUG 2: ONLY ACTIVE EQUIPMENT ENTERS A PLAN ═══");
{
  const m  = read("supabase/migrations/0011_equipment_core.sql");
  const sa = read("supabase/functions/service-plans-admin/index.ts");
  const sc = read("supabase/functions/service-plans-customer/index.ts");
  const ec = read("supabase/functions/equipment-customer/index.ts");
  const pa = read("docs/portal-admin.js");
  ok(/o\.status = 'sent'/.test(m) && /equipment_has_open_offer/.test(m), "Y1 0011 blocks retirement while a SENT offer exists");
  ok(!/o\.status = 'draft'/.test(m), "Y2 a draft offer does NOT block retirement");
  ok(/Deliberately NOT auto-cancelling/.test(m), "Y3 the trigger does not auto-cancel — cancellation stays an audited admin action");
  const co = sa.slice(sa.indexOf('case "create-offer"'), sa.indexOf('case "send-offer"'));
  ok(/if \(!isUpdate && equipment_id\)[\s\S]{0,400}?eq\.status !== "active"/.test(co) && /equipment_not_active/.test(co),
     "Y4 create-offer requires an active unit");
  const so = sa.slice(sa.indexOf('case "send-offer"'), sa.indexOf('case "cancel-offer"') > 0 ? sa.indexOf('case "cancel-offer"') : sa.indexOf('case "create-agreement"'));
  ok(/Re-read equipment at SEND time/.test(so) && /eq\.status !== "active"/.test(so),
     "Y5 send-offer re-reads equipment — a draft made while active cannot be sent once retired");
  const preview = sc.slice(sc.indexOf('case "preview-agreement"'), sc.indexOf('case "sign"'));
  const sign = sc.slice(sc.indexOf('case "sign"'), sc.indexOf('case "agreement-url"'));
  const decline = sc.slice(sc.indexOf('case "decline-offer"'), sc.indexOf('default:', sc.indexOf('case "decline-offer"')));
  const loader = sc.slice(sc.indexOf('async function loadOffer'), sc.indexOf('function requireActiveEquipment'));
  const activeGuard = sc.slice(sc.indexOf('function requireActiveEquipment'), sc.indexOf('// ═══════════════════════════════════════════════════════════════════════════\n//  The agreement itself'));
  ok(!/equipment_not_active/.test(loader) && !/equipment\.status !== "active"/.test(loader),
     "Y6a shared loadOffer does not reject non-active equipment");
  ok(/error: "equipment_not_active"/.test(activeGuard) && /status: 409/.test(activeGuard) && /no longer active, so this service plan offer can't be accepted/.test(activeGuard),
     "Y6b active-equipment guard returns 409 equipment_not_active");
  ok(/requireActiveEquipment\(ctx\)/.test(preview) && /equipmentError\.status/.test(preview),
     "Y6c preview-agreement explicitly enforces active equipment");
  ok(/requireActiveEquipment\(ctx\)/.test(sign) && /equipmentError\.status/.test(sign),
     "Y6d sign explicitly enforces active equipment");
  ok(!/requireActiveEquipment|equipment_not_active/.test(decline),
     "Y6e decline-offer remains available for non-active equipment");
  ok(sign.indexOf('const { data: existing }') >= 0 && sign.indexOf('const { data: existing }') < sign.indexOf('const ctx = await loadOffer'),
     "Y7 already-signed recovery remains before open-offer/active-equipment validation");
  ok(/equipment_has_open_offer/.test(ec) && /Review or decline it first/.test(ec), "Y8 equipment-customer maps the raise for customers");
  ok(/equipment_has_open_offer/.test(sa), "Y9 service-plans-admin maps the raise for admins");
  ok(/eq\.status === 'active'\n\s*\? `<button[^`]*sp-offer-new/.test(pa), "Y10 admin UI offers New offer only for active units");
  ok(/cannot start a new plan/.test(pa), "Y11 and explains why when it does not");
}


console.log("\n═══ GAP 1: CUSTOMER EDITS ARE ACTIVE-ONLY ═══");
{
  const f = read("supabase/functions/equipment-customer/index.ts");
  const upd = f.slice(f.indexOf('case "update"'), f.indexOf('case "retire"'));
  const ret = f.slice(f.indexOf('case "retire"'), f.indexOf("default:"));
  ok(/if \(own\.status !== "active"\)/.test(upd) && /equipment_not_active/.test(upd),
     "Z1 update refuses any non-active unit, not just retired");
  ok(/if \(own\.status === "retired"\)/.test(upd), "Z2 retired keeps its own distinct message");
  ok(/marked \$\{own\.status\} by Apex/.test(upd), "Z3 the inactive message names the state and points at Apex");
  ok(/if \(cur\.status !== "active"\)/.test(ret) && /equipment_not_active/.test(ret),
     "Z4 retire refuses a non-active unit too");
  ok(/already retired/.test(ret), "Z5 retire has a distinct message for an already-retired unit");
  // The customer function must never be able to SET inactive.
  ok(/if \("status" in body\) return j\(\{ error: "status_not_editable"/.test(upd),
     "Z6 a customer still cannot set status directly");
}

console.log("\n═══ GAP 2: MY FORKLIFTS SHOWS PLAN AND OFFER STATE ═══");
{
  const f  = read("supabase/functions/equipment-customer/index.ts");
  const js = read("docs/portal-customer.js");
  const list = f.slice(f.indexOf('case "list"'), f.indexOf('case "create"'));
  ok(/service_plan_offers"\)\.select\("equipment_id"\)[\s\S]{0,80}?eq\("status", "sent"\)/.test(list),
     "W1 list reports a SENT offer");
  ok(/has_open_offer: offerSet\.has\(r\.id\)/.test(list), "W2 has_open_offer is returned");
  ok(/retire_blocked_reason: r\.status !== "active" \? null/.test(list), "W3 one server-computed block reason");
  ok(/liveMap\.has\(r\.id\) \? "live_plan"/.test(list) && /offerSet\.has\(r\.id\) \? "open_offer"/.test(list),
     "W4 both blocking causes are distinguished");
  const mod = js.slice(js.indexOf("// ── MY FORKLIFTS"), js.indexOf("/* ── Event wiring (CSP readiness, Surface C)"));
  ok(/FK_BLOCK\s*=\s*\{[\s\S]{0,400}?live_plan:[\s\S]{0,300}?open_offer:/.test(mod), "W5 one customer-facing sentence per reason");
  ok(/FK_STATUS = \{ active: 'In service'/.test(mod), "W6 raw status is not shown to customers");
  ok(/e\.has_open_offer \?/.test(mod), "W7 an open offer is shown on the card");
  ok(/e\.status === 'inactive' \?/.test(mod), "W8 an inactive unit explains itself");
  ok(/e\.retire_blocked_reason \? ` disabled title="\$\{xss\(FK_BLOCK\[e\.retire_blocked_reason\]\)\}"/.test(mod),
     "W9 Retire is disabled with the specific reason as its title");
  ok(/e\.status === 'active' \? `[\s\S]{0,200}?data-action="fk-open"/.test(mod), "W10 Edit/Retire render only for active units");
  ok(/if \(e && e\.status !== 'active'\)/.test(mod), "W11 fkOpen refuses a non-active unit instead of opening a doomed form");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
