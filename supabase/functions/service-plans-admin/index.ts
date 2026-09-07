// =============================================================================
//  APEX LIFT SOLUTIONS — service-plans-admin/index.ts
//
//  Every admin write to the Service Plan tables goes through here. The browser
//  has no INSERT/UPDATE/DELETE privilege on customer_equipment,
//  service_plan_offers, service_plan_agreements or service_subscriptions —
//  SERVICE_PLANS_UPGRADE.sql revoked it — so this is not merely the preferred
//  path, it is the only one.
//
//  Actions:
//    create-equipment  update-equipment
//    create-offer      update-offer   send-offer   cancel-offer
//    expire-offers
//
//  DEPLOY: supabase functions deploy service-plans-admin
//
//  PRICING AUTHORITY
//    The admin supplies the ACH and card monthly SUBTOTALS. Tax is computed
//    here from the customer's own tax settings, never accepted from the browser.
//    The database then re-checks that subtotal + tax = total on both rails.
//
//  TAX
//    Same semantics as TAX_UPGRADE.sql: tax_rate_milli_pct is thousandths of a
//    percent (8625 = 8.625%). Apex V1 reads the server-side default rate and
//    jurisdiction from app_config and snapshots them onto the offer so a later
//    config change never silently alters a price already shown to a customer.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";
import { helcimCall } from "../_shared/helcim-api.ts";

