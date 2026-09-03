// POST /payment-refund   body: { payment_id, amount?, reason? }   — ADMIN ONLY
// Uses the separate HELCIM_ADMIN_API_TOKEN (Transaction Processing: Admin).
// The checkout token deliberately cannot do this.
import { createClient } from "jsr:@supabase/supabase-js@2";
const HELCIM_API = "https://api.helcim.com/v2";

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
  const want = amount != null ? Math.round(Number(amount) * 100) : Number(orig.amount_cents) - refunded;
  if (!(want > 0) || want > Number(orig.amount_cents) - refunded) return j({ error: "amount_exceeds_refundable" }, 400, cors);

  const idem = crypto.randomUUID();
  const { data: ref, error: insErr } = await sb.from("payments").insert({
    invoice_id: orig.invoice_id, customer_id: orig.customer_id, provider: "helcim", kind: "refund",
    method: orig.method, amount_cents: want, currency: orig.currency, status: "initiated",
    idempotency_key: idem, refund_of: orig.id, notes: reason ?? null, recorded_by: user.id,
  }).select().single();
  if (insErr) return j({ error: "ledger_error" }, 500, cors);

  const isBank = orig.method === "ach";
  const r = await fetch(`${HELCIM_API}/payment/${isBank ? "bank-refund" : "refund"}`, {
    method: "POST",
    headers: { "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, "idempotency-key": idem,
               "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ originalTransactionId: orig.provider_transaction_id, amount: Number((want / 100).toFixed(2)),
                           currency: orig.currency, ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0] ?? "0.0.0.0" }),
  });
  const out = await r.json().catch(() => ({}));
  const ok = r.ok && String(out?.status ?? "").toUpperCase() === "APPROVED";
  const now = new Date().toISOString();

  await sb.from("payments").update({
    status: ok ? "succeeded" : "failed", provider_transaction_id: out?.transactionId ?? null,
    failure_category: ok ? null : "refund_declined", approved_at: ok ? now : null, settled_at: ok ? now : null, completed_at: now,
  }).eq("id", ref.id);
  await sb.from("payment_events").insert({ payment_id: ref.id, invoice_id: orig.invoice_id, source: "admin",
    event: ok ? "refunded" : "declined", detail: { refund_of: orig.id, amount_cents: want, http: r.status } });
  if (ok) await sb.rpc("recalc_invoice_status", { p_invoice_id: orig.invoice_id });
  await sb.from("activity_log").insert({ actor_id: user.id, action: ok ? "payment_refunded" : "refund_failed",
    detail: `${orig.invoice_id} $${(want/100).toFixed(2)}` });

  return j(ok ? { ok: true, refund_id: ref.id } : { error: "refund_declined" }, ok ? 200 : 502, cors);
});
function j(b: unknown, s: number, c: Record<string,string>) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...c, "Content-Type": "application/json" } });
}
