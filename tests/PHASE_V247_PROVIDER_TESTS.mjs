// =============================================================================
//  V24.7 — provider action tests
//
//  Mounts the REAL service-plans-admin handler with a fake Helcim that RECORDS
//  every request. The assertions are about the exact bytes sent to the provider
//  and about what Apex does when the provider misbehaves.
//
//  Run:  node tests/PHASE_V247_PROVIDER_TESTS.mjs
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m); } };

const ROOT = new URL("../", import.meta.url).pathname;
const ESB = "/home/claude/node_modules/.bin/esbuild";
const SUB_ID = "aaaaaaaa-1111-4111-8111-000000000001";
const PROVIDER_ID = 123456;

/* ── Fake Helcim ─────────────────────────────────────────────────────────── */
function makeHelcim(state) {
  const calls = [];
  return {
    calls,
    async fetch(url, init = {}) {
      const path = String(url).replace("https://api.helcim.com/v2/", "");
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ path, method, body, idem: init.headers?.["idempotency-key"] ?? null });

      if (method === "GET" && path.startsWith("subscriptions/")) {
        if (state.getFails) return new Response("boom", { status: 500 });
        return Response.json(state.sub);
      }
      if (method === "PATCH" && path === "subscriptions") {
        if (state.patchNetworkLoss) return Promise.reject(new Error("socket hang up"));
        if (state.patchRejects) return new Response(JSON.stringify({ errors: "nope" }), { status: 400 });
        const p = body.subscriptions[0];
        if (!state.patchIgnored) {
          if (p.status !== undefined) state.sub.status = p.status;
          if (p.maxCycles !== undefined) state.sub.maxCycles = p.maxCycles;
        }
        return Response.json({ subscriptions: [state.sub] });
      }
      if (method === "POST" && path === "procedures/process-payment") {
        state.processCalls = (state.processCalls ?? 0) + 1;
        state.processKeys = state.processKeys ?? [];
        state.processKeys.push(init.headers?.["idempotency-key"] ?? null);
        if (state.processNetworkLoss) return Promise.reject(new Error("socket hang up"));
        if (state.processRejects) return new Response("{}", { status: 400 });
        return Response.json({ status: "ok" });
      }
      return new Response("{}", { status: 404 });
    },
  };
}

/* ── Minimal PostgREST-shaped store ──────────────────────────────────────── */
function makeDb(store) {
  const match = (rows, f) => rows.filter((r) => f.every(([op, c, v]) =>
    op === "eq" ? r[c] === v : op === "in" ? v.includes(r[c]) : op === "is" ? r[c] == null : true));
  function builder(table, op, payload) {
    const f = []; let head = false;
    const self = {
      select(_c, o) { if (o?.head) head = true; return self; },
      eq(c, v) { f.push(["eq", c, v]); return self; },
      in(c, v) { f.push(["in", c, v]); return self; },
      is(c) { f.push(["is", c]); return self; },
      order() { return self; }, limit() { return self; },
      maybeSingle() { return self._run(true); },
      single() { return self._run(true, true); },
      then(res, rej) { return self._run(false).then(res, rej); },
      async _run(single, req = false) {
        const rows = store[table] ??= [];
        if (op === "select") {
          const out = match(rows, f);
          if (head) return { data: null, count: out.length, error: null };
          return { data: single ? (out[0] ?? null) : out, count: out.length,
                   error: req && !out[0] ? { message: "no rows" } : null };
        }
        if (op === "insert") {
          const items = Array.isArray(payload) ? payload : [payload];
          // Honour the one-in-flight guard the migration enforces.
          if (table === "subscription_retry_attempts") {
            for (const it of items) {
              if (it.status === "in_flight" && rows.some((r) =>
                r.subscription_id === it.subscription_id &&
                r.payment_number === it.payment_number && r.status === "in_flight")) {
                return { data: null, error: { message: 'duplicate key value violates unique constraint "uq_retry_one_in_flight"' } };
              }
            }
          }
          const added = items.map((it, i) => ({ id: it.id ?? `${table}-${rows.length + i + 1}`, ...it }));
          rows.push(...added);
          return { data: single ? added[0] : added, error: null };
        }
        if (op === "update") {
          const hit = match(rows, f);
          for (const r of hit) Object.assign(r, payload);
          return { data: single ? (hit[0] ?? null) : hit, error: null };
        }
        return { data: null, error: { message: "unsupported" } };
      },
    };
    return self;
  }
  return {
    from: (t) => ({
      select: (...a) => builder(t, "select").select(...a),
      insert: (p) => builder(t, "insert", p),
      update: (p) => builder(t, "update", p),
    }),
    rpc: async () => ({ data: null, error: null }),
  };
}

