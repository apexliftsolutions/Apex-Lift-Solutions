// =============================================================================
//  APEX — recurring-preflight/index.ts
//
//  READ-ONLY Helcim probe. Makes only GET requests. Creates nothing, charges
//  nothing, modifies nothing. Admin-authenticated.
//
//  It answers two questions we cannot answer any other way:
//
//    1. Does the existing HELCIM_ADMIN_API_TOKEN actually carry Recurring API
//       permissions? 401 and 403 mean different things and are reported
//       differently, because "bad token" and "token lacks the Recurring role"
//       look identical from the outside.
//
//    2. What is the RESPONSE shape of a live subscription object on this
//       account? Helcim's public docs render the PATCH body schema
//       client-side, so the writable field names are not machine-readable from
//       the published page.
//
//  ┌───────────────────────────────────────────────────────────────────────┐
//  │  A GET RESPONSE IS NOT A PATCH CONTRACT.                              │
//  │                                                                       │
//  │  The field list this probe returns proves only what the provider      │
//  │  SENDS BACK. It does not prove any of those fields is writable, that  │
//  │  PATCH accepts the same names, that the request is array-wrapped the  │
//  │  same way, or which status values PATCH will accept.                  │
//  │                                                                       │
//  │  Do NOT implement pause, resume, cancel or term change from this      │
//  │  output. It is a diagnostic aid, not the authority. The authority is  │
//  │  the expanded PATCH ADD-object field schema from Helcim's own docs.   │
//  └───────────────────────────────────────────────────────────────────────┘
//
//  DEPLOY: supabase functions deploy recurring-preflight
//  CALL:   POST { }            -> permissions + plan check
//          POST { subscription_id_hint: 19980 } -> also reports object shape
//
//  THE TOKEN IS NEVER RETURNED AND NEVER LOGGED.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { helcimCall } from "../_shared/helcim-api.ts";

const FN_VERSION = "2026-09-07.v24.5-preflight";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "admin@apexliftsolutionsusa.com").toLowerCase();
const ORIGIN = Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("APP_BASE_URL") ?? "https://apexliftsolutionsusa.com";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return j({ error: "unauthorized" }, 401);
    const uc = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user || String(user.email ?? "").toLowerCase() !== ADMIN_EMAIL) {
      return j({ error: "forbidden_admin_only" }, 403);
    }

    const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
    if (!token) {
      return j({ ok: false, verdict: "STOP", reason: "helcim_not_configured",
                 detail: "HELCIM_ADMIN_API_TOKEN is not set on this project.", fn_version: FN_VERSION }, 500);
    }

    const db = createClient(SB_URL, SB_SERVICE);
    const body = await req.json().catch(() => ({}));
    const probes: any[] = [];
    let stop: string | null = null;

    // ── Probe 1: baseline auth. Proves the token itself is valid. ───────────
    const base = await helcimCall("connection-test", token);
    probes.push(describe("connection-test", "baseline API authentication", base));
    if (base.httpStatus === 401) {
      stop = "The API token itself is not valid. This is not a permissions problem.";
    }

    // ── Probe 2: Recurring READ on payment plans. ───────────────────────────
    // A 403 here while probe 1 succeeded is the diagnostic signal: the token
    // authenticates but the Recurring API role is not enabled.
    const planCollection = await helcimCall("payment-plans?limit=1", token);
    probes.push(describe("GET payment-plans", "Recurring API — read permission", planCollection));

    // ── Probe 3: the specific configured plan, with full validation. ────────
    const planId = Number(await cfg(db, "helcim_recurring_plan_id_expires", "")) || null;
    let planReport: any = { configured: false,
      note: "app_config.helcim_recurring_plan_id_expires is blank. Set it to the Apex Fixed-Term Monthly Service plan id." };

    if (planId) {
      const one = await helcimCall(`payment-plans/${planId}`, token);
      probes.push(describe(`GET payment-plans/${planId}`, "configured plan is readable", one));
      const p = unwrap(one.body);
      planReport = one.ok
        ? {
            configured: true, plan_id: planId,
            status: p.status, type: p.type, currency: p.currency,
            billingPeriod: p.billingPeriod, billingPeriodIncrements: p.billingPeriodIncrements,
            termType: p.termType, termLength: p.termLength,
            taxType: p.taxType, paymentMethod: p.paymentMethod,
            recurringAmount: p.recurringAmount, dateBilling: p.dateBilling,
            activation_would_pass: planVerdict(p),
          }
        : { configured: true, plan_id: planId, readable: false, category: one.category };
    }

    // ── Probe 4: Recurring subscription READ. ───────────────────────────────
    const subCollection = await helcimCall("subscriptions?limit=1", token);
    probes.push(describe("GET subscriptions", "Recurring API — subscription read", subCollection));

    // ── Probe 5: live object shape. This is what unblocks pause/resume/cancel.
    // Helcim renders the PATCH body schema client-side, so the writable field
    // names are not readable from the published docs. A real object tells us
    // the true field names and the status vocabulary actually in use.
    let shape: any = { available: false,
      note: "No subscription exists yet on this account, so the object shape could not be sampled. Re-run this after the first $1 subscription is created." };

    const hint = Number(body.subscription_id_hint ?? 0);
    const sample = hint
      ? await helcimCall(`subscriptions/${hint}?includeSubObjects=true`, token)
      : subCollection;

    const obj = firstSubscription(sample.body);
    if (sample.ok && obj) {
      shape = {
        available: true,
        top_level_fields: Object.keys(obj).sort(),
        observed_status_value: obj.status ?? null,
        has_maxCycles_field: Object.prototype.hasOwnProperty.call(obj, "maxCycles"),
        maxCycles_value: obj.maxCycles ?? null,
        timesBilled: obj.timesBilled ?? null,
        payment_sub_object_fields: Array.isArray(obj.payments) && obj.payments[0]
          ? Object.keys(obj.payments[0]).sort() : null,
        observed_payment_statuses: Array.isArray(obj.payments)
          ? [...new Set(obj.payments.map((x: any) => String(x?.status ?? "")))].filter(Boolean) : null,
        // Deliberately NOT included: customerCode, amounts, dates, names,
        // masked card/bank details, addresses. This probe reports STRUCTURE,
        // never customer or payment data — it is safe to paste into a ticket.
        _warning: "Field names here are RESPONSE fields. They do not establish which fields PATCH accepts or which are writable.",
      };
    }

    const recurringRead = planCollection.ok || subCollection.ok;
    const permissionDenied =
      planCollection.httpStatus === 403 || subCollection.httpStatus === 403;

    if (!stop && permissionDenied) {
      stop = "The token authenticates but is missing the Recurring API permission.";
    }

    return j({
      ok: !stop && recurringRead,
      verdict: stop ? "STOP" : recurringRead ? "RECURRING API REACHABLE" : "INCONCLUSIVE",
      reason: stop,
      what_to_do: stop
        ? (permissionDenied
            ? "In the Helcim dashboard: All Tools > Integrations > API Access. Open the API access configuration this token belongs to and enable the Recurring API permissions (read AND write). Save, then re-run this preflight. Do not start the $1 live test until this returns RECURRING API REACHABLE."
            : "Reissue the API token and set HELCIM_ADMIN_API_TOKEN in Supabase Edge Function secrets.")
        : "Recurring reads succeed. Note that this proves READ access only — a write permission gap would not surface until the first subscription create.",
      probes,
      configured_plan: planReport,
      subscription_object_shape: shape,
      fn_version: FN_VERSION,
    }, stop ? 409 : 200);

  } catch (e) {
    console.error("[recurring-preflight]", String(e));   // never logs the token
    return j({ error: "server_error" }, 500);
  }
});

