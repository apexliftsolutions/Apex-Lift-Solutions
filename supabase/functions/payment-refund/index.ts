// POST /payment-refund   body: { payment_id, amount?, reason? }   — ADMIN ONLY
// Uses the separate HELCIM_ADMIN_API_TOKEN (Transaction Processing: Admin).
// The checkout token deliberately cannot do this.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { helcimCall, paymentIdempotencyKey, PATH_REFUND, PATH_REVERSE } from "../_shared/helcim-api.ts";

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": Deno.env.get("PUBLIC_SITE_URL") ?? "https://apexliftsolutionsusa.com",
                 "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user || user.email !== "admin@apexliftsolutionsusa.com") return j({ error: "forbidden" }, 403, cors);

  const { payment_id, amount, reason } = await req.json();
  if (!payment_id) return j({ error: "bad_request" }, 400, cors);

  // The original must be OUR record — never accept an arbitrary provider txn id.
  const { data: orig } = await sb.from("payments").select("*").eq("id", payment_id).eq("kind", "payment").maybeSingle();
  if (!orig) return j({ error: "not_found" }, 404, cors);
  if (orig.status !== "succeeded" || orig.provider !== "helcim" || !orig.provider_transaction_id) {
    return j({ error: "not_refundable" }, 409, cors);
  }

  // Refundable = original minus prior succeeded refunds.
  const { data: prior } = await sb.from("payments").select("amount_cents").eq("refund_of", orig.id).eq("status", "succeeded");
  const refunded = (prior ?? []).reduce((s, r) => s + Number(r.amount_cents), 0);
  // Helcim's ACH docs allow a refund "equal to or less than the original
  // amount", so partial ACH refunds are supported. The only ceiling we enforce
  // is the un-refunded remainder; Helcim itself is the final authority.
  const want = amount != null ? Math.round(Number(amount) * 100) : Number(orig.amount_cents) - refunded;
  if (!(want > 0) || want > Number(orig.amount_cents) - refunded) return j({ error: "amount_exceeds_refundable" }, 400, cors);

  // Payment API accepts 25-36 chars including hyphens; Helcim recommends UUID.
  // A Refund/Reverse must still use a NEW key, never the purchase's key.
  const idem = paymentIdempotencyKey();
  const { data: ref, error: insErr } = await sb.from("payments").insert({
    invoice_id: orig.invoice_id, customer_id: orig.customer_id, provider: "helcim", kind: "refund",
    method: orig.method, amount_cents: want, currency: orig.currency, status: "initiated",
    idempotency_key: idem, refund_of: orig.id, notes: reason ?? null, recorded_by: user.id,
  }).select().single();
  if (insErr) return j({ error: "ledger_error" }, 500, cors);

  const isBank = orig.method === "ach";
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
  const fullAmount = want === Number(orig.amount_cents) - refunded;

  // Reverse cancels a transaction while its card batch is still OPEN, and only
  // for the FULL amount. Refund works once the batch has CLOSED and supports
  // partials. We cannot see the batch state, so try reverse for a full-amount
  // cancellation and fall back to refund.
  let r;
  let action: "reverse" | "refund" = "refund";

  if (!isBank && fullAmount) {
    r = await helcimCall(PATH_REVERSE, Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, {
      method: "POST", idem,
      body: { cardTransactionId: Number(orig.provider_transaction_id), ipAddress: ip },
    });
    if (r.ok) action = "reverse";
  }

  if (!r || !r.ok) {
    // A fresh key: Helcim returns 409 if the same key is reused with a
    // different payload.
    r = await helcimCall(PATH_REFUND, Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, {
      method: "POST", idem: paymentIdempotencyKey(),
      body: {
        originalTransactionId: Number(orig.provider_transaction_id),
        amount: Number((want / 100).toFixed(2)),
        ipAddress: ip,
      },
    });
    action = "refund";
  }

  const out = (r.body ?? {}) as Record<string, string>;
  const ok = r.ok && /APPROV/i.test(String(out?.status ?? ""));
  const now = new Date().toISOString();

  // An auth failure is a configuration problem, not a declined refund.
  if (!ok && (r.category === "auth" || r.category === "permission")) {
    await sb.from("payments").update({ status: "failed",
      failure_category: `helcim_${r.category}`, completed_at: now }).eq("id", ref.id);
    await sb.from("payment_events").insert({ payment_id: ref.id, invoice_id: orig.invoice_id,
      event: "declined", source: "admin",
      detail: { action, http: r.httpStatus, category: r.category,
                note: "HELCIM_ADMIN_API_TOKEN is missing or lacks permission — this is a configuration issue, not a declined refund" } });
    return j({ error: "provider_auth_failed",
      message: "Helcim rejected the request as unauthorized. The admin API token is missing or lacks Transaction Processing permission." }, 502, cors);
  }

  await sb.from("payments").update({
    status: ok ? "succeeded" : "failed",
    kind: action === "reverse" ? "reversal" : "refund",
    provider_transaction_id: out?.transactionId ?? null,
    failure_category: ok ? null : `${action}_declined`,
    approved_at: ok ? now : null, settled_at: ok ? now : null, completed_at: now,
  }).eq("id", ref.id);
  await sb.from("payment_events").insert({ payment_id: ref.id, invoice_id: orig.invoice_id, source: "admin",
    event: ok ? (action === "reverse" ? "reversed" : "refunded") : "declined",
    detail: { action, refund_of: orig.id, amount_cents: want, http: r.httpStatus,
              category: r.category, provider_status: out?.status ?? null } });
  if (ok) await sb.rpc("recalc_invoice_status", { p_invoice_id: orig.invoice_id });
  await sb.from("activity_log").insert({ actor_id: user.id,
    action: ok ? `payment_${action}ed` : `${action}_failed`,
    detail: `${orig.invoice_id} $${(want/100).toFixed(2)}` });

  return j(ok ? { ok: true, action, refund_id: ref.id, amount_cents: want }
              : { error: `${action}_declined`, http: r.httpStatus }, ok ? 200 : 502, cors);
});
function j(b: unknown, s: number, c: Record<string,string>) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...c, "Content-Type": "application/json" } });
}
