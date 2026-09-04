// Scheduled. Re-checks every ACH payment stuck in 'pending' against the
// provider's authoritative transaction record. Webhooks may not carry a final
// settlement event; this is the safety net. Also expires stale 'initiated'
// checkouts that were never completed (token lifetime is 60 min).
import { createClient } from "jsr:@supabase/supabase-js@2";
const HELCIM_API = "https://api.helcim.com/v2";

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-key") !== Deno.env.get("RECONCILE_WORKER_KEY")) return new Response("Forbidden", { status: 403 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date().toISOString();

  // 1. Abandoned checkouts → failed (no charge ever happened).
  const cutoff = new Date(Date.now() - 90 * 60_000).toISOString();
  // 'voided' (not 'failed') so the partial unique index frees up and the
  // customer can simply try again.
  await sb.from("payments").update({ status: "voided", failure_category: "abandoned", completed_at: now })
    .eq("status", "initiated").eq("provider", "helcim").lt("initiated_at", cutoff);

  // 2. Pending ACH → ask the provider.
  const { data: pend } = await sb.from("payments").select("*")
    .eq("provider", "helcim").eq("method", "ach").eq("status", "pending").not("provider_transaction_id", "is", null).limit(50);

  let settled = 0, declined = 0;
  for (const p of pend ?? []) {
    const r = await fetch(`${HELCIM_API}/bank-transactions/${p.provider_transaction_id}`, {
      headers: { "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, "accept": "application/json" } });
    if (!r.ok) continue;
    const t = await r.json();
    const st = String(t.bankStatus ?? t.settlementStatus ?? t.status ?? "").toUpperCase();
    let next: string | null = null;
    if (/SETTL|CLEAR|COMPLET/.test(st)) next = "succeeded";
    else if (/DECLIN|RETURN|REJECT|FAIL/.test(st)) next = "failed";
    if (!next) continue;

    // ACH carries no convenience fee, so charged == base by definition here.
    await sb.from("payments").update({ status: next, settled_at: next === "succeeded" ? now : null,
      declined_at: next === "failed" ? now : null, completed_at: now,
      fee_cents: 0, total_charged_cents: p.amount_cents,
      failure_category: next === "failed" ? "ach_returned" : null }).eq("id", p.id);
    await sb.from("payment_events").insert({ payment_id: p.id, invoice_id: p.invoice_id, source: "reconcile",
      event: next === "succeeded" ? "settled" : "declined", detail: { provider_status: st } });
    await sb.rpc("recalc_invoice_status", { p_invoice_id: p.invoice_id });
    if (next === "succeeded") { await sb.from("invoices").update({ paid_via: "helcim", payment_id: p.id }).eq("id", p.invoice_id); settled++; } else declined++;
  }
  return Response.json({ checked: pend?.length ?? 0, settled, declined });
});