/* ── Mount the real handler ──────────────────────────────────────────────── */
const base = join(ROOT, "..", ".apexfn");
mkdirSync(base, { recursive: true });
let handler = null;

async function mount(store, helcim, env = {}) {
  const dir = mkdtempSync(join(base, "v247-"));
  let src = readFileSync(join(ROOT, "supabase/functions/service-plans-admin/index.ts"), "utf8");
  src = src.replace(/import \{ createClient \} from "jsr:@supabase\/supabase-js@2";/,
                    'import { createClient } from "./_stub.mjs";');
  // The shared Helcim helper is compiled in UNCHANGED — its real header
  // construction and status categorisation are what these tests exercise.
  src = src.replace(/from "\.\.\/_shared\/helcim-api\.ts"/g,
                    `from "${join(ROOT, "supabase/functions/_shared/helcim-api.ts")}"`);
  src = 'import { DenoStub } from "./_stub.mjs";\n(globalThis).Deno = DenoStub;\n' + src;
  writeFileSync(join(dir, "m.ts"), src);
  writeFileSync(join(dir, "_stub.mjs"), `
export const DenoStub = { serve: (h) => { globalThis.__H = h; }, env: { get: (k) => globalThis.__ENV[k] } };
export const createClient = (u, k) => globalThis.__CLIENT(k);
`);
  execFileSync(ESB, [join(dir, "m.ts"), "--bundle", "--format=esm", "--platform=node",
                     "--external:./_stub.mjs", `--outfile=${join(dir, "m.mjs")}`], { stdio: "pipe" });

  globalThis.__ENV = {
    SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "svc", SUPABASE_ANON_KEY: "anon",
    ADMIN_EMAIL: "admin@apexliftsolutionsusa.com", HELCIM_ADMIN_API_TOKEN: "tok",
    PUBLIC_SITE_URL: "https://apexliftsolutionsusa.com", ...env,
  };
  const db = makeDb(store);
  globalThis.__CLIENT = (k) => k === "anon"
    ? { auth: { getUser: async () => ({ data: { user: { id: "admin-uid", email: "admin@apexliftsolutionsusa.com" } }, error: null }) } }
    : db;
  globalThis.fetch = (u, i) => String(u).includes("api.helcim.com")
    ? helcim.fetch(u, i)
    : Promise.resolve(new Response("{}", { status: 500 }));   // reconcile call: harmless failure

  await import("file://" + join(dir, "m.mjs") + "?t=" + Date.now() + Math.random());
  handler = globalThis.__H;
  return async (b) => {
    const r = await handler(new Request("https://fn.test/x", {
      method: "POST", headers: { Authorization: "Bearer j", "content-type": "application/json" },
      body: JSON.stringify(b),
    }));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

const sub = (over = {}) => ({
  id: SUB_ID, customer_id: "cust-1", equipment_id: "eq-1", offer_id: "off-1", agreement_id: "agr-1",
  provider: "helcim", provider_subscription_id: PROVIDER_ID, provider_customer_code: "CST1",
  status: "active", payment_method: "ach", recurring_total_cents: 16294,
  recurring_subtotal_cents: 15000, recurring_tax_cents: 1294,
  term_months: 6, max_cycles: 6, times_billed: 2, term_change_count: 0, ...over,
});
const psub = (over = {}) => ({
  id: PROVIDER_ID, status: "active", customerCode: "CST1", paymentPlanId: 6395,
  timesBilled: 2, maxCycles: 6, recurringAmount: 162.94, dateBilling: "2026-12-01",
  hasFailedPayments: "no", payments: [], ...over,
});
const freshStore = (s = {}) => ({
  service_subscriptions: [sub(s)],
  service_plan_agreements: [{ id: "agr-1", term_months: 6, status: "signed" }],
  service_plan_events: [], activity_log: [], payments: [], invoices: [],
  subscription_retry_attempts: [],
  app_config: [{ key: "recurring_billing_enabled", value: "true" }],
});

console.log("═══════ 1. EXACT PATCH BODIES ═══════");
for (const [action, want, label] of [
  ["pause-subscription",  { id: PROVIDER_ID, status: "paused" },    "PAUSE"],
  ["cancel-subscription", { id: PROVIDER_ID, status: "cancelled" }, "CANCEL"],
]) {
  const state = { sub: psub() };
  const h = makeHelcim(state);
  const call = await mount(freshStore(), h, {});
  await call({ action, subscription_id: SUB_ID, reason: "test reason" });
  const patch = h.calls.find((c) => c.method === "PATCH");
  ok(!!patch && patch.path === "subscriptions", `T1 ${label} PATCHes /v2/subscriptions`);
  ok(JSON.stringify(patch?.body) === JSON.stringify({ subscriptions: [want] }),
     `T2 ${label} body is exactly ${JSON.stringify({ subscriptions: [want] })}`);
  const keys = Object.keys(patch?.body?.subscriptions?.[0] ?? {});
  ok(!keys.includes("dateActivated") && !keys.includes("hasFreeTrialPeriod") && !keys.includes("recurringAmount"),
     `T3 ${label} sends no dateActivated / hasFreeTrialPeriod / recurringAmount`);
}
{
  const state = { sub: psub({ status: "paused" }) };
  const h = makeHelcim(state);
  const call = await mount(freshStore({ status: "paused" }), h, {});
  await call({ action: "resume-subscription", subscription_id: SUB_ID });
  const patch = h.calls.find((c) => c.method === "PATCH");
  ok(JSON.stringify(patch?.body) === JSON.stringify({ subscriptions: [{ id: PROVIDER_ID, status: "active" }] }),
     'T4 RESUME body is exactly {"subscriptions":[{"id":123456,"status":"active"}]}');
}
{
  const state = { sub: psub({ timesBilled: 2, maxCycles: 12 }) };
  const h = makeHelcim(state);
  const call = await mount(freshStore({ max_cycles: 12, term_months: 12 }), h, {});
  await call({ action: "change-term", subscription_id: SUB_ID, max_cycles: 6, reason: "customer downsized" });
  const patch = h.calls.find((c) => c.method === "PATCH");
  ok(JSON.stringify(patch?.body) === JSON.stringify({ subscriptions: [{ id: PROVIDER_ID, maxCycles: 6 }] }),
     'T5 TERM body is exactly {"subscriptions":[{"id":123456,"maxCycles":6}]}');
  ok(!("status" in (patch?.body?.subscriptions?.[0] ?? {})),
     "T6 a term change does not smuggle a status field");
}

console.log("\n═══════ 2. READ BEFORE WRITE, READ AFTER WRITE ═══════");
{
  const state = { sub: psub() };
  const h = makeHelcim(state);
  const call = await mount(freshStore(), h, {});
  await call({ action: "pause-subscription", subscription_id: SUB_ID, reason: "r" });
  const seq = h.calls.map((c) => c.method);
  ok(seq[0] === "GET" && seq.includes("PATCH") && seq.lastIndexOf("GET") > seq.indexOf("PATCH"),
     `T7 order is GET -> PATCH -> GET (${seq.join(" -> ")})`);
}

console.log("\n═══════ 3. STATE TRANSITIONS ═══════");
const cases = [
  ["ACTIVE -> PAUSED",    "pause-subscription",  "active",    "paused",    true],
  ["PAUSED -> ACTIVE",    "resume-subscription", "paused",    "active",    true],
  ["ACTIVE -> CANCELLED", "cancel-subscription", "active",    "cancelled", true],
  ["PAUSED -> CANCELLED", "cancel-subscription", "paused",    "cancelled", true],
  ["CANCELLED -> ACTIVE", "resume-subscription", "cancelled", "cancelled", false],
];
for (const [label, action, from, expect, shouldWork] of cases) {
  const state = { sub: psub({ status: from }) };
  const h = makeHelcim(state);
  const store = freshStore({ status: from === "cancelled" ? "cancelled" : from });
  const call = await mount(store, h, {});
  const r = await call({ action, subscription_id: SUB_ID, reason: "r" });
  if (shouldWork) {
    ok(r.status === 200 && state.sub.status === expect, `T8 ${label} succeeds`);
    ok(store.service_subscriptions[0].status === expect, `T9 ${label} mirrored into Apex only after confirmation`);
  } else {
    ok(r.status === 409 && !h.calls.some((c) => c.method === "PATCH"),
       `T8 ${label} is REFUSED and no PATCH is sent`);
    ok(state.sub.status === "cancelled", `T9 ${label} leaves provider untouched`);
  }
}

console.log("\n═══════ 4. PROVIDER FAILURE LEAVES APEX UNCHANGED ═══════");
{
  const state = { sub: psub(), patchRejects: true };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  const r = await call({ action: "pause-subscription", subscription_id: SUB_ID, reason: "r" });
  ok(r.status === 502 && r.body.apex_unchanged === true, "T10 a rejected PATCH returns 502 with apex_unchanged");
  ok(store.service_subscriptions[0].status === "active", "T11 Apex is still active after a rejected PATCH");
}
{
  // Provider silently ignores the change — the read-back must catch it.
  const state = { sub: psub(), patchIgnored: true };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  const r = await call({ action: "pause-subscription", subscription_id: SUB_ID, reason: "r" });
  ok(r.body.error === "provider_did_not_apply_change", "T12 a silently-ignored PATCH is caught by the read-back");
  ok(store.service_subscriptions[0].status === "active", "T13 Apex not changed when the provider did not apply it");
}
{
  const state = { sub: psub(), getFails: true };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  const r = await call({ action: "pause-subscription", subscription_id: SUB_ID, reason: "r" });
  ok(r.status === 502 && !h.calls.some((c) => c.method === "PATCH"),
     "T14 an unreadable provider means no PATCH is attempted at all");
}

console.log("\n═══════ 5. TERM CHANGE RULES ═══════");
{
  const state = { sub: psub({ timesBilled: 4, maxCycles: 6 }) };
  const h = makeHelcim(state);
  const call = await mount(freshStore({ times_billed: 4 }), h, {});
  const r = await call({ action: "change-term", subscription_id: SUB_ID, max_cycles: 3, reason: "r" });
  ok(r.body.error === "max_cycles_below_times_billed" && !h.calls.some((c) => c.method === "PATCH"),
     "T15 maxCycles below timesBilled is refused BEFORE Helcim is called");
  ok(r.body.times_billed === 4, "T16 the refusal reports the authoritative timesBilled from the provider");
}
{
  const state = { sub: psub({ timesBilled: 4, maxCycles: 6 }) };
  const h = makeHelcim(state);
  const call = await mount(freshStore({ times_billed: 4 }), h, {});
  const r = await call({ action: "change-term", subscription_id: SUB_ID, max_cycles: 4, reason: "end it here" });
  ok(r.status === 200 && state.sub.maxCycles === 4, "T17 reducing to exactly timesBilled is allowed");
}
{
  // The trap: 2 billed, wants 6 total. Correct answer is 6, not 4.
  const state = { sub: psub({ timesBilled: 2, maxCycles: 12 }) };
  const h = makeHelcim(state);
  const store = freshStore({ max_cycles: 12, term_months: 12 });
  const call = await mount(store, h, {});
  await call({ action: "change-term", subscription_id: SUB_ID, max_cycles: 6, reason: "downsize" });
  ok(state.sub.maxCycles === 6, "T18 maxCycles is sent as the TOTAL (6), not the remainder (4)");
  ok(store.service_subscriptions[0].previous_max_cycles === 12 &&
     store.service_subscriptions[0].term_change_count === 1,
     "T19 the old total and a change count are recorded for audit");
}
{
  const state = { sub: psub({ timesBilled: 2, maxCycles: 6 }) };
  const h = makeHelcim(state);
  const call = await mount(freshStore(), h, {});   // signed term = 6
  const r = await call({ action: "change-term", subscription_id: SUB_ID, max_cycles: 12, reason: "upsell" });
  ok(r.body.error === "extension_requires_amendment" && !h.calls.some((c) => c.method === "PATCH"),
     "T20 extending past the signed term is refused without an amendment, before Helcim is called");
  ok(r.body.signed_term_months === 6, "T21 the refusal states the signed term");
}

console.log("\n═══════ 6. RETRY IDEMPOTENCY ═══════");
const declined = () => psub({ payments: [{ paymentNumber: 3, status: "declined", numberOfRetries: 1 }] });
{
  // Ambiguous outcome, then a second press. Must reuse the key, not mint one.
  const state = { sub: declined(), processNetworkLoss: true };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  const r1 = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(r1.status === 202 && r1.body.state === "provider_processing", "T22 a lost response returns provider_processing, not success");
  const attempts = store.subscription_retry_attempts;
  ok(attempts.length === 1 && attempts[0].status === "in_flight",
     "T23 the attempt stays in_flight so its key is retained");
  const key1 = attempts[0].idempotency_key;
  ok(/^[A-Za-z0-9]{25}$/.test(key1), `T24 the key is exactly 25 alphanumeric chars (${key1.length})`);

  const r2 = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(store.subscription_retry_attempts.length === 1,
     "T25 a second press does NOT create a second attempt row");
  ok(state.processKeys.length === 2 && state.processKeys[0] === state.processKeys[1],
     "T26 the second submission reuses the SAME idempotency key");
}
{
  // Provider moved on between presses: read first, charge nothing.
  const state = { sub: declined(), processNetworkLoss: true };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  const before = state.processCalls;
  state.sub.payments[0].status = "approved";     // Helcim settled it after all
  const r = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(r.body.state === "provider_resolved" && r.body.resubmitted === false,
     "T27 an in-flight attempt whose payment settled is closed out, not resubmitted");
  ok(state.processCalls === before, "T28 NO second charge was submitted");
  ok(store.subscription_retry_attempts[0].status === "superseded", "T29 the attempt is marked superseded");
}
{
  // The eligibility rule must not be weakened.
  const state = { sub: psub({ payments: [{ paymentNumber: 3, status: "approved" }] }) };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  const r = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(r.body.error === "payment_not_retryable" && (state.processCalls ?? 0) === 0,
     "T30 a non-declined payment is never reprocessed");
  ok(store.subscription_retry_attempts.length === 0, "T31 no attempt row is created for an ineligible cycle");
}
{
  // Definitive refusal releases the key so a later attempt is clean.
  const state = { sub: declined(), processRejects: true };
  const h = makeHelcim(state);
  const store = freshStore();
  const call = await mount(store, h, {});
  const r = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(r.status === 502 && store.subscription_retry_attempts[0].status === "rejected",
     "T32 a definitive provider refusal marks the attempt rejected");
  const r2 = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(store.subscription_retry_attempts.length === 2 &&
     store.subscription_retry_attempts[0].idempotency_key !== store.subscription_retry_attempts[1].idempotency_key,
     "T33 a NEW key is minted only after a definitive outcome");
}
{
  const state = { sub: declined() };
  const h = makeHelcim(state);
  const store = freshStore();
  store.app_config = [{ key: "recurring_billing_enabled", value: "false" }];
  const call = await mount(store, h, {});
  const r = await call({ action: "retry-payment", subscription_id: SUB_ID, payment_number: 3 });
  ok(r.body.error === "recurring_billing_disabled" && (state.processCalls ?? 0) === 0,
     "T34 retry respects the recurring gate");
}

console.log("\n═══════ 7. NUMERIC PROVIDER ID VALIDATION ═══════");
for (const bad of [null, "abc", 0, -5]) {
  const state = { sub: psub() };
  const h = makeHelcim(state);
  const call = await mount(freshStore({ provider_subscription_id: bad }), h, {});
  const r = await call({ action: "pause-subscription", subscription_id: SUB_ID, reason: "r" });
  const refused = r.status >= 400 && !h.calls.some((c) => c.method === "PATCH");
  ok(refused, `T35 provider id ${JSON.stringify(bad)} is refused without a provider call`);
}

console.log("\n═══════ 8. CANCELLATION SEMANTICS ═══════");
{
  const state = { sub: psub() };
  const h = makeHelcim(state);
  const store = freshStore();
  store.payments = [{ id: "p1", subscription_id: SUB_ID, kind: "payment", status: "succeeded", amount_cents: 16294 }];
  store.invoices = [{ id: "INV-1", subscription_id: SUB_ID, status: "paid" }];
  const call = await mount(store, h, {});
  const r = await call({ action: "cancel-subscription", subscription_id: SUB_ID, reason: "sold the forklift" });
  ok(r.body.refunds_issued === false, "T36 cancellation reports refunds_issued: false explicitly");
  ok(/NOT refunded/i.test(r.body.detail ?? ""), "T37 the response says prior months are not refunded");
  ok(store.payments[0].status === "succeeded" && store.payments[0].amount_cents === 16294,
     "T38 historical payments are untouched by cancellation");
  ok(store.invoices[0].status === "paid", "T39 historical invoices are untouched");
  ok(store.service_subscriptions[0].provider_subscription_id === PROVIDER_ID,
     "T40 the provider subscription id is RETAINED so history stays reconcilable");
}
{
  // Already cancelled at the provider: idempotent success, no second PATCH.
  const state = { sub: psub({ status: "cancelled" }) };
  const h = makeHelcim(state);
  const call = await mount(freshStore(), h, {});
  const r = await call({ action: "cancel-subscription", subscription_id: SUB_ID, reason: "r" });
  ok(r.status === 200 && r.body.idempotent === true && !h.calls.some((c) => c.method === "PATCH"),
     "T41 cancelling an already-cancelled subscription is idempotent with no PATCH");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
