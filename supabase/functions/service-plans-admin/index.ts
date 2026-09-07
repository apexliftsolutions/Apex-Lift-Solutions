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
//    percent (8625 = 8.625%), and an exempt customer is charged zero on BOTH
//    rails. The rate is snapshotted onto the offer so a later rate change never
//    silently alters a price a customer has already been shown.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const FN_VERSION = "2026-09-07.v24.1";
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

        const { data: cust } = await db.from("customers")
          .select("id, tax_rate_milli_pct, tax_exempt, tax_jurisdiction, exempt_cert_number")
          .eq("id", eq.customer_id).maybeSingle();
        if (!cust) return j({ error: "customer_not_found" }, 404);

        const achSub = cents(body.ach_monthly_subtotal);
        const cardSub = cents(body.card_monthly_subtotal);
        if (achSub === null || achSub <= 0) return j({ error: "bad_ach_price" }, 400);
        if (cardSub === null || cardSub <= 0) return j({ error: "bad_card_price" }, 400);

        const term = int(body.term_months) ?? 6;
        if (term < 1 || term > 120) return j({ error: "bad_term" }, 400);

        const activation = str(body.activation_date);
        if (!activation || !/^\d{4}-\d{2}-\d{2}$/.test(activation)) return j({ error: "bad_activation_date" }, 400);

        // Tax is derived here, from the customer record. Never from the browser.
        const exempt = !!cust.tax_exempt;
        const rate = exempt ? 0 : Number(cust.tax_rate_milli_pct ?? 0);
        const achTax = exempt ? 0 : taxOf(achSub, rate);
        const cardTax = exempt ? 0 : taxOf(cardSub, rate);

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
          tax_jurisdiction: cust.tax_jurisdiction ?? null,
          exempt_cert_number: exempt ? (cust.exempt_cert_number ?? null) : null,
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
