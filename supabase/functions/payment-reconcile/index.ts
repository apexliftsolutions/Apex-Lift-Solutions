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
    const found = await findHelcimTxn({
      amount_cents: Number(p.amount_cents), currency: String(p.currency),
      initiated_at: String(p.initiated_at),
    });

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

    // No single unambiguous approved transaction. Before voiding, make sure we
    // are not throwing away a charge we simply could not identify: only void
    // attempts old enough that a real payment would certainly have appeared.
    if (Date.now() - new Date(String(p.initiated_at)).getTime() < 6 * 60 * 60_000) {
      continue;   // too recent to be sure — leave it and re-check next run
    }
    // Helcim shows no matching transaction. Nothing was charged.
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
    const r = await fetch(`${HELCIM_API}/ach/transactions/${p.provider_transaction_id}`, {
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

// Ask Helcim whether a transaction exists for this attempt.
//
// We do NOT send an invoiceNumber at checkout (see payment-checkout for why), so
// matching is done on the transaction itself. Documented approach: "calling the
// Collect Card Transaction endpoint with relevant query parameters to filter
// returned transactions down to the correct one. This could include a
// combination of values returned by Helcim.js, such as the date ... and amount."
//
// This is deliberately conservative. It returns a transaction ONLY when exactly
// one approved candidate matches the amount inside the window. Two candidates,
// or none, means a human decides -- we never guess which charge belongs to which
// invoice.
async function findHelcimTxn(
  attempt: { amount_cents: number; currency: string; initiated_at: string },
): Promise<Record<string, string> | null> {
  const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN")!;
  const started = new Date(attempt.initiated_at).getTime();
  // Checkout tokens live 60 minutes; allow a little either side.
  const dateStart = new Date(started - 10 * 60_000).toISOString().slice(0, 10);
  const dateEnd   = new Date(started + 75 * 60_000).toISOString().slice(0, 10);

  const base = Number(attempt.amount_cents);
  const ceiling = Math.max(Math.ceil(base * 0.10), 200);   // room for Fee Saver

  const hits: Record<string, string>[] = [];
  for (const seg of ["card-transactions", "ach/transactions"]) {
    try {
      const r = await fetch(
        `${HELCIM_API}/${seg}?dateStart=${dateStart}&dateEnd=${dateEnd}`,
        { headers: { "api-token": token, accept: "application/json" } });
      if (!r.ok) continue;
      const body = await r.json().catch(() => null);
      const list = Array.isArray(body) ? body : (body ? [body] : []);
      for (const t of list) {
        if (!/APPROV/i.test(String(t?.status ?? ""))) continue;
        if (String(t?.currency ?? "").toUpperCase() !== String(attempt.currency).toUpperCase()) continue;
        const cents = Math.round(Number(t?.amount ?? 0) * 100);
        if (cents < base || cents - base > ceiling) continue;
        // Must fall inside the actual checkout window, not just the same day.
        const when = new Date(String(t?.dateCreated ?? "").replace(" ", "T")).getTime();
        if (!Number.isFinite(when) || when < started - 10 * 60_000 || when > started + 75 * 60_000) continue;
        hits.push(t);
      }
    } catch { /* try the other rail */ }
  }

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    console.warn("[payment-reconcile] ambiguous match — leaving for manual review",
      { candidates: hits.length, base_cents: base });
  }
  return null;
}
