// Scheduled. Re-checks every ACH payment stuck in 'pending' against the
// provider's authoritative transaction record. Webhooks may not carry a final
// settlement event; this is the safety net. Also expires stale 'initiated'
// checkouts that were never completed (token lifetime is 60 min).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileAmount } from "../_shared/feesaver.ts";
const HELCIM_API = "https://api.helcim.com/v2";

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-key") !== Deno.env.get("RECONCILE_WORKER_KEY")) return new Response("Forbidden", { status: 403 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date().toISOString();

  // ── 1. Stale 'initiated' attempts ──────────────────────────────────────────
  // These are NOT automatically abandoned. Helcim may have taken the money and
  // the browser may simply have died before payment-validate ran. Voiding one
  // blindly discards a real charge, so we ask Helcim first and only void when
  // the provider confirms nothing happened.
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  const { data: stale } = await sb.from("payments")
    .select("id, invoice_id, amount_cents, currency, customer_id, initiated_at")
    .eq("status", "initiated").eq("provider", "helcim").eq("kind", "payment")
    .lt("initiated_at", cutoff).limit(50);

  let recovered = 0, voided = 0;
  for (const p of stale ?? []) {
    const found = await findHelcimTxn(String(p.invoice_id));

    if (found && /APPROV/i.test(String(found.status ?? ""))) {
      // Money moved. Reconcile it instead of throwing it away.
      const isBank = /ach|bank/i.test(String(found.type ?? "")) || !!found.bankAccountNumber;
      const chargedCents = Math.round(Number(found.amount ?? 0) * 100);
      const rec = await reconcileAmount(sb, {
        baseCents: Number(p.amount_cents), chargedCents,
        currency: String(found.currency ?? "").toUpperCase(),
        expectedCurrency: String(p.currency), isACH: isBank,
      });

      if (!rec.ok) {
        // Real transaction, but it does not match. A human must look.
        await sb.from("payments").update({ status: "unknown",
          failure_category: `amount_${rec.reason}`,
          provider_transaction_id: String(found.transactionId ?? found.id ?? ""),
          total_charged_cents: chargedCents, completed_at: now }).eq("id", p.id);
        await sb.from("payment_events").insert({ payment_id: p.id, invoice_id: p.invoice_id,
          event: "amount_mismatch", source: "reconcile",
          detail: { reason: rec.reason, base_cents: rec.baseCents, charged_cents: chargedCents } });
        continue;
      }

      const settledNow = !isBank ||
        /settl|clear|complet/i.test(String(found.bankStatus ?? found.settlementStatus ?? ""));
      await sb.from("payments").update({
        status: settledNow ? "succeeded" : "pending",
        provider_transaction_id: String(found.transactionId ?? found.id ?? ""),
        method: isBank ? "ach" : "card",
        method_display: found.cardNumber
          ? `${found.cardType ?? "Card"} ····${String(found.cardNumber).slice(-4)}`
          : found.bankAccountNumber ? `Bank ····${String(found.bankAccountNumber).slice(-4)}` : null,
        fee_cents: rec.feeCents, total_charged_cents: rec.totalCents,
        approved_at: now, settled_at: settledNow ? now : null,
        completed_at: settledNow ? now : null, failure_category: null,
      }).eq("id", p.id);
      await sb.from("payment_events").insert({ payment_id: p.id, invoice_id: p.invoice_id,
        event: settledNow ? "recovered_settled" : "recovered_pending", source: "reconcile",
        detail: { txn_id: found.transactionId ?? found.id, ach: isBank,
                  base_cents: rec.baseCents, fee_cents: rec.feeCents, charged_cents: rec.totalCents,
                  note: "browser never completed validation; recovered from provider" } });
      await sb.rpc("recalc_invoice_status", { p_invoice_id: p.invoice_id });
      if (settledNow) {
        await sb.from("invoices").update({ paid_via: "helcim", payment_id: p.id }).eq("id", p.invoice_id);
      }
      recovered++;
      continue;
    }

    // Helcim has no transaction for this invoice. Nothing was charged.
    // Only now is it safe to void, freeing the in-flight index for a retry.
    await sb.from("payments").update({ status: "voided", failure_category: "abandoned",
      completed_at: now }).eq("id", p.id).eq("status", "initiated");
    await sb.rpc("recalc_invoice_status", { p_invoice_id: p.invoice_id });
    await sb.from("payment_events").insert({ payment_id: p.id, invoice_id: p.invoice_id,
      event: "voided", source: "reconcile",
      detail: { reason: "no_provider_transaction", checked_helcim: true } });
    voided++;
  }

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
  return Response.json({ stale_checked: stale?.length ?? 0, recovered, voided, ach_checked: pend?.length ?? 0, settled, declined });
});

// Ask Helcim whether a transaction exists for this invoice number.
// Documented: "The Get card transactions endpoint can be used to pull transaction
// details with the invoiceNumber provided as a query parameter."
async function findHelcimTxn(invoiceNumber: string): Promise<Record<string, string> | null> {
  const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN")!;
  for (const seg of ["card-transactions", "bank-transactions"]) {
    try {
      const r = await fetch(
        `${HELCIM_API}/${seg}?invoiceNumber=${encodeURIComponent(invoiceNumber)}`,
        { headers: { "api-token": token, accept: "application/json" } });
      if (!r.ok) continue;
      const body = await r.json().catch(() => null);
      const list = Array.isArray(body) ? body : (body ? [body] : []);
      // Prefer an approved one; a declined attempt must not settle an invoice.
      const hit = list.find((t: Record<string, string>) => /APPROV/i.test(String(t?.status ?? "")));
      if (hit) return hit;
    } catch { /* try the other rail */ }
  }
  return null;
}
