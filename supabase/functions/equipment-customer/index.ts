// =============================================================================
//  equipment-customer  v1.0
//  The ONLY customer write path for customer_equipment.
//
//  Identity comes from the verified auth session, never from the body. The
//  caller's customers row is resolved from auth.getUser(); its status must be
//  'active'; its id is what every write is scoped to. A body.customer_id, if
//  present, is rejected outright rather than ignored — a client that sends one
//  is either confused or probing.
//
//  The database is authoritative for every invariant (ownership immutable,
//  identity lock, retire guard, no delete — migration 0011). This function's
//  job is to translate those raises into friendly, stable error codes and to
//  keep writes to the fields a customer is allowed to touch.
//
//  Actions:  list | create | update | retire
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const FN_VERSION = "equipment-customer v1.0";
const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_ANON    = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Explicit columns. Never select('*') — the row carries created_by and the
// audit machinery sees more than a customer should.
const CUSTOMER_COLS =
  "id, unit_number, nickname, year, make, model, serial_number, equipment_type, power_type, " +
  "capacity_lbs, service_location, notes, status, retired_at, created_at, updated_at";

// What a customer may write. status and customer_id are server-controlled.
const DESCRIPTIVE = ["unit_number", "nickname", "service_location", "notes", "power_type", "capacity_lbs"] as const;
const IDENTITY    = ["year", "make", "model", "serial_number"] as const;
const POWER_TYPES = ["electric", "lp", "diesel", "gas", "other"];
const LIMITS: Record<string, number> = {
  unit_number: 40, nickname: 60, year: 4, make: 60, model: 60, serial_number: 80,
  service_location: 160, notes: 1000,
};
// Live = every subscription status that is not terminal (mirrors 0011).
const LIVE_SUB = ["setup_pending", "method_verified", "active", "past_due", "paused", "cancel_requested"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Validate + normalise one field. Returns [value, error]. Empty string -> null. */
function field(name: string, raw: unknown): [unknown, string | null] {
  if (name === "capacity_lbs") {
    if (raw === "" || raw == null) return [null, null];
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return [null, "capacity_lbs must be a positive whole number"];
    return [n, null];
  }
  if (name === "power_type") {
    const v = str(raw).toLowerCase();
    if (!v) return [null, null];
    return POWER_TYPES.includes(v) ? [v, null] : [null, `power_type must be one of ${POWER_TYPES.join(", ")}`];
  }
  const v = str(raw);
  if (!v) return [null, null];
  if (v.length > (LIMITS[name] ?? 200)) return [null, `${name} is too long`];
  if (name === "year" && !/^\d{4}$/.test(v)) return [null, "year must be four digits"];
  return [v, null];
}

/** Map a database raise to a stable, friendly error. Never leaks SQL. */
function dbError(msg: string): { status: number; error: string; detail: string } {
  if (msg.includes("equipment_under_signed_agreement"))
    return { status: 409, error: "equipment_under_signed_agreement",
             detail: "This forklift has been named in a signed service agreement (even one since cancelled or superseded). Equipment identity cannot be changed." };
  if (msg.includes("equipment_has_open_offer"))
    return { status: 409, error: "equipment_has_open_offer",
             detail: "This forklift has a service plan offer waiting for you. Review or decline it first, or contact us to cancel it." };
  if (msg.includes("equipment_has_live_subscription"))
    return { status: 409, error: "equipment_has_live_subscription",
             detail: "This forklift has a live service plan. Contact us to cancel the plan before retiring the unit." };
  if (msg.includes("equipment_retired_is_terminal"))
    return { status: 409, error: "equipment_retired", detail: "A retired forklift cannot be edited." };
  if (msg.includes("uq_equipment_serial"))
    return { status: 409, error: "duplicate_serial", detail: "You already have a forklift with that serial number." };
  if (msg.includes("serial_not_placeholder"))
    return { status: 422, error: "serial_placeholder", detail: "Leave the serial blank if you don't know it, rather than entering N/A or Unknown." };
  if (msg.includes("serial_not_blank"))
    return { status: 422, error: "serial_blank", detail: "Serial number cannot be blank spaces." };
  if (msg.includes("power_type"))
    return { status: 422, error: "bad_power_type", detail: `Power type must be one of ${POWER_TYPES.join(", ")}.` };
  if (msg.includes("capacity"))
    return { status: 422, error: "bad_capacity", detail: "Capacity must be a positive number of pounds." };
  return { status: 400, error: "equipment_write_failed", detail: "The change could not be saved." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return j({ error: "method_not_allowed" }, 405);

  try {
    // ── 1. Who is calling? From the token, and only from the token. ─────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return j({ error: "unauthorized" }, 401);
    const userClient = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return j({ error: "unauthorized" }, 401);

    const db = createClient(SB_URL, SB_SERVICE);
    const { data: account } = await db.from("customers").select("id, status").eq("id", user.id).maybeSingle();
    if (!account)                    return j({ error: "no_customer_account" }, 403);
    if (account.status !== "active") return j({ error: "account_not_active",
      detail: "Your account is awaiting approval. You'll be able to manage forklifts once it's active." }, 403);
    const customerId: string = account.id;   // the ONLY customer id used below

    const body = await req.json().catch(() => ({}));
    const action = str(body.action);

    // A client that sends customer_id is wrong by construction. Reject, don't ignore.
    if ("customer_id" in body) return j({ error: "customer_id_not_accepted",
      detail: "Your account identity is taken from your session." }, 400);

    // ── 2. Actions ───────────────────────────────────────────────────────────
    switch (action) {
      case "list": {
        const { data: rows, error } = await db.from("customer_equipment")
          .select(CUSTOMER_COLS).eq("customer_id", customerId)
          .order("status").order("created_at", { ascending: false });
        if (error) return j({ error: "list_failed" }, 500);
        const ids = (rows ?? []).map((r) => r.id);
        // Derived flags for the UI. Two cheap lookups, no per-row queries.
        const [{ data: signed }, { data: live }, { data: offers }] = ids.length ? await Promise.all([
          // Any agreement row ever, regardless of later status — matches the 0011 trigger.
          db.from("service_plan_agreements").select("equipment_id").in("equipment_id", ids),
          db.from("service_subscriptions").select("equipment_id, status").in("equipment_id", ids).in("status", LIVE_SUB),
          // A SENT offer blocks retirement (0011). The UI needs to know, or Retire
          // looks enabled and then fails with a surprise 409.
          db.from("service_plan_offers").select("equipment_id").in("equipment_id", ids).eq("status", "sent"),
        ]) : [{ data: [] }, { data: [] }, { data: [] }];
        const lockedSet = new Set((signed ?? []).map((a) => a.equipment_id));
        const liveMap   = new Map((live ?? []).map((s) => [s.equipment_id, s.status]));
        const offerSet  = new Set((offers ?? []).map((o) => o.equipment_id));
        return j({ ok: true, fn_version: FN_VERSION, equipment: (rows ?? []).map((r) => ({
          ...r,
          identity_locked: lockedSet.has(r.id),
          has_live_service_plan: liveMap.has(r.id),
          service_plan_status: liveMap.get(r.id) ?? null,
          has_open_offer: offerSet.has(r.id),
          // One reason, computed server-side, so the UI never has to guess.
          retire_blocked_reason: r.status !== "active" ? null
            : liveMap.has(r.id) ? "live_plan"
            : offerSet.has(r.id) ? "open_offer" : null,
        })) });
      }

      case "create": {
        const row: Record<string, unknown> = { customer_id: customerId, created_by: user.id, status: "active" };
        for (const f of [...DESCRIPTIVE, ...IDENTITY]) {
          if (!(f in body)) continue;
          const [v, err] = field(f, body[f]);
          if (err) return j({ error: "validation", field: f, detail: err }, 422);
          row[f] = v;
        }
        if (!row.make && !row.model && !row.nickname && !row.unit_number)
          return j({ error: "validation", detail: "Enter at least a make and model, a nickname, or a unit number." }, 422);
        const { data, error } = await db.from("customer_equipment").insert(row).select(CUSTOMER_COLS).single();
        if (error) { const e = dbError(error.message); return j({ error: e.error, detail: e.detail }, e.status); }
        return j({ ok: true, fn_version: FN_VERSION, equipment: { ...data, identity_locked: false, has_live_service_plan: false } }, 201);
      }

      case "update": {
        const id = str(body.id);
        if (!id) return j({ error: "id_required" }, 400);
        // Ownership check here is defence in depth: the UPDATE below is also
        // scoped by customer_id, so a foreign id updates zero rows.
        const { data: own } = await db.from("customer_equipment").select("id, status").eq("id", id).eq("customer_id", customerId).maybeSingle();
        if (!own) return j({ error: "not_found" }, 404);
        // Only an ACTIVE unit is editable by its owner. 'inactive' is an admin state
        // (a unit temporarily out of service), so a customer editing it would
        // silently contradict a decision Apex made. 'retired' is terminal.
        if (own.status === "retired") {
          return j({ error: "equipment_retired",
            detail: "This forklift is retired. Retired equipment can't be edited — contact us if you need it back in service." }, 409);
        }
        if (own.status !== "active") {
          return j({ error: "equipment_not_active",
            detail: `This forklift is marked ${own.status} by Apex and can't be edited right now. Contact us if that looks wrong.` }, 409);
        }

        const patch: Record<string, unknown> = {};
        for (const f of [...DESCRIPTIVE, ...IDENTITY]) {
          if (!(f in body)) continue;
          const [v, err] = field(f, body[f]);
          if (err) return j({ error: "validation", field: f, detail: err }, 422);
          patch[f] = v;
        }
        if ("status" in body) return j({ error: "status_not_editable", detail: "Use the retire action." }, 400);
        if (!Object.keys(patch).length) return j({ error: "nothing_to_update" }, 400);

        const { data, error } = await db.from("customer_equipment")
          .update(patch).eq("id", id).eq("customer_id", customerId).select(CUSTOMER_COLS).single();
        if (error) { const e = dbError(error.message); return j({ error: e.error, detail: e.detail }, e.status); }
        return j({ ok: true, fn_version: FN_VERSION, equipment: data });
      }

      case "retire": {
        const id = str(body.id);
        if (!id) return j({ error: "id_required" }, 400);
        // Same rule as update: a customer acts on active units only.
        const { data: cur } = await db.from("customer_equipment")
          .select("status").eq("id", id).eq("customer_id", customerId).maybeSingle();
        if (!cur) return j({ error: "not_found" }, 404);
        if (cur.status === "retired") return j({ error: "equipment_retired", detail: "This forklift is already retired." }, 409);
        if (cur.status !== "active") {
          return j({ error: "equipment_not_active",
            detail: `This forklift is marked ${cur.status} by Apex. Contact us to retire it.` }, 409);
        }
        const { data, error } = await db.from("customer_equipment")
          .update({ status: "retired" }).eq("id", id).eq("customer_id", customerId).select(CUSTOMER_COLS).maybeSingle();
        if (error) { const e = dbError(error.message); return j({ error: e.error, detail: e.detail }, e.status); }
        if (!data) return j({ error: "not_found" }, 404);
        return j({ ok: true, fn_version: FN_VERSION, equipment: data });
      }

      default:
        return j({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error("[equipment-customer]", String(e?.message ?? e).slice(0, 200));
    return j({ error: "internal_error" }, 500);
  }
});
