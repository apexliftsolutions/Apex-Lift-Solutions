// POST /payment-events — Helcim webhook receiver, not called by the browser.
//
// Security model:
// 1. Verify Helcim's webhook HMAC signature.
// 2. Use only the webhook transaction id/type to decide what to fetch.
// 3. Re-fetch the transaction from Helcim before changing money state.
// 4. Card APPROVED -> succeeded immediately. ACH remains pending until cleared.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileAmount } from "../_shared/feesaver.ts";

const HELCIM_API = "https://api.helcim.com/v2";
type Row = Record<string, any>;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const rawBody = await req.text();
  const whId = req.headers.get("webhook-id") ?? "";
  const whTs = req.headers.get("webhook-timestamp") ?? "";
  const whSigHdr = req.headers.get("webhook-signature") ?? "";

  if (!whId || !whTs || !whSigHdr) return new Response("Missing signature headers", { status: 400 });

  const ageSec = Math.abs(Date.now() / 1000 - Number(whTs));
  if (!Number.isFinite(ageSec) || ageSec > 300) return new Response("Stale", { status: 400 });

  const verifierB64 = Deno.env.get("HELCIM_WEBHOOK_VERIFIER_TOKEN")!;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(verifierB64), (c) => c.charCodeAt(0));
  } catch {
    console.error("[payment-events] invalid webhook verifier token encoding");
    return new Response("Verifier configuration error", { status: 500 });
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${whId}.${whTs}.${rawBody}`));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  const presented = whSigHdr.split(" ").map((s) => s.split(",")[1] ?? "");

  if (!presented.some((s) => timingSafeEqual(s, expected))) {
    return new Response("Bad signature", { status: 401 });
  }

  let payload: Row;
  try { payload = JSON.parse(rawBody); } catch { return new Response("Bad JSON", { status: 400 }); }

  const eventType = String(payload.type ?? "");

  // Insert webhook id once. Only a unique-violation means duplicate; other DB
  // failures should not be silently treated as processed.
  const { error: insertErr } = await sb.from("payment_webhook_events")
  .insert({ webhook_id: whId, event_type: eventType, payload });
  if (insertErr) {
    if (insertErr.code === "23505") {
      // A prior delivery may have inserted the id but failed before it was fully
      // processed. Only short-circuit when processed_at is actually set.
      const { data: existing } = await sb.from("payment_webhook_events")
      .select("processed_at,result")
      .eq("webhook_id", whId)
      .maybeSingle();
      if (existing?.processed_at) return new Response("ok (duplicate)", { status: 200 });
      // Otherwise continue: this is a provider retry of an unfinished delivery.
    } else {
      console.error("[payment-events] webhook ledger insert failed", insertErr);
      return new Response("database error", { status: 500 });
    }
  }

  const data = (payload.data && typeof payload.data === "object" ? payload.data : {}) as Row;
  // Helcim's current standard webhook examples put the transaction id at the
  // TOP LEVEL. Keep nested fallbacks for compatibility with older shapes.
  const txnId = String(
    payload.id ?? payload.transactionId ?? data.id ?? data.transactionId ?? "",
  );

  const isAchEvent = /ach|bank/i.test(eventType);
  const isCardEvent = /card/i.test(eventType);
  const isTransactionEvent = isAchEvent || isCardEvent || /transaction/i.test(eventType);

  if (!txnId || !isTransactionEvent) {
    await markProcessed(sb, whId, `ignored:${eventType}`);
    return new Response("ok", { status: 200 });
  }

  const path = isAchEvent
  ? `ach/transactions/${encodeURIComponent(txnId)}`
  : `card-transactions/${encodeURIComponent(txnId)}`;

  const tRes = await fetch(`${HELCIM_API}/${path}`, {
    headers: {
      "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!,
                           "accept": "application/json",
    },
  });

  if (!tRes.ok) {
    // Do NOT mark processed. Returning 503 lets Helcim retry the same webhook.
    // The duplicate-id branch above will continue because processed_at is null.
    const { error: retryErr } = await sb.from("payment_webhook_events")
    .update({ result: `fetch_retry:${tRes.status}` })
    .eq("webhook_id", whId);
    if (retryErr) console.warn("[payment-events] could not record retry state", retryErr.message);
    return new Response("Provider transaction not readable yet", { status: 503 });
  }

  const txn = unwrapTxn(await tRes.json().catch(() => null));
  if (!txn) {
    await markProcessed(sb, whId, "fetch_failed:bad_json");
    return new Response("ok", { status: 200 });
  }

  const rail: "card" | "ach" = isAchEvent ? "ach" : "card";
  const txnCents = Math.round(Number(txn.amount ?? 0) * 100);
  const currency = normalizeCurrency(txn.currency);

  // Find the same Apex attempt. First choice is a transaction id already stamped
  // by payment-validate; then invoiceNumber if Helcim returned one; last, a
  // conservative recent/amount match.
  let pay: Row | null = null;

  {
    const { data: byTxn } = await sb.from("payments").select("*")
    .eq("provider", "helcim")
    .eq("provider_transaction_id", txnId)
    .limit(1)
    .maybeSingle();
    if (byTxn) pay = byTxn;
  }

  const invoiceId = String(txn.invoiceNumber ?? "");
  if (!pay && invoiceId) {
    const { data: byInvoice } = await sb.from("payments").select("*")
    .eq("invoice_id", invoiceId)
    .eq("provider", "helcim")
    .in("status", ["initiated", "pending", "unknown"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
    if (byInvoice) pay = byInvoice;
  }

  if (!pay) {
    const since = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const { data: candidates } = await sb.from("payments").select("*")
    .eq("provider", "helcim")
    .eq("kind", "payment")
    .in("status", ["initiated", "pending", "unknown"])
    .gte("initiated_at", since)
    .order("initiated_at", { ascending: false })
    .limit(25);

    const hits = (candidates ?? []).filter((c: Row) => {
      const base = Number(c.amount_cents);
      const currencyOk = !currency || currency === normalizeCurrency(c.currency);
      return currencyOk && txnCents >= base && txnCents - base <= Math.max(Math.ceil(base * 0.10), 200);
    });

    if (hits.length === 1) pay = hits[0];
    else if (hits.length > 1) {
      await markProcessed(sb, whId, `ambiguous_match:${hits.length}`);
      return new Response("ok", { status: 200 });
    }
  }

  if (!pay) {
    await markProcessed(sb, whId, `no_matching_attempt txn=${txnId} amount=${txnCents}c`);
    return new Response("ok", { status: 200 });
  }

  // If the same card payment was already finalized by payment-validate, this
  // webhook is only corroborating evidence. Do not touch a succeeded row again.
  if (String(pay.status) === "succeeded" && String(pay.provider_transaction_id ?? "") === txnId) {
    await addEvent(sb, pay, "webhook_confirmed_existing_payment", {
      txn_id: txnId,
      rail,
      event_type: eventType,
    });
    await markProcessed(sb, whId, "already_succeeded");
    return new Response("ok", { status: 200 });
  }

  // Make sure this transaction id has not already been assigned to another row.
  const { data: duplicate } = await sb.from("payments")
  .select("id,invoice_id")
  .eq("provider", "helcim")
  .eq("provider_transaction_id", txnId)
  .neq("id", pay.id)
  .limit(1)
  .maybeSingle();
  if (duplicate) {
    await addEvent(sb, pay, "webhook_duplicate_transaction", {
      txn_id: txnId,
      other_payment_id: duplicate.id,
      other_invoice_id: duplicate.invoice_id,
    });
    await markProcessed(sb, whId, "duplicate_transaction_reference");
    return new Response("ok", { status: 200 });
  }

  const rec = await reconcileAmount(sb, {
    baseCents: Number(pay.amount_cents),
                                    chargedCents: txnCents,
                                    currency,
                                    expectedCurrency: pay.currency,
                                    isACH: rail === "ach",
  });

  if (!rec.ok) {
    const { error: mismatchErr } = await sb.from("payments").update({
      status: "unknown",
      failure_category: `amount_${rec.reason}`,
      provider_transaction_id: txnId,
      total_charged_cents: txnCents,
    }).eq("id", pay.id);
    if (mismatchErr) console.error("[payment-events] mismatch write failed", mismatchErr);

    await addEvent(sb, pay, "amount_mismatch", {
      reason: rec.reason,
      base_cents: rec.baseCents,
      charged_cents: rec.totalCents,
      implied_fee_cents: rec.impliedFeeCents,
      currency,
      ach: rail === "ach",
    });
    await markProcessed(sb, whId, `amount_${rec.reason}`);
    return new Response("ok", { status: 200 });
  }

  let newStatus: "succeeded" | "pending" | "failed" | null = null;
  if (rail === "card") {
    const status = String(txn.status ?? "").toUpperCase();
    if (status === "APPROVED" || status === "APPROVAL") newStatus = "succeeded";
    else if (/DECLIN|FAIL|CANCEL|VOID/.test(status)) newStatus = "failed";
  } else {
    if (isAchCleared(txn)) newStatus = "succeeded";
    else if (isAchFailed(txn)) newStatus = "failed";
    else newStatus = "pending";
  }

  if (!newStatus) {
    await addEvent(sb, pay, "webhook_unrecognized_status", {
      txn_id: txnId,
      event_type: eventType,
      provider_status: rail === "ach"
      ? { auth: txn.statusAuth ?? null, clearing: txn.statusClearing ?? null }
      : txn.status ?? null,
    });
    await markProcessed(sb, whId, "unrecognized_status");
    return new Response("ok", { status: 200 });
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await sb.from("payments").update({
    status: newStatus,
    provider_transaction_id: txnId,
    method: rail === "ach" ? "ach" : "card",
    method_display: mask(txn),
                                                                fee_cents: rec.feeCents,
                                                                total_charged_cents: rec.totalCents,
                                                                failure_category: newStatus === "failed" ? (rail === "ach" ? "ach_failed" : "declined") : null,
                                                                approved_at: newStatus !== "failed" ? (pay.approved_at ?? now) : pay.approved_at,
                                                                settled_at: rail === "ach" && newStatus === "succeeded" ? now : pay.settled_at ?? null,
                                                                declined_at: newStatus === "failed" ? now : null,
                                                                completed_at: newStatus === "pending" ? null : now,
  }).eq("id", pay.id);

  if (updateErr) {
    console.error("[payment-events] payment update failed", updateErr);
    await addEvent(sb, pay, "persist_failed", {
      step: "webhook_payment_update",
      db_error: updateErr.message,
      code: updateErr.code,
    });
    await markProcessed(sb, whId, "persist_failed");
    return new Response("ok", { status: 200 });
  }

  await addEvent(sb, pay,
                 newStatus === "succeeded" ? "webhook_succeeded" : newStatus === "pending" ? "webhook_pending" : "webhook_failed",
                 {
                   txn_id: txnId,
                   event_type: eventType,
                   rail,
                   base_cents: rec.baseCents,
                   fee_cents: rec.feeCents,
                   charged_cents: rec.totalCents,
                 });

  const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: pay.invoice_id });
  if (recalcErr) {
    console.error("[payment-events] invoice recalc failed", recalcErr);
    await addEvent(sb, pay, "persist_failed", {
      step: "webhook_invoice_recalc",
      db_error: recalcErr.message,
      code: recalcErr.code,
    });
    await markProcessed(sb, whId, "invoice_recalc_failed");
    return new Response("ok", { status: 200 });
  }

  if (newStatus === "succeeded") {
    const { error: linkErr } = await sb.from("invoices")
    .update({ paid_via: "helcim", payment_id: pay.id })
    .eq("id", pay.invoice_id);
    if (linkErr) console.error("[payment-events] invoice link failed", linkErr);

    const { error: activityErr } = await sb.from("activity_log").insert({
      action: "invoice_paid",
      detail: `${pay.invoice_id} paid via ${rail === "ach" ? "ACH" : "card"} — txn ${txnId}`,
    });
    if (activityErr) console.warn("[payment-events] activity log write failed", activityErr.message);
  }

  await markProcessed(sb, whId, newStatus);
  return new Response("ok", { status: 200 });
});

function unwrapTxn(raw: unknown): Row | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Row;
  if (root.transaction && typeof root.transaction === "object") return root.transaction as Row;
  if (root.data && typeof root.data === "object") {
    const d = root.data as Row;
    if (d.transaction && typeof d.transaction === "object") return d.transaction as Row;
    if (d.data && typeof d.data === "object") return d.data as Row;
    return d;
  }
  return root;
}

function isAchCleared(txn: Row): boolean {
  const clearing = String(txn.statusClearing ?? txn.settlementStatus ?? txn.bankStatus ?? "").toUpperCase();
  const auth = String(txn.statusAuth ?? txn.status ?? "").toUpperCase();
  return ["1", "CLEARED", "SETTLED", "COMPLETED", "COMPLETE"].includes(clearing)
  && !["2", "4", "DECLINED", "CANCELLED", "FAILED"].includes(auth);
}

function isAchFailed(txn: Row): boolean {
  const clearing = String(txn.statusClearing ?? txn.settlementStatus ?? txn.bankStatus ?? "").toUpperCase();
  const auth = String(txn.statusAuth ?? txn.status ?? "").toUpperCase();
  return ["2", "4", "DECLINED", "CANCELLED", "FAILED"].includes(auth)
  || ["4", "REJECTED", "RETURNED", "CONTESTED", "DECLINED", "FAILED"].includes(clearing);
}

function normalizeCurrency(v: unknown): string {
  const s = String(v ?? "").toUpperCase();
  if (s === "1") return "CAD";
  if (s === "2") return "USD";
  return s;
}

function mask(t: Row): string | null {
  if (t.cardNumber) return `${t.cardType ?? "Card"} ····${String(t.cardNumber).slice(-4)}`;
  if (t.bankAccountNumber) return `Bank ····${String(t.bankAccountNumber).slice(-4)}`;
  if (t.bankAccountL4L4) return `Bank ····${String(t.bankAccountL4L4).slice(-4)}`;
  return null;
}

async function addEvent(sb: ReturnType<typeof createClient>, pay: Row, event: string, detail: unknown) {
  const { error } = await sb.from("payment_events").insert({
    payment_id: pay.id,
    invoice_id: pay.invoice_id,
    source: "webhook",
    event,
    detail,
  });
  if (error) console.warn("[payment-events] payment_events insert failed", event, error.message);
}

async function markProcessed(sb: ReturnType<typeof createClient>, id: string, result: string) {
  const { error } = await sb.from("payment_webhook_events")
  .update({ processed_at: new Date().toISOString(), result })
  .eq("webhook_id", id);
  if (error) console.warn("[payment-events] markProcessed failed", id, error.message);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