const FN_VERSION = "2026-09-07.v24.5";
const ADMIN_EMAIL = Deno.env.get("ADMIN_EMAIL") ?? "admin@apexliftsolutionsusa.com";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ORIGIN = Deno.env.get("PUBLIC_SITE_URL")
  ?? Deno.env.get("APP_BASE_URL")
  ?? "https://apexliftsolutionsusa.com";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // ── 1. Caller must be the admin ─────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return j({ error: "unauthorized" }, 401);

    const userClient = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user || user.email?.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      return j({ error: "forbidden_admin_only" }, 403);
    }

    const db = createClient(SB_URL, SB_SERVICE);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    switch (action) {

      // ── EQUIPMENT ────────────────────────────────────────────────────────
      case "create-equipment": {
        const customer_id = str(body.customer_id);
        if (!customer_id) return j({ error: "customer_id required" }, 400);

        const { data: cust } = await db.from("customers").select("id").eq("id", customer_id).maybeSingle();
        if (!cust) return j({ error: "customer_not_found" }, 404);

        const { data, error } = await db.from("customer_equipment").insert({
          customer_id,
          unit_number: str(body.unit_number) || null,
          year: str(body.year) || null,
          make: str(body.make) || null,
          model: str(body.model) || null,
          serial_number: str(body.serial_number) || null,
          equipment_type: str(body.equipment_type) || "forklift",
          service_location: str(body.service_location) || null,
          notes: str(body.notes) || null,
          created_by: user.id,
        }).select().single();

        if (error) return j({ error: friendly(error.message) }, 400);
        await log(db, user.id, "service_plan_equipment_created", `${data.id} for ${customer_id}`);
        return j({ ok: true, equipment: data, fn_version: FN_VERSION });
      }

      case "update-equipment": {
        const id = str(body.equipment_id);
        if (!id) return j({ error: "equipment_id required" }, 400);

        // Descriptive fields only. customer_id is never editable: the composite
        // FKs bind a unit to its owner, and moving one would silently reassign
        // any offer or signed agreement that points at it.
        const patch: Record<string, unknown> = {};
        for (const f of ["unit_number", "year", "make", "model", "serial_number", "service_location", "notes"]) {
          if (f in body) patch[f] = str(body[f]) || null;
        }
        if ("status" in body) {
          const st = str(body.status);
          if (!["active", "inactive", "retired"].includes(st)) return j({ error: "bad_status" }, 400);
          patch.status = st;
        }
        if (!Object.keys(patch).length) return j({ error: "nothing_to_update" }, 400);

        // Refuse to edit identity fields once the unit is under a signed
        // agreement — the contract names this machine.
        const { data: locked } = await db.from("service_plan_agreements")
          .select("id").eq("equipment_id", id).eq("status", "signed").limit(1);
        if (locked?.length && ("serial_number" in patch || "make" in patch || "model" in patch || "year" in patch)) {
          return j({ error: "equipment_under_signed_agreement", detail: "Serial, make, model and year are frozen once this unit is named in a signed agreement." }, 409);
        }

        const { data, error } = await db.from("customer_equipment")
          .update(patch).eq("id", id).select().single();
        if (error) return j({ error: friendly(error.message) }, 400);
        await log(db, user.id, "service_plan_equipment_updated", id);
        return j({ ok: true, equipment: data, fn_version: FN_VERSION });
      }

      // ── OFFERS ───────────────────────────────────────────────────────────
      case "create-offer":
      case "update-offer": {
        const isUpdate = action === "update-offer";
        const offer_id = str(body.offer_id);
        if (isUpdate && !offer_id) return j({ error: "offer_id required" }, 400);

        const equipment_id = str(body.equipment_id);
        if (!isUpdate && !equipment_id) return j({ error: "equipment_id required" }, 400);

        let equipId = equipment_id;
        if (isUpdate && !equipId) {
          const { data: cur } = await db.from("service_plan_offers")
            .select("equipment_id, status").eq("id", offer_id).maybeSingle();
          if (!cur) return j({ error: "offer_not_found" }, 404);
          if (cur.status !== "draft") return j({ error: "offer_not_draft", detail: "A sent offer's terms are frozen. Cancel it and create a new one." }, 409);
          equipId = cur.equipment_id;
        }

        // The equipment row is the source of truth for who the customer is.
        // Taking customer_id from the browser would be the exact cross-customer
        // mistake the composite FK exists to stop.
        const { data: eq } = await db.from("customer_equipment")
          .select("id, customer_id").eq("id", equipId).maybeSingle();
        if (!eq) return j({ error: "equipment_not_found" }, 404);

        // Customer rows do not carry tax profile columns in the current Apex schema.
        // TAX_UPGRADE stores the authoritative default rate/jurisdiction in app_config
        // and snapshots tax onto each quote/invoice/offer. The previous Phase B/C
        // code selected non-existent customers.tax_* columns; PostgREST therefore
        // returned data=null + an error, which was incorrectly surfaced as
        // customer_not_found even when the customer existed.
        const { data: cust, error: custErr } = await db.from("customers")
          .select("id").eq("id", eq.customer_id).maybeSingle();
        if (custErr) {
          console.error("[create-offer] customer lookup failed", custErr.message);
          return j({ error: "server_error" }, 500);
        }
        if (!cust) return j({ error: "customer_not_found" }, 404);

        const defaultTaxRate = await cfgNumber(db, "sales_tax_default_milli_pct", 8625);
        const defaultTaxJurisdiction = await cfgText(db, "sales_tax_default_jurisdiction", "Nassau / Suffolk County, NY");

        const achSub = cents(body.ach_monthly_subtotal);
        const cardSub = cents(body.card_monthly_subtotal);
        if (achSub === null || achSub <= 0) return j({ error: "bad_ach_price" }, 400);
        if (cardSub === null || cardSub <= 0) return j({ error: "bad_card_price" }, 400);

        const term = int(body.term_months) ?? 6;
        if (term < 1 || term > 120) return j({ error: "bad_term" }, 400);

        const activation = str(body.activation_date);
        if (!activation || !/^\d{4}-\d{2}-\d{2}$/.test(activation)) return j({ error: "bad_activation_date" }, 400);

        // Tax is authoritative server-side. Apex currently has a global default
        // rate/jurisdiction in app_config (the same source established by
        // TAX_UPGRADE); there is no per-customer tax profile in customers yet.
        // V1 service-plan offers therefore snapshot that server-side default.
        const exempt = false;
        const rate = defaultTaxRate;
        const achTax = taxOf(achSub, rate);
        const cardTax = taxOf(cardSub, rate);

        const row = {
          customer_id: eq.customer_id,
          equipment_id: equipId,
          plan_name: str(body.plan_name) || "Monthly Service Plan",
          description: str(body.description) || null,
          included_services: arr(body.included_services),
          exclusions: arr(body.exclusions),
          term_months: term,
          activation_date: activation,
          ach_monthly_subtotal_cents: achSub,
          ach_monthly_tax_cents: achTax,
          ach_monthly_total_cents: achSub + achTax,
          card_monthly_subtotal_cents: cardSub,
          card_monthly_tax_cents: cardTax,
          card_monthly_total_cents: cardSub + cardTax,
          tax_rate_milli_pct: rate,
          tax_exempt: exempt,
          tax_jurisdiction: defaultTaxJurisdiction || null,
          exempt_cert_number: null,
        };

        if (isUpdate) {
          const { data, error } = await db.from("service_plan_offers")
            .update(row).eq("id", offer_id).eq("status", "draft").select().single();
          if (error) return j({ error: friendly(error.message) }, 400);
          await log(db, user.id, "service_plan_offer_updated", offer_id);
          return j({ ok: true, offer: data, fn_version: FN_VERSION });
        }

        const { data, error } = await db.from("service_plan_offers")
          .insert({ ...row, status: "draft", created_by: user.id }).select().single();
        if (error) return j({ error: friendly(error.message) }, 400);
        await log(db, user.id, "service_plan_offer_created", data.id);
        return j({ ok: true, offer: data, fn_version: FN_VERSION });
      }

      case "send-offer": {
        const offer_id = str(body.offer_id);
        if (!offer_id) return j({ error: "offer_id required" }, 400);

        const { data: cur } = await db.from("service_plan_offers")
          .select("id, status, activation_date, equipment_id, customer_id").eq("id", offer_id).maybeSingle();
        if (!cur) return j({ error: "offer_not_found" }, 404);
        if (cur.status !== "draft") {
          return j({ error: "offer_not_draft", detail: `This offer is ${cur.status}.` }, 409);
        }
        if (!cur.activation_date) return j({ error: "activation_date_required" }, 400);

        // Drafts may be prepared for an inactive customer, but sending one
        // creates a customer-facing contractual action and is therefore gated.
        const { data: customer, error: customerErr } = await db.from("customers")
          .select("id, status").eq("id", cur.customer_id).maybeSingle();
        if (customerErr) {
          console.error("[send-offer] customer lookup failed", customerErr.message);
          return j({ error: "server_error" }, 500);
        }
        if (!customer || customer.status !== "active") {
          return j({ error: "account_not_active" }, 409);
        }

        const days = int(body.expiry_days) ?? await cfgInt(db, "service_plan_offer_expiry_days", 30);
        const expires = new Date(Date.now() + days * 86400_000).toISOString();

        // draft -> sent. The database transition guard enforces the direction;
        // the notification trigger queues the customer email in this same
        // transaction, so a sent offer always has its email queued.
        const { data, error } = await db.from("service_plan_offers")
          .update({ status: "sent", sent_at: new Date().toISOString(), expires_at: expires })
          .eq("id", offer_id).eq("status", "draft").select().single();

        if (error) {
          // The partial unique index allows only one outstanding offer per unit.
          if (/uq_offer_one_outstanding_per_equipment/.test(error.message)) {
            return j({ error: "another_offer_already_outstanding", detail: "This forklift already has an offer awaiting a decision. Cancel it first." }, 409);
          }
          return j({ error: friendly(error.message) }, 400);
        }

        await db.from("service_plan_events").insert({
          event: "offer_sent", source: "admin", customer_id: data.customer_id,
          equipment_id: data.equipment_id, offer_id: data.id,
          detail: { expires_at: expires, by: user.id },
        });
        await log(db, user.id, "service_plan_offer_sent", offer_id);
        return j({ ok: true, offer: data, fn_version: FN_VERSION });
      }

      case "cancel-offer": {
        const offer_id = str(body.offer_id);
        if (!offer_id) return j({ error: "offer_id required" }, 400);

        const { data, error } = await db.from("service_plan_offers")
          .update({ status: "cancelled" }).eq("id", offer_id)
          .in("status", ["draft", "sent"]).select().maybeSingle();

        if (error) return j({ error: friendly(error.message) }, 400);
        if (!data) return j({ error: "offer_not_cancellable", detail: "Only a draft or sent offer can be cancelled." }, 409);

        await db.from("service_plan_events").insert({
          event: "offer_cancelled", source: "admin", customer_id: data.customer_id,
          equipment_id: data.equipment_id, offer_id: data.id,
          detail: { by: user.id, reason: str(body.reason) || null },
        });
        await log(db, user.id, "service_plan_offer_cancelled", offer_id);
        return j({ ok: true, offer: data, fn_version: FN_VERSION });
      }

      // Housekeeping: mark past-dated sent offers expired so the "one
      // outstanding offer per unit" index releases and the unit can be re-offered.
      case "expire-offers": {
        const { data, error } = await db.from("service_plan_offers")
          .update({ status: "expired" }).eq("status", "sent")
          .lt("expires_at", new Date().toISOString()).select("id");
        if (error) return j({ error: friendly(error.message) }, 400);
        if (data?.length) await log(db, user.id, "service_plan_offers_expired", `${data.length} offer(s)`);
        return j({ ok: true, expired: data?.length ?? 0, fn_version: FN_VERSION });
      }

      // ADMIN-ONLY emergency/operational cancellation. There is deliberately
      // no customer cancellation endpoint. A signed agreement remains immutable;
      // this stops future processor billing when Apex decides it is necessary.
      case "cancel-subscription": {
        const subscription_id = str(body.subscription_id);
        const reason = str(body.reason);
        if (!subscription_id) return j({ error: "subscription_id required" }, 400);
        if (!reason) return j({ error: "reason_required" }, 400);
        if (reason.length > 500) return j({ error: "reason_too_long" }, 400);

        const { data: sub, error: subErr } = await db.from("service_subscriptions")
          .select("*").eq("id", subscription_id).maybeSingle();
        if (subErr) return j({ error: "subscription_read_failed" }, 500);
        if (!sub) return j({ error: "subscription_not_found" }, 404);
        if (["cancelled","completed"].includes(String(sub.status))) {
          return j({ ok: true, status: sub.status, already_stopped: true, fn_version: FN_VERSION });
        }

        const now = new Date().toISOString();

        // If no Helcim subscription was ever created, this is a local setup stop.
        // setup_pending/method_verified -> cancelled is an allowed terminal transition.
        if (!sub.provider_subscription_id) {
          await db.from("service_subscriptions").update({
            status: "cancelled", cancel_requested_at: now, cancel_requested_by: user.id,
            cancel_reason: reason, cancelled_at: now, cancelled_by: user.id,
            provider_cancel_confirmed: true, updated_at: now,
          }).eq("id", sub.id);
          await db.from("service_plan_events").insert({
            event: "subscription_cancelled", source: "admin", customer_id: sub.customer_id,
            equipment_id: sub.equipment_id, offer_id: sub.offer_id, agreement_id: sub.agreement_id,
            subscription_id: sub.id, detail: { reason, by: user.id, provider_called: false, fn_version: FN_VERSION },
          });
          return j({ ok: true, status: "cancelled", provider_called: false, fn_version: FN_VERSION });
        }

        // Provider-bound subscriptions use the explicit in-flight state so a
        // network failure never falsely claims future billing was stopped.
        await db.from("service_subscriptions").update({
          status: "cancel_requested", cancel_requested_at: now, cancel_requested_by: user.id,
          cancel_reason: reason, updated_at: now,
        }).eq("id", sub.id);
        await db.from("service_plan_events").insert({
          event: "subscription_cancel_requested", source: "admin", customer_id: sub.customer_id,
          equipment_id: sub.equipment_id, offer_id: sub.offer_id, agreement_id: sub.agreement_id,
          subscription_id: sub.id, detail: { reason, by: user.id, fn_version: FN_VERSION },
        });

        const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
        if (!token) return j({ error: "helcim_not_configured", status: "cancel_requested" }, 500);
        const del = await helcimCall(`subscriptions/${sub.provider_subscription_id}`, token, { method: "DELETE" });
        if (!del.ok && del.category !== "not_found") {
          await db.from("service_plan_events").insert({
            event: "subscription_cancel_provider_error", source: "admin", customer_id: sub.customer_id,
            equipment_id: sub.equipment_id, offer_id: sub.offer_id, agreement_id: sub.agreement_id,
            subscription_id: sub.id, detail: { category: del.category, provider_http: del.httpStatus, fn_version: FN_VERSION },
          });
          return j({ error: "provider_cancel_failed", category: del.category, provider_http: del.httpStatus, status: "cancel_requested" }, 502);
        }

        const { data: stopped, error: stopErr } = await db.from("service_subscriptions").update({
          status: "cancelled", cancelled_at: now, cancelled_by: user.id,
          provider_cancel_confirmed: true, last_synced_at: now, updated_at: now,
        }).eq("id", sub.id).select().single();
        if (stopErr) return j({ error: "cancel_persist_failed", provider_cancelled: true }, 500);
        await db.from("service_plan_events").insert({
          event: "subscription_cancelled", source: "admin", customer_id: sub.customer_id,
          equipment_id: sub.equipment_id, offer_id: sub.offer_id, agreement_id: sub.agreement_id,
          subscription_id: sub.id, detail: { reason, by: user.id, provider_http: del.httpStatus, fn_version: FN_VERSION },
        });
        await log(db, user.id, "service_plan_subscription_cancelled", `${sub.id}: ${reason}`);
        return j({ ok: true, subscription: stopped, status: "cancelled", fn_version: FN_VERSION });
      }

      default:
        return j({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error("[service-plans-admin]", e);
    return j({ error: "server_error" }, 500);
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────
function str(v: unknown): string { return typeof v === "string" ? v.trim() : (v == null ? "" : String(v).trim()); }
function int(v: unknown): number | null { const n = Number(v); return Number.isInteger(n) ? n : null; }

/** Dollars (string or number) → integer cents. Rejects anything not finite. */
function cents(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** tax_rate_milli_pct is thousandths of a percent: cents * rate / 100000. */
function taxOf(subtotalCents: number, rateMilliPct: number): number {
  if (!rateMilliPct) return 0;
  return Math.round((subtotalCents * rateMilliPct) / 100000);
}

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split("\n").map((x) => x.trim()).filter(Boolean);
  return [];
}

async function cfgInt(db: any, key: string, dflt: number): Promise<number> {
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

async function cfgNumber(db: any, key: string, dflt: number): Promise<number> {
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

async function cfgText(db: any, key: string, dflt: string): Promise<string> {
  const { data } = await db.from("app_config").select("value").eq("key", key).maybeSingle();
  const v = typeof data?.value === "string" ? data.value.trim() : "";
  return v || dflt;
}

async function log(db: any, actor: string, action: string, detail: string) {
  await db.from("activity_log").insert({ actor_id: actor, action, detail });
}

/** Turn a raw constraint failure into something an admin can act on. */
function friendly(msg: string): string {
  if (/uq_equipment_serial/.test(msg)) return "That serial number is already recorded for this customer.";
  if (/fk_offer_equipment_same_customer/.test(msg)) return "That forklift does not belong to that customer.";
  if (/ck_offer_.*reconciles/.test(msg)) return "The price breakdown does not add up. Refresh and try again.";
  if (/uq_offer_one_outstanding_per_equipment/.test(msg)) return "This forklift already has an offer awaiting a decision.";
  if (/terms are frozen/.test(msg)) return "This offer has already been sent and its terms are frozen.";
  if (/cannot move from/.test(msg)) return msg;
  return msg;
}
