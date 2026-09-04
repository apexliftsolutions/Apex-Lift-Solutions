// POST /payment-checkout   body: { invoice_id, idempotency_key }
//
// Opens a HelcimPay.js checkout session for an invoice the caller owns.
//
// FEE SAVER
//   Helcim requires BOTH paymentMethod:"cc-ach" AND hasConvenienceFee:1 for
//   Fee Saver. It is a product requirement: the customer must be offered ACH so
//   they can avoid the card fee. We therefore always send "cc-ach" and let
//   Helcim's modal handle method selection and fee display. The browser does not
//   choose the method and cannot influence it.
//
// AMOUNT
//   `amount` sent to Helcim is the BASE invoice amount read from the database.
//   With Fee Saver, Helcim adds the convenience fee on top for card payments.
//   Nothing the browser sends can change what is charged.
//
// RETRY
//   A previous failed or abandoned attempt never blocks a new one. See resolve().
import { createClient } from "jsr:@supabase/supabase-js@2";

const HELCIM_INIT = "https://api.helcim.com/v2/helcim-pay/initialize";
// Helcim checkout tokens are valid for 60 minutes. Reuse inside a safe margin.
const TOKEN_TTL_MS = 55 * 60 * 1000;

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin":  Deno.env.get("PUBLIC_SITE_URL") ?? "https://apexliftsolutionsusa.com",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return j({ error: "unauthorized" }, 401, cors);

  const { invoice_id, idempotency_key } = await req.json().catch(() => ({}));
  if (!invoice_id || !idempotency_key) return j({ error: "bad_request" }, 400, cors);

  // Account must be active.
  const { data: cust } = await sb.from("customers").select("status").eq("id", user.id).maybeSingle();
  if (cust?.status !== "active") return j({ error: "account_not_active" }, 403, cors);

  // Ownership + authoritative amount. IDOR on another customer's invoice → 404.
  const { data: inv } = await sb.from("invoices")
    .select("id, amount, status, customer_id").eq("id", invoice_id).eq("customer_id", user.id).maybeSingle();
  if (!inv) return j({ error: "not_found" }, 404, cors);

  const baseCents = Math.round(Number(inv.amount) * 100);
  if (!Number.isFinite(baseCents) || baseCents <= 0) return j({ error: "invalid_amount" }, 400, cors);

  // ── Resolve prior attempts for this invoice ────────────────────────────────
  const blocked = await resolve(sb, inv, user.id, idempotency_key, baseCents, cors);
  if (blocked) return blocked;

  // ── Create the ledger row BEFORE contacting Helcim ─────────────────────────
  // status 'initiated' = session opening, nothing charged yet.
  const { data: pay, error: payErr } = await sb.from("payments").insert({
    invoice_id: inv.id, customer_id: user.id,
    provider: "helcim", kind: "payment",
    method: null,                       // Helcim's modal decides card vs ACH
    amount_cents: baseCents,            // BASE only — fee is added by Helcim
    fee_cents: 0,
    total_charged_cents: null,
    currency: "USD", status: "initiated",
    idempotency_key, provider_invoice_number: inv.id,
  }).select().single();

  if (payErr) {
    // Unique-index collision = a concurrent duplicate. Never open a second session.
    return j({ error: "duplicate_in_flight" }, 409, cors);
  }

  // ── Initialize with Helcim ─────────────────────────────────────────────────
  // Fee Saver: cc-ach + hasConvenienceFee are BOTH required.
  const body = {
    paymentType:       "purchase",
    amount:            Number((baseCents / 100).toFixed(2)),
    currency:          "USD",
    paymentMethod:     "cc-ach",
    hasConvenienceFee: 1,
  };

  let h: Response;
  try {
    h = await fetch(HELCIM_INIT, {
      method: "POST",
      headers: {
        "api-token":    Deno.env.get("HELCIM_CHECKOUT_API_TOKEN")!,
        "content-type": "application/json",
        "accept":       "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    await failAttempt(sb, pay, inv.id, "gateway_unreachable", { error: String(e) });
    return j({ error: "gateway_unavailable" }, 502, cors);
  }

  const raw = await h.text();
  if (!h.ok) {
    // Capture Helcim's ACTUAL validation message. Without this, every failure
    // looks identical and is undiagnosable from the database.
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep the raw text */ }
    await failAttempt(sb, pay, inv.id, "gateway_init_failed",
      { http_status: h.status, helcim_response: parsed, request_sent: redact(body) });
    return j({ error: "gateway_unavailable", detail: "checkout_init_rejected" }, 502, cors);
  }

  let checkoutToken: string | undefined, secretToken: string | undefined;
  try { ({ checkoutToken, secretToken } = JSON.parse(raw)); } catch { /* fallthrough */ }
  if (!checkoutToken || !secretToken) {
    await failAttempt(sb, pay, inv.id, "gateway_bad_response", { helcim_response: raw.slice(0, 500) });
    return j({ error: "gateway_unavailable" }, 502, cors);
  }

  // secretToken goes to the private schema via a service_role-only RPC.
  const { error: sessErr } = await sb.rpc("create_checkout_session", {
    p_checkout_token: checkoutToken, p_secret_token: secretToken, p_attempt_id: pay.id,
  });
  if (sessErr) {
    await failAttempt(sb, pay, inv.id, "session_store_failed", { error: sessErr.message });
    return j({ error: "gateway_unavailable" }, 502, cors);
  }

  await sb.from("payments").update({ checkout_token: checkoutToken }).eq("id", pay.id);
  await sb.from("payment_events").insert({
    payment_id: pay.id, invoice_id: inv.id, event: "checkout_created", source: "browser_validate",
    detail: { amount_cents: baseCents, fee_saver: true, payment_method: "cc-ach" },
  });
  await sb.from("activity_log").insert({
    actor_id: user.id, action: "payment_checkout_created",
    detail: `${inv.id} $${(baseCents / 100).toFixed(2)} (Fee Saver on)`,
  });

  return j({ checkoutToken, amount_cents: baseCents }, 200, cors);
});

