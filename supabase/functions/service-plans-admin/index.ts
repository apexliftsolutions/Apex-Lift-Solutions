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
import { helcimCall, subscriptionIdempotencyKey } from "../_shared/helcim-api.ts";

const FN_VERSION = "2026-09-10.v25.1.0-equipment-phase1";
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
          nickname: str(body.nickname) || null,
          power_type: str(body.power_type) || null,
          capacity_lbs: body.capacity_lbs === "" || body.capacity_lbs == null ? null : Number(body.capacity_lbs),
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
        for (const f of ["unit_number", "year", "make", "model", "serial_number", "service_location", "notes", "nickname", "power_type"]) {
          if (f in body) patch[f] = str(body[f]) || null;
        }
        if ("capacity_lbs" in body) patch.capacity_lbs = body.capacity_lbs === "" || body.capacity_lbs == null ? null : Number(body.capacity_lbs);
        if ("status" in body) {
          const st = str(body.status);
          if (!["active", "inactive", "retired"].includes(st)) return j({ error: "bad_status" }, 400);
          patch.status = st;
        }
        if (!Object.keys(patch).length) return j({ error: "nothing_to_update" }, 400);

          // Identity is frozen once ANY agreement has named this unit, but only a
          // REAL change is a violation. A client that echoes back the stored
          // make/model/year/serial while editing a nickname is doing nothing wrong,
          // and rejecting it because the KEY is present made every descriptive edit
          // on a contracted unit impossible.
          const IDENTITY = ["serial_number", "make", "model", "year"];
          const submitted = IDENTITY.filter((f) => f in patch);
          if (submitted.length) {
            const { data: cur } = await db.from("customer_equipment")
              .select("serial_number, make, model, year").eq("id", id).maybeSingle();
            if (!cur) return j({ error: "equipment_not_found" }, 404);
            const norm = (v) => (v === "" || v == null ? null : String(v));   // "" and null both mean not set
            const changing = submitted.filter((f) => norm(patch[f]) !== norm(cur[f]));
            if (changing.length) {
              const { data: agreed } = await db.from("service_plan_agreements")
                .select("id").eq("equipment_id", id).limit(1);   // any agreement ever
              if (agreed?.length) {
                return j({ error: "equipment_under_signed_agreement",
                  detail: `Serial, make, model and year are frozen once this unit has been named in a signed agreement (including one since cancelled or superseded). Attempted to change: ${changing.join(", ")}.` }, 409);
              }
            } else {
              // Nothing is actually changing: drop the keys so the DB trigger, which
              // compares old vs new, has nothing to object to either.
              for (const f of submitted) delete patch[f];
            }
          }
          if (!Object.keys(patch).length) return j({ error: "nothing_to_update" }, 400);

        const { data, error } = await db.from("customer_equipment")
          .update(patch).eq("id", id).select().single();
        if (error) {
          // Migration 0011 enforces these in the database regardless of caller;
          // surface them as stable codes rather than raw SQL.
          const m = error.message;
          if (m.includes("equipment_has_live_subscription")) return j({ error: "equipment_has_live_subscription", detail: "This unit has a live service plan. Cancel or complete it before retiring the unit." }, 409);
            if (m.includes("equipment_has_open_offer")) return j({ error: "equipment_has_open_offer", detail: "This unit has a service plan offer awaiting the customer. Cancel the offer before retiring the unit." }, 409);
          if (m.includes("equipment_under_signed_agreement")) return j({ error: "equipment_under_signed_agreement", detail: "Serial, make, model and year are frozen once this unit is named in a signed agreement." }, 409);
          if (m.includes("equipment_retired_is_terminal"))   return j({ error: "equipment_retired", detail: "A retired unit cannot be reactivated." }, 409);
          if (m.includes("serial_not_placeholder"))          return j({ error: "serial_placeholder", detail: "Leave the serial blank rather than entering N/A or Unknown." }, 422);
          return j({ error: friendly(m) }, 400);
        }
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

        // Only an ACTIVE unit may enter a plan. A retired or inactive machine
        // must never acquire a new offer — the browser is not trusted for this.
        if (!isUpdate && equipment_id) {
          const { data: eq } = await db.from("customer_equipment")
            .select("id, customer_id, status").eq("id", equipment_id).maybeSingle();
          if (!eq) return j({ error: "equipment_not_found" }, 404);
          if (eq.status !== "active") {
            return j({ error: "equipment_not_active",
              detail: `This forklift is ${eq.status} and cannot start a new service plan.` }, 409);
          }
        }

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

        // Re-read equipment at SEND time: the draft may have been created while
        // the unit was active and the unit retired since. The check at creation
        // is not sufficient on its own.
        {
          const { data: eq } = await db.from("customer_equipment")
            .select("status").eq("id", cur.equipment_id).maybeSingle();
          if (!eq) return j({ error: "equipment_not_found" }, 404);
          if (eq.status !== "active") {
            return j({ error: "equipment_not_active",
              detail: `This forklift is ${eq.status}. Reactivate it or create the offer against an active unit before sending.` }, 409);
          }
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
      // ── PROVIDER STATUS WRITES: pause / resume / cancel ─────────────────
      //
      // PATCH https://api.helcim.com/v2/subscriptions
      //   { "subscriptions": [ { "id": <int>, "status": "paused"|"active"|"cancelled" } ] }
      //
      // Minimal body ON PURPOSE. dateActivated, recurringAmount and
      // hasFreeTrialPeriod are never sent on a status change: Helcim documents
      // that hasFreeTrialPeriod cannot be altered in the same request as a
      // status change, and sending recurringAmount here would let a status
      // operation silently reprice a signed contract.
      //
      // Every one of these follows the same shape, which is the shape
      // subscription-activate already established:
      //     read provider -> verify eligible -> write -> read back -> verify
      //     -> only then persist Apex -> audit -> reconcile
      //
      // Apex NEVER records the new state from an HTTP 200 alone.
      case "pause-subscription":
      case "resume-subscription":
      case "cancel-subscription": {
        const subscription_id = str(body.subscription_id);
        const reason = str(body.reason);
        if (!subscription_id) return j({ error: "subscription_id required" }, 400);

        const wantCancel = action === "cancel-subscription";
        const wantPause  = action === "pause-subscription";
        const target: "paused" | "active" | "cancelled" =
          wantCancel ? "cancelled" : wantPause ? "paused" : "active";

        // A reason is mandatory for the two that change what the customer owes
        // or receives. Resume restores the signed arrangement, so it does not
        // demand one.
        if ((wantCancel || wantPause) && !reason) return j({ error: "reason_required" }, 400);
        if (reason.length > 500) return j({ error: "reason_too_long" }, 400);

        const { data: sub } = await db.from("service_subscriptions")
          .select("*").eq("id", subscription_id).maybeSingle();
        if (!sub) return j({ error: "subscription_not_found" }, 404);

        // Local-only stop for a subscription that never reached Helcim.
        if (!sub.provider_subscription_id) {
          if (!wantCancel) return j({ error: "not_provider_bound", detail: "This subscription was never created at Helcim." }, 409);
          if (["cancelled", "completed"].includes(String(sub.status))) {
            return j({ ok: true, status: sub.status, already_stopped: true, fn_version: FN_VERSION });
          }
          const t = new Date().toISOString();
          await db.from("service_subscriptions").update({
            status: "cancelled", cancel_requested_at: t, cancel_requested_by: user.id,
            cancel_reason: reason, cancelled_at: t, cancelled_by: user.id,
            provider_cancel_confirmed: true, updated_at: t,
          }).eq("id", sub.id);
          await spEvent(db, sub, "subscription_cancelled", { reason, by: user.id, provider_called: false });
          await log(db, user.id, "service_plan_subscription_cancelled_local", `${sub.id}: ${reason}`);
          return j({ ok: true, status: "cancelled", provider_called: false, fn_version: FN_VERSION });
        }

        const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
        if (!token) return j({ error: "helcim_not_configured" }, 500);
        const pid = Number(sub.provider_subscription_id);
        if (!Number.isInteger(pid) || pid <= 0) return j({ error: "provider_subscription_id_invalid" }, 409);

        // 1. Provider truth BEFORE deciding anything.
        const before = await readSubscription(token, pid);
        if (!before.ok) {
          return j({ error: "provider_lookup_failed", category: before.category,
                     provider_http: before.httpStatus, apex_unchanged: true }, 502);
        }
        const wasStatus = String(before.sub.status ?? "").toLowerCase();

        // 2. Eligibility, decided from PROVIDER state, not Apex's mirror.
        //    Helcim: a cancelled or expired subscription cannot be made active.
        if (["cancelled", "expired", "term_ended"].includes(wasStatus) && target === "active") {
          return j({ error: "cannot_resume_terminal_subscription",
                     detail: `Helcim reports this subscription as "${before.sub.status}". A cancelled or expired subscription cannot be resumed. Issue a new offer instead.`,
                     provider_status: before.sub.status }, 409);
        }
        if (target === "active" && wasStatus !== "paused") {
          return j({ error: "not_paused", detail: `Helcim reports "${before.sub.status}". Only a paused subscription can be resumed.`,
                     provider_status: before.sub.status }, 409);
        }
        if (target === "paused" && wasStatus !== "active") {
          return j({ error: "not_pausable", detail: `Helcim reports "${before.sub.status}". Only an active subscription can be paused.`,
                     provider_status: before.sub.status }, 409);
        }
        // Cancelling something already cancelled is a no-op, not an error.
        if (target === "cancelled" && wasStatus === "cancelled") {
          const persisted = await persistStatus(db, sub, before.sub, "cancelled", user.id, reason);
          await spEvent(db, sub, "subscription_cancel_already_confirmed", { by: user.id, reason, provider_status: before.sub.status });
          return j({ ok: true, idempotent: true, status: persisted, provider_status: before.sub.status, fn_version: FN_VERSION });
        }

        // 3. The write. Minimal body, nothing else in it.
        const patch = { subscriptions: [{ id: pid, status: target }] };
        const res = await helcimCall("subscriptions", token, { method: "PATCH", body: patch });

        // 4. Read back. This is the authority — not the PATCH response, and
        //    never the HTTP status on its own.
        //
        //    On an ambiguous outcome we do NOT resend. We read. A status PATCH
        //    is naturally convergent: if the provider already applied it, the
        //    read-back proves it and there is nothing to repeat.
        const after = await readSubscription(token, pid);
        if (!after.ok) {
          await spEvent(db, sub, "subscription_status_change_unresolved", {
            requested: target, by: user.id, patch_http: res.httpStatus,
            patch_category: res.category, readback_http: after.httpStatus,
          });
          return j({ error: "provider_state_unresolved",
                     detail: "The change was sent but Helcim could not be re-read to confirm it. Apex has NOT been changed. Press Sync in a moment — do not repeat the action until provider state is known.",
                     apex_unchanged: true, requested: target }, 202);
        }

        const nowStatus = String(after.sub.status ?? "").toLowerCase();
        if (nowStatus !== target) {
          await spEvent(db, sub, "subscription_status_change_rejected", {
            requested: target, provider_status: after.sub.status,
            patch_http: res.httpStatus, patch_category: res.category, by: user.id,
          });
          return j({ error: "provider_did_not_apply_change",
                     detail: `Helcim still reports "${after.sub.status}" after the request. Apex has NOT been changed.`,
                     provider_status: after.sub.status, category: res.category,
                     provider_http: res.httpStatus, apex_unchanged: true }, 502);
        }

        // 5. Provider confirmed. Only now does Apex move.
        const finalStatus = await persistStatus(db, sub, after.sub, target, user.id, reason);
        await spEvent(db, sub,
          target === "paused" ? "subscription_paused"
          : target === "active" ? "subscription_resumed"
          : "subscription_cancelled",
          { by: user.id, reason: reason || null, previous_provider_status: before.sub.status,
            provider_status: after.sub.status, provider_http: res.httpStatus });
        await log(db, user.id, `recurring_subscription_${target}`, `${sub.id}: ${reason || "—"}`);

        // 6. Best-effort reconcile through the ONE reconciliation implementation.
        const rec = await reconcileOne(subscription_id);

        return j({
          ok: true, status: finalStatus, provider_status: after.sub.status,
          reconciled: rec.ok, reconcile_note: rec.note,
          // Said explicitly because "cancelled" must never be read as "refunded".
          refunds_issued: false,
          detail: target === "cancelled"
            ? "Future billing has stopped at Helcim. Months already paid are NOT refunded — refund each cycle separately from Billing history if that is intended."
            : undefined,
          fn_version: FN_VERSION,
        });
      }

      // ── TERM CHANGE (maxCycles) ─────────────────────────────────────────
      //
      // PATCH { "subscriptions": [ { "id": <int>, "maxCycles": <int> } ] }
      //
      // maxCycles is the TOTAL lifetime cycle count, not the remaining count.
      // A subscription that has billed 2 and should finish at 6 total takes
      // maxCycles: 6. Sending 4 would end it two months early. timesBilled is
      // therefore read from the LIVE provider object, never from Apex's mirror.
      case "change-term": {
        const subscription_id = str(body.subscription_id);
        const newMaxCycles = int(body.max_cycles);
        const reason = str(body.reason);
        const amendmentAck = body.amendment_confirmed === true;

        if (!subscription_id) return j({ error: "subscription_id required" }, 400);
        if (!newMaxCycles || newMaxCycles < 1) return j({ error: "max_cycles_required", detail: "Send the TOTAL number of cycles the plan should bill, not the remaining count." }, 400);
        if (!reason) return j({ error: "reason_required" }, 400);
        if (reason.length > 500) return j({ error: "reason_too_long" }, 400);

        const { data: sub } = await db.from("service_subscriptions")
          .select("*").eq("id", subscription_id).maybeSingle();
        if (!sub) return j({ error: "subscription_not_found" }, 404);
        if (!sub.provider_subscription_id) return j({ error: "not_provider_bound" }, 409);
        if (["cancelled", "completed"].includes(String(sub.status))) {
          return j({ error: "subscription_not_modifiable", detail: `This subscription is ${sub.status}.` }, 409);
        }

        // CONTRACT RULE, checked before the provider is touched at all.
        // Helcim permitting a longer term is not the same as the customer
        // having authorized one. Shortening is an accommodation; extending is
        // a new commitment and needs a signature.
        const { data: agreement } = await db.from("service_plan_agreements")
          .select("term_months,status").eq("id", sub.agreement_id).maybeSingle();
        const signedTerm = Number(agreement?.term_months ?? sub.term_months);
        if (newMaxCycles > signedTerm && !amendmentAck) {
          return j({
            error: "extension_requires_amendment",
            detail: `The signed agreement authorizes ${signedTerm} monthly payments. Extending to ${newMaxCycles} increases what the customer owes and cannot be done by changing the subscription. Issue a revised agreement for the customer to sign.`,
            signed_term_months: signedTerm, requested_max_cycles: newMaxCycles,
          }, 409);
        }

        const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
        if (!token) return j({ error: "helcim_not_configured" }, 500);
        const pid = Number(sub.provider_subscription_id);
        if (!Number.isInteger(pid) || pid <= 0) return j({ error: "provider_subscription_id_invalid" }, 409);

        const before = await readSubscription(token, pid);
        if (!before.ok) {
          return j({ error: "provider_lookup_failed", category: before.category,
                     provider_http: before.httpStatus, apex_unchanged: true }, 502);
        }

        const timesBilled = Number(before.sub.timesBilled ?? 0);
        const currentMax = Number(before.sub.maxCycles ?? sub.max_cycles ?? sub.term_months);
        if (!Number.isFinite(timesBilled)) {
          return j({ error: "provider_times_billed_unknown",
                     detail: "Helcim did not report timesBilled. Refusing to change the term without it — the floor cannot be computed safely.", apex_unchanged: true }, 409);
        }

        // Helcim: maxCycles may be reduced only down to and including the
        // number of times already billed.
        if (newMaxCycles < timesBilled) {
          return j({
            error: "max_cycles_below_times_billed",
            detail: `Helcim has already billed this subscription ${timesBilled} time(s). The total cannot be reduced below ${timesBilled}. Remember maxCycles is the TOTAL, not the remaining count.`,
            times_billed: timesBilled, current_max_cycles: currentMax, requested: newMaxCycles,
          }, 409);
        }
        if (newMaxCycles === currentMax) {
          return j({ ok: true, unchanged: true, max_cycles: currentMax,
                     detail: "The term already equals that total.", fn_version: FN_VERSION });
        }

        const patch = { subscriptions: [{ id: pid, maxCycles: newMaxCycles }] };
        const res = await helcimCall("subscriptions", token, { method: "PATCH", body: patch });

        const after = await readSubscription(token, pid);
        if (!after.ok) {
          await spEvent(db, sub, "subscription_term_change_unresolved", {
            requested: newMaxCycles, by: user.id, patch_http: res.httpStatus, patch_category: res.category,
          });
          return j({ error: "provider_state_unresolved",
                     detail: "The term change was sent but Helcim could not be re-read to confirm it. Apex has NOT been changed. Press Sync before trying again.",
                     apex_unchanged: true }, 202);
        }

        const appliedMax = Number(after.sub.maxCycles ?? NaN);
        if (appliedMax !== newMaxCycles) {
          await spEvent(db, sub, "subscription_term_change_rejected", {
            requested: newMaxCycles, provider_max_cycles: after.sub.maxCycles,
            patch_http: res.httpStatus, patch_category: res.category, by: user.id,
          });
          return j({ error: "provider_did_not_apply_term",
                     detail: `Helcim still reports maxCycles ${after.sub.maxCycles}. Apex has NOT been changed.`,
                     provider_max_cycles: after.sub.maxCycles, category: res.category,
                     provider_http: res.httpStatus, apex_unchanged: true }, 502);
        }

        const t = new Date().toISOString();
        await db.from("service_subscriptions").update({
          max_cycles: newMaxCycles,
          previous_max_cycles: currentMax,
          // Stamped once so the signed term stays legible after any number of changes.
          original_term_months: sub.original_term_months ?? sub.term_months,
          term_changed_at: t, term_changed_by: user.id, term_change_reason: reason,
          term_change_count: Number(sub.term_change_count || 0) + 1,
          times_billed: timesBilled,
          last_synced_at: t, provider_verified_at: t, updated_at: t,
        }).eq("id", sub.id);

        await spEvent(db, sub, "subscription_term_changed", {
          from: currentMax, to: newMaxCycles, times_billed: timesBilled,
          signed_term_months: signedTerm, shortened: newMaxCycles < currentMax,
          amendment_confirmed: amendmentAck, reason, by: user.id,
        });
        await log(db, user.id, "recurring_subscription_term_changed",
          `${sub.id}: ${currentMax} -> ${newMaxCycles} total cycles (${timesBilled} billed): ${reason}`);

        const rec = await reconcileOne(subscription_id);
        return j({
          ok: true, max_cycles: newMaxCycles, previous_max_cycles: currentMax,
          times_billed: timesBilled, remaining: Math.max(0, newMaxCycles - timesBilled),
          reconciled: rec.ok, reconcile_note: rec.note, fn_version: FN_VERSION,
        });
      }

      // ── LIST — company-grouped subscription index ────────────────────────
      case "list-subscriptions": {
        const { data: subs, error: se } = await db.from("service_subscriptions")
          .select("*").order("created_at", { ascending: false }).limit(500);
        if (se) return j({ error: "subscription_query_failed" }, 500);

        const rows = subs ?? [];
        const ids = (k: string) => [...new Set(rows.map((r: any) => r[k]).filter(Boolean))];
        const [custs, equips, health] = await Promise.all([
          ids("customer_id").length
            ? db.from("customers").select("id,name,company,email,status").in("id", ids("customer_id"))
            : Promise.resolve({ data: [] }),
          ids("equipment_id").length
            ? db.from("customer_equipment").select("id,unit_number,year,make,model,serial_number,service_location").in("id", ids("equipment_id"))
            : Promise.resolve({ data: [] }),
          db.from("recurring_sync_health").select("*").maybeSingle(),
        ]);

        const cmap = new Map((custs.data ?? []).map((c: any) => [c.id, c]));
        const emap = new Map((equips.data ?? []).map((e: any) => [e.id, e]));

        // Last payment state per subscription, read from the EXISTING ledger.
        const subIds = rows.map((r: any) => r.id);
        let lastPay = new Map<string, any>();
        if (subIds.length) {
          const { data: pays } = await db.from("payments")
            .select("subscription_id,status,kind,amount_cents,provider_payment_number,created_at")
            .in("subscription_id", subIds).eq("kind", "payment")
            .order("created_at", { ascending: false });
          for (const p of pays ?? []) if (!lastPay.has(p.subscription_id)) lastPay.set(p.subscription_id, p);
        }

        return j({
          ok: true,
          sync_health: health.data ?? null,
          subscriptions: rows.map((s: any) => ({
            ...s,
            customer: cmap.get(s.customer_id) ?? null,
            equipment: emap.get(s.equipment_id) ?? null,
            remaining_cycles: remainingCycles(s),
            last_payment: lastPay.get(s.id) ?? null,
          })),
          fn_version: FN_VERSION,
        });
      }

      // ── DETAIL — one subscription + its billing history ─────────────────
      //
      // Billing history is assembled from the EXISTING append-only payments
      // ledger joined to the recurring invoices the reconciler created. There
      // is no second financial store. Refundability is computed here, on the
      // server, from succeeded corrections — the browser is shown a number but
      // payment-refund recomputes it independently before moving any money.
      case "subscription-detail": {
        const subscription_id = str(body.subscription_id);
        if (!subscription_id) return j({ error: "subscription_id required" }, 400);

        const { data: sub } = await db.from("service_subscriptions")
          .select("*").eq("id", subscription_id).maybeSingle();
        if (!sub) return j({ error: "subscription_not_found" }, 404);

        const [cust, equip, agreement, offer, invoices, payments, events] = await Promise.all([
          db.from("customers").select("id,name,company,email,phone,status").eq("id", sub.customer_id).maybeSingle(),
          db.from("customer_equipment").select("*").eq("id", sub.equipment_id).maybeSingle(),
          db.from("service_plan_agreements").select("*").eq("id", sub.agreement_id).maybeSingle(),
          db.from("service_plan_offers").select("*").eq("id", sub.offer_id).maybeSingle(),
          db.from("invoices").select("*").eq("subscription_id", sub.id).order("billing_period_start", { ascending: true }),
          db.from("payments").select("*").eq("subscription_id", sub.id).order("created_at", { ascending: true }),
          db.from("service_plan_events").select("*").eq("subscription_id", sub.id).order("created_at", { ascending: false }).limit(50),
        ]);

        const pays = payments.data ?? [];
        const cycles = (invoices.data ?? []).map((inv: any) => {
          const forInv = pays.filter((p: any) => p.invoice_id === inv.id);
          const charge = forInv.find((p: any) => p.kind === "payment") ?? null;
          const corrections = forInv.filter((p: any) => ["refund", "reversal"].includes(p.kind));
          const refundedCents = corrections
            .filter((c: any) => c.status === "succeeded")
            .reduce((n: number, c: any) => n + Number(c.amount_cents || 0), 0);
          const originalCents = charge?.status === "succeeded" ? Number(charge.amount_cents || 0) : 0;
          return {
            cycle: charge?.provider_payment_number ?? null,
            invoice_id: inv.id,
            invoice_status: inv.status,
            billing_period_start: inv.billing_period_start,
            billing_period_end: inv.billing_period_end,
            amount_cents: Number(inv.subtotal_cents || 0) + Number(inv.tax_cents || 0),
            payment: charge,
            corrections,
            original_cents: originalCents,
            refunded_cents: refundedCents,
            net_retained_cents: Math.max(0, originalCents - refundedCents),
            // Advisory only. payment-refund recalculates this server-side.
            refundable_cents: Math.max(0, originalCents - refundedCents),
            refundable: charge?.status === "succeeded" && originalCents - refundedCents > 0,
            // Helcim: "The target payment must be declined."
            retry_eligible: charge?.status === "failed" && !!charge?.provider_payment_number,
          };
        });

        return j({
          ok: true,
          subscription: { ...sub, remaining_cycles: remainingCycles(sub) },
          customer: cust.data ?? null,
          equipment: equip.data ?? null,
          agreement: agreement.data ?? null,
          offer: offer.data ?? null,
          cycles,
          events: events.data ?? [],
          // Derived from actual state on the server. The frontend renders these
          // and never infers provider eligibility for itself.
          capabilities: capabilitiesFor(sub, agreement.data, cycles),
          fn_version: FN_VERSION,
        });
      }

      // ── RETRY a declined recurring payment ──────────────────────────────
      //
      // POST /v2/procedures/process-payment { subscriptionId, paymentNumber }
      // with a 25-character idempotency key.
      //
      // This is NOT the "Mark payment paid" endpoint. That one
      // (PATCH /v2/subscriptions/{id}/payments/{n}) marks a cycle approved at
      // the provider WITHOUT collecting money, and must never be wired to a
      // retry button.
      //
      // Helcim states the target payment must be DECLINED. Eligibility is
      // re-checked against the live provider object here, never from the
      // browser and never from Apex's mirror alone.
      // ── RETRY a declined recurring payment ──────────────────────────────
      //
      // POST /v2/procedures/process-payment { subscriptionId, paymentNumber }
      // with a 25-character idempotency key that is PERSISTED BEFORE the call.
      //
      // This is NOT "Mark payment paid" (PATCH /v2/subscriptions/{id}/payments/{n}),
      // which marks a cycle approved without collecting money. That endpoint
      // appears nowhere in this codebase.
      //
      // IDEMPOTENCY MODEL (V24.7)
      // ---------------------------------------------------------------------
      // A retry MOVES MONEY, so an ambiguous outcome must never be resolved by
      // minting a new key and charging again. Instead:
      //
      //   1. An attempt row is inserted BEFORE the provider call, carrying the
      //      key. A partial unique index allows at most ONE in-flight attempt
      //      per (subscription, cycle) — so a double-click, a page reload or an
      //      Edge Function retry cannot create a second key. The database
      //      refuses, not the application.
      //   2. On re-entry with an in-flight attempt, provider state is READ
      //      first. If the payment is no longer declined, the attempt is closed
      //      out and nothing is resubmitted.
      //   3. If it is still declined, the SAME persisted key is reused. Helcim
      //      deduplicates on it, so a resubmission of a request that already
      //      landed cannot become a second charge.
      //   4. A new key is minted only after the previous attempt reached a
      //      definitive outcome.
      case "retry-payment": {
        const subscription_id = str(body.subscription_id);
        const paymentNumber = int(body.payment_number);
        if (!subscription_id) return j({ error: "subscription_id required" }, 400);
        if (!paymentNumber || paymentNumber < 1) return j({ error: "payment_number_required" }, 400);

        const { data: sub } = await db.from("service_subscriptions")
          .select("*").eq("id", subscription_id).maybeSingle();
        if (!sub) return j({ error: "subscription_not_found" }, 404);
        if (!sub.provider_subscription_id) return j({ error: "not_provider_bound" }, 409);

        const gate = await cfgText(db, "recurring_billing_enabled", "false");
        if (gate !== "true") return j({ error: "recurring_billing_disabled" }, 409);

        const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
        if (!token) return j({ error: "helcim_not_configured" }, 500);
        const pid = Number(sub.provider_subscription_id);
        if (!Number.isInteger(pid) || pid <= 0) return j({ error: "provider_subscription_id_invalid" }, 409);

        // Provider truth first, every time.
        const look = await readSubscription(token, pid);
        if (!look.ok) {
          return j({ error: "provider_lookup_failed", category: look.category,
                     provider_http: look.httpStatus, apex_unchanged: true }, 502);
        }
        const target = (look.sub.payments ?? []).find((x: any) => Number(x?.paymentNumber) === paymentNumber);
        if (!target) return j({ error: "provider_payment_not_found", payment_number: paymentNumber }, 404);
        const pstatus = String(target.status ?? "").toLowerCase();

        // Is there an unresolved attempt from a previous press?
        const { data: inFlight } = await db.from("subscription_retry_attempts")
          .select("*").eq("subscription_id", sub.id).eq("payment_number", paymentNumber)
          .eq("status", "in_flight").maybeSingle();

        // The provider moved on. Close the attempt out; charge nothing.
        if (pstatus !== "declined") {
          if (inFlight) {
            await db.from("subscription_retry_attempts").update({
              status: "superseded", resolved_at: new Date().toISOString(),
              resolution_note: `Provider status became "${target.status}" before this attempt was resolved.`,
            }).eq("id", inFlight.id);
            await spEvent(db, sub, "subscription_payment_retry_superseded", {
              payment_number: paymentNumber, provider_status: target.status, by: user.id,
            });
            const rec0 = await reconcileOne(subscription_id);
            return j({
              ok: true, state: "provider_resolved", resubmitted: false,
              provider_status: target.status, reconciled: rec0.ok,
              detail: `Helcim now reports this payment as "${target.status}". A previous retry had an unknown outcome; nothing was charged again.`,
              fn_version: FN_VERSION,
            });
          }
          return j({
            error: "payment_not_retryable",
            detail: `Helcim reports this payment as "${target.status}". Only a declined payment can be reprocessed.`,
            provider_status: target.status,
          }, 409);
        }

        // Still declined. Reuse the persisted key, or open a new attempt.
        let attempt = inFlight;
        let reusedKey = false;

        if (attempt) {
          reusedKey = true;
          await spEvent(db, sub, "subscription_payment_retry_resumed", {
            payment_number: paymentNumber, attempt_no: attempt.attempt_no, by: user.id,
          });
        } else {
          const { count } = await db.from("subscription_retry_attempts")
            .select("id", { count: "exact", head: true })
            .eq("subscription_id", sub.id).eq("payment_number", paymentNumber);
          const ins = await db.from("subscription_retry_attempts").insert({
            subscription_id: sub.id, payment_number: paymentNumber,
            idempotency_key: subscriptionIdempotencyKey(),
            attempt_no: Number(count ?? 0) + 1, requested_by: user.id, status: "in_flight",
          }).select().single();

          if (ins.error) {
            // uq_retry_one_in_flight fired: a concurrent press won the race.
            if (/uq_retry_one_in_flight/.test(ins.error.message)) {
              return j({ error: "retry_already_in_flight",
                         detail: "A retry for this cycle is already in progress. Wait for it to resolve, then press Sync — do not retry again.", }, 409);
            }
            return j({ error: "retry_attempt_persist_failed" }, 500);
          }
          attempt = ins.data;
        }

        await db.from("service_subscriptions").update({
          last_retry_at: new Date().toISOString(), last_retry_by: user.id,
          last_retry_payment_number: paymentNumber, last_retry_result: "attempted",
          updated_at: new Date().toISOString(),
        }).eq("id", sub.id);
        await spEvent(db, sub, "subscription_payment_retry_attempted", {
          payment_number: paymentNumber, attempt_no: attempt.attempt_no,
          reused_idempotency_key: reusedKey, by: user.id,
          provider_retries_before: target.numberOfRetries ?? null,
        });

        const proc = await helcimCall("procedures/process-payment", token, {
          method: "POST", idem: attempt.idempotency_key,
          body: { subscriptionId: pid, paymentNumber },
        });

        const definitiveReject = ["auth", "permission", "invalid", "not_found"].includes(proc.category);
        const nowIso = new Date().toISOString();

        if (proc.ok) {
          await db.from("subscription_retry_attempts").update({
            status: "submitted", resolved_at: nowIso,
            provider_http: proc.httpStatus, provider_category: proc.category,
          }).eq("id", attempt.id);
        } else if (definitiveReject) {
          // Definitively refused: nothing was charged, so a fresh attempt later
          // is safe and the key is retired.
          await db.from("subscription_retry_attempts").update({
            status: "rejected", resolved_at: nowIso,
            provider_http: proc.httpStatus, provider_category: proc.category,
            resolution_note: "Provider definitively refused the request.",
          }).eq("id", attempt.id);
        } else {
          // AMBIGUOUS. The row stays in_flight on purpose: the next press will
          // read provider state first and reuse this same key.
          await db.from("subscription_retry_attempts").update({
            provider_http: proc.httpStatus, provider_category: proc.category,
            resolution_note: "Unresolved provider outcome. Key retained for reuse; do not mint a new one.",
          }).eq("id", attempt.id);
        }

        // Record the attempt against the ledger row without touching amount or
        // status. Reconciliation decides the outcome, not this endpoint.
        const { data: ledger } = await db.from("payments")
          .select("id,retry_attempt_count").eq("subscription_id", sub.id)
          .eq("provider_payment_number", paymentNumber).eq("kind", "payment").maybeSingle();
        if (ledger) {
          await db.from("payments").update({
            retry_attempted_at: nowIso,
            retry_attempt_count: Number(ledger.retry_attempt_count || 0) + 1,
          }).eq("id", ledger.id);
        }

        if (!proc.ok && definitiveReject) {
          await db.from("service_subscriptions").update({ last_retry_result: `rejected_${proc.category}` }).eq("id", sub.id);
          await spEvent(db, sub, "subscription_payment_retry_failed", {
            payment_number: paymentNumber, provider_http: proc.httpStatus, category: proc.category, by: user.id,
          });
          return j({ error: "retry_failed", category: proc.category, provider_http: proc.httpStatus,
                     detail: "Helcim refused the retry. Nothing was charged and the payment is still declined.",
                     fn_version: FN_VERSION }, 502);
        }

        if (!proc.ok) {
          await db.from("service_subscriptions").update({ last_retry_result: "unresolved" }).eq("id", sub.id);
          await spEvent(db, sub, "subscription_payment_retry_unresolved", {
            payment_number: paymentNumber, provider_http: proc.httpStatus, category: proc.category, by: user.id,
          });
          const recU = await reconcileOne(subscription_id);
          return j({
            ok: false, state: "provider_processing", resubmitted: reusedKey,
            detail: "The retry was sent but Helcim's response was lost. Whether it was charged is not yet known. Press Sync in a moment — pressing Retry again will re-read Helcim first and reuse the same idempotency key, so it cannot double-charge.",
            reconciled: recU.ok, fn_version: FN_VERSION,
          }, 202);
        }

        // Accepted. Reconcile immediately so the admin usually sees the real
        // outcome without pressing anything — but the OUTCOME is whatever the
        // provider object says, never HTTP 200.
        await db.from("service_subscriptions").update({ last_retry_result: "submitted" }).eq("id", sub.id);
        await spEvent(db, sub, "subscription_payment_retry_submitted", {
          payment_number: paymentNumber, attempt_no: attempt.attempt_no,
          provider_http: proc.httpStatus, by: user.id,
        });
        await log(db, user.id, "recurring_payment_retry", `${sub.id} cycle ${paymentNumber}: submitted`);

        const rec = await reconcileOne(subscription_id);
        const post = await readSubscription(token, pid);
        const settled = post.ok
          ? (post.sub.payments ?? []).find((x: any) => Number(x?.paymentNumber) === paymentNumber)
          : null;
        const finalStatus = String(settled?.status ?? "").toLowerCase();

        return j({
          ok: true,
          state: finalStatus === "approved" ? "retry_succeeded"
               : finalStatus === "declined" ? "retry_declined"
               : "provider_processing",
          provider_status: settled?.status ?? null,
          reconciled: rec.ok, reconcile_note: rec.note,
          detail: finalStatus === "approved"
            ? "Helcim approved the retry. The ledger has been reconciled."
            : finalStatus === "declined"
              ? "Helcim processed the retry and it declined again. Correct the underlying payment method before retrying."
              : "Retry accepted by Helcim. The billing outcome is not final yet — reconciliation or Sync will finish it.",
          fn_version: FN_VERSION,
        });
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

/**
 * Remaining billing cycles, or null when it cannot be determined honestly.
 * Never guessed: if the provider has not told us how many times it has billed,
 * the UI shows a dash rather than a number that might be wrong.
 */
function remainingCycles(s: any): number | null {
  const max = Number(s?.max_cycles ?? s?.term_months);
  const billed = Number(s?.times_billed);
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(billed) || billed < 0) return null;
  if (["cancelled", "completed", "failed_setup"].includes(String(s?.status))) return 0;
  return Math.max(0, max - billed);
}


// ═══════════════════════════════════════════════════════════════════════════
//  Provider helpers — V24.7
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What an admin may actually do with this subscription right now.
 *
 * Computed here so the browser never guesses provider eligibility, and so a
 * disabled control always carries the real reason rather than a generic one.
 * Helcim: a cancelled or expired subscription cannot be made active again.
 */
function capabilitiesFor(sub: any, agreement: any, cycles: any[]) {
  const st = String(sub?.status ?? "");
  const bound = !!sub?.provider_subscription_id;
  const terminal = ["cancelled", "completed"].includes(st);
  const signedTerm = Number(agreement?.term_months ?? sub?.term_months ?? 0);

  return {
    // Always available, including on terminal subscriptions: a refund or a late
    // ACH return can land long after billing stops.
    sync: bound,
    refund: (cycles ?? []).some((c) => c.refundable),
    retry: (cycles ?? []).some((c) => c.retry_eligible),

    pause: bound && st === "active",
    resume: bound && st === "paused",
    cancel_provider: bound && !terminal,
    change_term: bound && !terminal,

    // Surfaced so the UI can warn before the server refuses.
    signed_term_months: signedTerm,
    extension_requires_amendment: true,
    times_billed: Number(sub?.times_billed ?? 0),
    max_cycles: Number(sub?.max_cycles ?? sub?.term_months ?? 0),
    min_max_cycles: Number(sub?.times_billed ?? 0),

    reasons: {
      pause: !bound ? "Not created at Helcim yet."
        : st === "paused" ? "Already paused."
        : st !== "active" ? `Only an active subscription can be paused (currently ${st.replace(/_/g, " ")}).` : null,
      resume: !bound ? "Not created at Helcim yet."
        : st === "cancelled" ? "A cancelled subscription cannot be resumed. Issue a new offer."
        : st !== "paused" ? `Only a paused subscription can be resumed (currently ${st.replace(/_/g, " ")}).` : null,
      cancel_provider: !bound ? "Not created at Helcim yet."
        : terminal ? `Already ${st}.` : null,
      change_term: !bound ? "Not created at Helcim yet."
        : terminal ? `Cannot change the term of a ${st} subscription.` : null,
    },
  };
}

/** Single read of a Helcim subscription, sub-objects included. */
async function readSubscription(token: string, providerId: number) {
  const r = await helcimCall(`subscriptions/${providerId}?includeSubObjects=true`, token);
  return { ...r, sub: unwrapSub(r.body) };
}

function unwrapSub(b: any): any {
  if (Array.isArray(b)) return b[0] ?? {};
  if (b?.data && !Array.isArray(b.data) && typeof b.data === "object") return b.data;
  if (Array.isArray(b?.subscriptions)) return b.subscriptions[0] ?? {};
  return b ?? {};
}

/**
 * Persist a provider-confirmed status onto the Apex mirror.
 * Called ONLY after a read-back proved the provider agrees.
 *
 * The transition guard in 0006 is the final authority on what is reachable, so
 * a provider status Apex cannot legally represent is recorded as an event and
 * the local status is left alone rather than forced.
 */
async function persistStatus(db: any, sub: any, provider: any,
                             target: "paused" | "active" | "cancelled",
                             actor: string, reason: string) {
  const t = new Date().toISOString();
  const patch: Record<string, unknown> = {
    provider_verified_at: t, last_synced_at: t, updated_at: t,
    times_billed: Number(provider.timesBilled ?? sub.times_billed ?? 0),
    has_failed_payments: provider.hasFailedPayments === "true" || provider.hasFailedPayments === true,
  };
  const nextBilling = String(provider.dateBilling ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(nextBilling)) patch.next_billing_date = nextBilling;

  if (target === "paused") {
    patch.status = "paused";
    patch.paused_at = t; patch.paused_by = actor; patch.pause_reason = reason || null;
  } else if (target === "active") {
    patch.status = "active";
    patch.resumed_at = t; patch.resumed_by = actor;
  } else {
    patch.status = "cancelled";
    patch.cancel_requested_at = sub.cancel_requested_at ?? t;
    patch.cancel_requested_by = sub.cancel_requested_by ?? actor;
    patch.cancel_reason = reason || sub.cancel_reason || null;
    patch.cancelled_at = t; patch.cancelled_by = actor;
    patch.provider_cancel_confirmed = true;
  }

  const { error } = await db.from("service_subscriptions").update(patch).eq("id", sub.id);
  if (error) {
    // The provider HAS changed. Failing to mirror it is a reconciliation
    // problem, not a reason to pretend the provider call did not happen.
    await db.from("service_plan_events").insert({
      event: "subscription_status_persist_failed", source: "admin",
      customer_id: sub.customer_id, equipment_id: sub.equipment_id,
      offer_id: sub.offer_id, agreement_id: sub.agreement_id, subscription_id: sub.id,
      detail: { target, provider_status: provider.status, db_error: error.message },
    });
    return sub.status;
  }
  return target;
}

/** Append-only service-plan event with the full subscription chain attached. */
async function spEvent(db: any, sub: any, event: string, detail: Record<string, unknown>) {
  await db.from("service_plan_events").insert({
    event, source: "admin",
    customer_id: sub.customer_id, equipment_id: sub.equipment_id,
    offer_id: sub.offer_id, agreement_id: sub.agreement_id, subscription_id: sub.id,
    detail: { ...detail, fn_version: FN_VERSION },
  });
}

/**
 * Best-effort single-subscription reconcile.
 *
 * Calls subscription-reconcile rather than reimplementing any of it — there is
 * exactly one reconciliation implementation and this is not it. A failure here
 * is never fatal: the scheduled sweep and the manual Sync button both still
 * reach the same code.
 */
async function reconcileOne(subscriptionId: string): Promise<{ ok: boolean; note: string }> {
  const key = Deno.env.get("RECONCILE_WORKER_KEY") ?? "";
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  if (!key || !base) {
    return { ok: false, note: "RECONCILE_WORKER_KEY is not set on this function. Press Sync to pull the outcome." };
  }
  try {
    const r = await fetch(`${base}/functions/v1/subscription-reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-worker-key": key },
      body: JSON.stringify({ subscription_id: subscriptionId }),
    });
    if (!r.ok) return { ok: false, note: `Reconcile returned ${r.status}. Press Sync.` };
    return { ok: true, note: "Reconciled against Helcim." };
  } catch {
    return { ok: false, note: "Reconcile could not be reached. Press Sync." };
  }
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
