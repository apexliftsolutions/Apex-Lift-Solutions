// POST /payment-events   — called by the payment provider, not by the browser.
// (Provider requires the delivery URL not contain its name.)
//
// This is the ONLY code path that can mark an invoice paid automatically.
// It trusts nothing in the body until the HMAC signature verifies, and it
// re-fetches the transaction from Helcim before writing anything.
//
// Helcim signature scheme (Standard Webhooks):
//   signed  = `${webhook-id}.${webhook-timestamp}.${rawBody}`
//   key     = base64-decode(HELCIM_WEBHOOK_VERIFIER_TOKEN)
//   sig     = base64(HMAC-SHA256(key, signed))
//   header  = "v1,<sig> v2,<sig>"  — any entry may match
import { createClient } from "jsr:@supabase/supabase-js@2";

const HELCIM_API = "https://api.helcim.com/v2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const rawBody   = await req.text();
  const whId      = req.headers.get("webhook-id") ?? "";
  const whTs      = req.headers.get("webhook-timestamp") ?? "";
  const whSigHdr  = req.headers.get("webhook-signature") ?? "";

  if (!whId || !whTs || !whSigHdr) return new Response("Missing signature headers", { status: 400 });

  // ── 1. Replay window: reject anything older than 5 minutes ─────────────────
  const ageSec = Math.abs(Date.now() / 1000 - Number(whTs));
  if (!Number.isFinite(ageSec) || ageSec > 300) return new Response("Stale", { status: 400 });

  // ── 2. HMAC verification ────────────────────────────────────────────────────
  const verifierB64 = Deno.env.get("HELCIM_WEBHOOK_VERIFIER_TOKEN")!;
  const keyBytes = Uint8Array.from(atob(verifierB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${whId}.${whTs}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  const presented = whSigHdr.split(" ").map((s) => s.split(",")[1] ?? "");
  if (!presented.some((s) => timingSafeEqual(s, expected))) {
    return new Response("Bad signature", { status: 401 });
  }

  // ── 3. Idempotency: same webhook-id twice is a no-op ────────────────────────
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch { return new Response("Bad JSON", { status: 400 }); }
  const eventType = String(payload.type ?? "");

  const { error: dupErr } = await sb.from("payment_webhook_events")
    .insert({ webhook_id: whId, event_type: eventType, payload });
  if (dupErr) return new Response("ok (duplicate)", { status: 200 });   // already processed

  // ── 4. Only card/ACH transaction events matter to us ───────────────────────
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const txnId = String(data.id ?? data.transactionId ?? "");
  if (!txnId || !/cardTransaction|bankTransaction|transaction/i.test(eventType)) {
    await markProcessed(sb, whId, `ignored:${eventType}`);
    return new Response("ok", { status: 200 });
  }

  // ── 5. Never trust the webhook body for money. Re-fetch from Helcim. ───────
  const isBank = /bank/i.test(eventType);
  const path = isBank ? `bank-transactions/${txnId}` : `card-transactions/${txnId}`;
  const tRes = await fetch(`${HELCIM_API}/${path}`, {
    headers: { "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, "accept": "application/json" },
  });
  if (!tRes.ok) { await markProcessed(sb, whId, `fetch_failed:${tRes.status}`); return new Response("ok", { status: 200 }); }
  const txn = await tRes.json();

  const status   = String(txn.status ?? "").toUpperCase();
  const approved = status === "APPROVED";
  const txnCents = Math.round(Number(txn.amount ?? 0) * 100);
  const currency = String(txn.currency ?? "USD").toUpperCase();

  // ── 6. Link to our payment row via the invoiceNumber we set at checkout ────
  //    (that is OUR invoice id, e.g. INV-3F9A2C1B7D). Nothing else is trusted.
  const invoiceId = String(txn.invoiceNumber ?? "");
  const { data: pay } = await sb.from("payments")
    .select("*").eq("invoice_id", invoiceId).eq("provider", "helcim")
    .in("status", ["initiated", "pending", "unknown"]).maybeSingle();

  if (!pay) {
    // Could be a terminal/manual Helcim payment with no portal checkout. Record it,
    // but do not auto-mark the invoice: admin reconciles manually.
    await markProcessed(sb, whId, `no_matching_attempt:${invoiceId}`);
    return new Response("ok", { status: 200 });
  }

  // ── 7. Amount and currency MUST match what we resolved server-side ─────────
  if (txnCents !== Number(pay.amount_cents) || currency !== pay.currency) {
    await sb.from("payments").update({ status: "unknown", failure_category: "amount_mismatch",
      provider_transaction_id: txnId, completed_at: new Date().toISOString() }).eq("id", pay.id);
    await sb.from("payment_events").insert({ payment_id: pay.id, invoice_id: pay.invoice_id, source: "webhook",
      event: "amount_mismatch", detail: { expected: pay.amount_cents, got: txnCents, currency } });
    await markProcessed(sb, whId, `amount_mismatch ${txnCents}!=${pay.amount_cents}`);
    return new Response("ok", { status: 200 });
  }

  // ── 8. Write the outcome ────────────────────────────────────────────────────
  // Card:  APPROVED is final → succeeded.
  // ACH:   APPROVED at initiation is NOT settlement. It stays 'pending' until
  //        the provider reports the bank transaction cleared (a later webhook
  //        or the reconcile job). Only a cleared/settled state → succeeded.
  const achSettled = isBank && /settl|clear|complet/i.test(String(txn.bankStatus ?? txn.settlementStatus ?? ""));
  const newStatus = !approved ? "failed" : (isBank && !achSettled) ? "pending" : "succeeded";
  const now = new Date().toISOString();
  await sb.from("payments").update({
    status: newStatus,
    provider_transaction_id: txnId,
    method: isBank ? "ach" : "card",
    method_display: mask(txn),
    failure_category: approved ? null : "declined",
    approved_at: approved ? (pay.approved_at ?? now) : pay.approved_at,
    settled_at:  newStatus === "succeeded" ? now : null,
    declined_at: approved ? null : now,
    completed_at: newStatus === "pending" ? null : now,
  }).eq("id", pay.id);
  await sb.from("payment_events").insert({ payment_id: pay.id, invoice_id: pay.invoice_id, source: "webhook",
    event: newStatus === "succeeded" ? "settled" : newStatus === "pending" ? "pending" : "declined",
    detail: { txn_id: txnId, event_type: eventType, ach: isBank } });

  await sb.rpc("recalc_invoice_status", { p_invoice_id: pay.invoice_id });
  if (newStatus === "succeeded") {
    await sb.from("invoices").update({ paid_via: "helcim", payment_id: pay.id }).eq("id", pay.invoice_id);
    await sb.from("activity_log").insert({ action: "invoice_paid",
      detail: `${pay.invoice_id} paid via ${isBank ? "ACH" : "card"} — txn ${txnId}` });
  }

  await markProcessed(sb, whId, newStatus);
  return new Response("ok", { status: 200 });
});

async function markProcessed(sb: ReturnType<typeof createClient>, id: string, result: string) {
  await sb.from("payment_webhook_events").update({ processed_at: new Date().toISOString(), result }).eq("webhook_id", id);
}
function mask(t: Record<string, string>): string | null {
  if (t.cardNumber)        return `${t.cardType ?? "Card"} ····${String(t.cardNumber).slice(-4)}`;
  if (t.bankAccountNumber) return `Bank ····${String(t.bankAccountNumber).slice(-4)}`;
  return null;
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