// ── Prior-attempt resolution ─────────────────────────────────────────────────
// A failed or abandoned attempt must NEVER permanently block payment.
async function resolve(
  sb: ReturnType<typeof createClient>, inv: Record<string, unknown>,
  userId: string, idem: string, baseCents: number, cors: Record<string, string>,
): Promise<Response | null> {

  // Same idempotency key replayed → return the original session, never a new charge.
  const { data: same } = await sb.from("payments")
    .select("id, checkout_token, status, initiated_at")
    .eq("customer_id", userId).eq("idempotency_key", idem).maybeSingle();
  if (same) {
    if (same.status === "succeeded") return j({ error: "already_paid" }, 409, cors);
    if (same.status === "pending")   return j({ error: "payment_pending" }, 409, cors);
    if (same.status === "initiated" && fresh(same.initiated_at) && same.checkout_token) {
      return j({ checkoutToken: same.checkout_token, amount_cents: baseCents, reused: true }, 200, cors);
    }
    // failed / unknown / expired → fall through and let a new attempt be created
  }

  // Settled or in-flight attempts on this invoice, newest first.
  const { data: prior } = await sb.from("payments")
    .select("id, status, checkout_token, initiated_at")
    .eq("invoice_id", inv.id).eq("provider", "helcim").eq("kind", "payment")
    .order("created_at", { ascending: false });

  for (const p of prior ?? []) {
    if (p.status === "succeeded") return j({ error: "already_paid" }, 409, cors);
    if (p.status === "pending")   return j({ error: "payment_pending" }, 409, cors);
    if (p.status === "unknown")   return j({ error: "payment_under_review" }, 409, cors);
    if (p.status === "initiated") {
      if (fresh(p.initiated_at) && p.checkout_token) {
        // Live session already open — hand back the same token.
        return j({ checkoutToken: p.checkout_token, amount_cents: baseCents, reused: true }, 200, cors);
      }
      // Stale/abandoned: the customer closed the modal or the token expired.
      // Void it so the partial unique index frees up and a retry can proceed.
      await sb.from("payments").update({
        status: "voided", failure_category: "abandoned", completed_at: new Date().toISOString(),
      }).eq("id", p.id).eq("status", "initiated");
      await sb.from("payment_events").insert({
        payment_id: p.id, invoice_id: inv.id as string, event: "voided", source: "reconcile",
        detail: { reason: "stale_checkout_session" },
      });
    }
    // 'failed' and 'voided' are terminal and non-blocking — a retry is allowed.
  }

  if (inv.status === "paid")            return j({ error: "already_paid" }, 409, cors);
  if (inv.status === "payment_pending") return j({ error: "payment_pending" }, 409, cors);
  if (inv.status !== "unpaid")          return j({ error: "invoice_not_payable" }, 409, cors);
  return null;
}

const fresh = (t: string | null) => !!t && (Date.now() - new Date(t).getTime()) < TOKEN_TTL_MS;

async function failAttempt(
  sb: ReturnType<typeof createClient>, pay: Record<string, unknown>,
  invoiceId: string, category: string, detail: unknown,
) {
  await sb.from("payments").update({
    status: "failed", failure_category: category, completed_at: new Date().toISOString(),
  }).eq("id", pay.id);
  await sb.from("payment_events").insert({
    payment_id: pay.id, invoice_id: invoiceId, event: "declined", source: "browser_validate", detail,
  });
}

// Never log the api-token; the body carries no secrets but keep this explicit.
function redact(b: Record<string, unknown>) { return { ...b }; }

function j(b: unknown, s: number, c: Record<string, string>) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...c, "Content-Type": "application/json" } });
}
