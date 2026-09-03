// POST /payment-checkout   body: { invoice_id, method, idempotency_key }
// Browser sends an invoice id. The amount comes from the database. Returns only
// the checkoutToken; the secretToken stays in the private schema.
import { createClient } from "jsr:@supabase/supabase-js@2";
const HELCIM_INIT = "https://api.helcim.com/v2/helcim-pay/initialize";

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin":  Deno.env.get("APP_BASE_URL") ?? "https://apexliftsolutionsusa.com",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return j({ error: "unauthorized" }, 401, cors);

  const { invoice_id, method = "cc-ach", idempotency_key } = await req.json();
  if (!invoice_id || !idempotency_key) return j({ error: "bad_request" }, 400, cors);
  if (!["cc","ach","cc-ach"].includes(method)) return j({ error: "bad_request" }, 400, cors);

  // Ownership + amount resolved here. IDOR on someone else's invoice → 404.
  // Customer must be active — a pending/inactive account cannot pay.
  const { data: cust } = await sb.from("customers").select("status").eq("id", user.id).maybeSingle();
  if (cust?.status !== "active") return j({ error: "account_not_active" }, 403, cors);

  const { data: inv } = await sb.from("invoices").select("id, amount, status, customer_id")
    .eq("id", invoice_id).eq("customer_id", user.id).maybeSingle();
  if (!inv) return j({ error: "not_found" }, 404, cors);
  if (inv.status !== "unpaid") return j({ error: inv.status === "payment_pending" ? "payment_pending" : "already_paid" }, 409, cors);
  const cents = Math.round(Number(inv.amount) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return j({ error: "invalid_amount" }, 400, cors);

  // Replayed key → return the original session, never a second chargeable one.
  const { data: existing } = await sb.from("payments").select("id, checkout_token, status")
    .eq("customer_id", user.id).eq("idempotency_key", idempotency_key).maybeSingle();
  if (existing) {
    if (!["initiated","pending"].includes(existing.status)) return j({ error: "already_processed" }, 409, cors);
    return j({ checkoutToken: existing.checkout_token, amount_cents: cents }, 200, cors);
  }

  const { data: pay, error: pErr } = await sb.from("payments").insert({
    invoice_id: inv.id, customer_id: user.id, provider: "helcim", kind: "payment",
    method: method === "ach" ? "ach" : "card", amount_cents: cents, currency: "USD",
    status: "initiated", idempotency_key, provider_invoice_number: inv.id,
  }).select().single();
  if (pErr) return j({ error: "duplicate_in_flight" }, 409, cors);   // unique index collision

  const h = await fetch(HELCIM_INIT, {
    method: "POST",
    headers: { "api-token": Deno.env.get("HELCIM_CHECKOUT_API_TOKEN")!, "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({
      paymentType: "purchase", amount: Number((cents / 100).toFixed(2)), currency: "USD",
      paymentMethod: method,
      allowPartial: 0,
      invoiceRequest: { invoiceNumber: inv.id },   // ties the Helcim txn back to OUR invoice id
    }),
  });
  if (!h.ok) {
    await sb.from("payments").update({ status: "failed", failure_category: "gateway_init_failed",
      completed_at: new Date().toISOString() }).eq("id", pay.id);
    return j({ error: "gateway_unavailable" }, 502, cors);
  }
  const { checkoutToken, secretToken } = await h.json();

  // The private schema is never exposed to the Data API. This RPC is granted to
  // service_role only, so secretToken never travels over PostgREST as a row.
  const { error: sessErr } = await sb.rpc("create_checkout_session", {
    p_checkout_token: checkoutToken, p_secret_token: secretToken, p_attempt_id: pay.id,
  });
  if (sessErr) {
    await sb.from("payments").update({ status: "failed", failure_category: "session_store_failed",
      completed_at: new Date().toISOString() }).eq("id", pay.id);
    return j({ error: "gateway_unavailable" }, 502, cors);
  }
  await sb.from("payments").update({ checkout_token: checkoutToken }).eq("id", pay.id);
  await sb.from("payment_events").insert({ payment_id: pay.id, invoice_id: inv.id, event: "checkout_created", source: "browser_validate",
    detail: { method, amount_cents: cents } });
  await sb.from("activity_log").insert({ actor_id: user.id, action: "payment_checkout_created", detail: `${inv.id} $${(cents/100).toFixed(2)} ${method}` });

  return j({ checkoutToken, amount_cents: cents }, 200, cors);
});
function j(b: unknown, s: number, c: Record<string,string>) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...c, "Content-Type": "application/json" } });
}