/** Never includes the token or any response body that could carry customer data. */
function describe(call: string, purpose: string, r: any) {
  return {
    call, purpose,
    http: r.httpStatus,
    category: r.category,
    ok: r.ok,
    meaning:
      r.httpStatus === 401 ? "401 — NOT AUTHENTICATED. The token is wrong, expired, or revoked."
      : r.httpStatus === 403 ? "403 — AUTHENTICATED BUT NOT PERMITTED. The token is valid; this API family is not enabled for it."
      : r.httpStatus === 404 ? "404 — reachable and permitted, but that object does not exist."
      : r.ok ? "OK"
      : r.category === "network" ? "Could not reach Helcim."
      : `HTTP ${r.httpStatus}`,
  };
}

function planVerdict(p: any): string[] {
  const bad: string[] = [];
  if (String(p.status).toLowerCase() !== "active") bad.push("plan is not active");
  if (String(p.type).toLowerCase() !== "subscription") bad.push("type must be subscription");
  if (String(p.currency).toUpperCase() !== "USD") bad.push("currency must be USD");
  if (String(p.billingPeriod).toLowerCase() !== "monthly") bad.push("billingPeriod must be monthly");
  if (Number(p.billingPeriodIncrements) !== 1) bad.push("billingPeriodIncrements must be 1");
  if (String(p.termType).toLowerCase() !== "expires") bad.push("termType must be expires");
  if (String(p.taxType).toLowerCase() !== "no_tax") bad.push("taxType must be no_tax — Apex already charges tax");
  return bad.length ? bad : ["passes every subscription-activate precondition"];
}

async function cfg(db: any, k: string, d: string) {
  const { data } = await db.from("app_config").select("value").eq("key", k).maybeSingle();
  return String(data?.value ?? d).trim();
}
function unwrap(b: any): any {
  if (Array.isArray(b)) return b[0] ?? {};
  if (b?.data && !Array.isArray(b.data) && typeof b.data === "object") return b.data;
  return b ?? {};
}
function firstSubscription(b: any): any {
  const list = Array.isArray(b) ? b
    : Array.isArray(b?.data) ? b.data
    : Array.isArray(b?.subscriptions) ? b.subscriptions
    : b && typeof b === "object" ? [b] : [];
  return list.find((x: any) => x && typeof x === "object" && x.id && x.paymentPlanId) ?? null;
}
