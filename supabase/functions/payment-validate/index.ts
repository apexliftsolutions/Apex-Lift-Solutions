// POST /payment-validate   body: { checkoutToken, rawDataResponse, hash }
//
// Two independent gates before any financial write:
//
//   GATE 1 — INTEGRITY.  Per Helcim's HelcimPay.js validation spec, the hash is
//            sha256( JSON.stringify(response.data) + secretToken ). The
//            secretToken never leaves this server, so a browser that tampered
//            with the response cannot produce a matching hash.
//
//   GATE 2 — AUTHORITY.  A matching hash only proves the payload wasn't edited
//            in transit. It does NOT prove a transaction exists, was approved,
//            or was for the right amount. So we re-fetch the transaction
//            server-to-server from Helcim and decide from THAT, ignoring every
//            status/amount field the browser sent.
//
// The browser event never marks an invoice paid. It only asks the server to go
// and check. Invoice state is then derived from the ledger by recalc_invoice_status().
import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileAmount, looksACH } from "../_shared/feesaver.ts";
import { normalizeHelcimPayResponse } from "../_shared/helcimpay.ts";

// Bumped on every change. It lands in payment_events so a stale Edge Function
// deploy is visible in the data instead of being guessed at.
const FN_VERSION = "2026-09-05.v18";

const HELCIM_API = "https://api.helcim.com/v2";

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

  const { checkoutToken, eventMessage, rawDataResponse, hash, clientVersion } = await req.json().catch(() => ({}));
  if (!checkoutToken) {
    console.error("[payment-validate] bad request: no checkoutToken");
    return j({ error: "bad_request" }, 400, cors);
  }

  // Read through a service-role-only SECURITY DEFINER function. The `private`
  // schema is not in the Data API's exposed schemas, so there is no browser path
  // to secret_token at all.
  const { data: sess, error: sessErr } = await sb.rpc("read_checkout_session",
    { p_checkout_token: checkoutToken }).maybeSingle();
  if (!sess) {
    // Leave a trail even here. Previously this exit was silent, which meant a
    // failed validation was indistinguishable from validation never running.
    console.error("[payment-validate] unknown checkout session", { checkoutToken, sessErr });
    await sb.from("payment_events").insert({ event: "validation_failed", source: "browser_validate",
      detail: { reason: "unknown_checkout_session", checkout_token: checkoutToken,
                db_error: sessErr?.message ?? null } });
    return j({ error: "unknown_session" }, 404, cors);
  }

  const { data: pay } = await sb.from("payments").select("*").eq("id", sess.attempt_id).single();
  if (!pay) {
    await sb.from("payment_events").insert({ event: "validation_failed", source: "browser_validate",
      detail: { reason: "attempt_row_missing", attempt_id: sess.attempt_id } });
    return j({ error: "unknown_session" }, 404, cors);
  }
  if (pay.customer_id !== user.id) {
    await ev(sb, pay, "validation_failed", "browser_validate", { reason: "ownership_mismatch" });
    return j({ error: "forbidden" }, 403, cors);
  }

  // First thing we can attribute to this payment: proof validation actually ran.
  // Normalize server-side. The browser's own extraction is advisory only --
  // depending on it is what produced "no_transaction_id" on a real payment.
  const hp = normalizeHelcimPayResponse(eventMessage ?? rawDataResponse);
  await ev(sb, pay, "validation_started", "browser_validate", {
    fn_version: FN_VERSION,
    client_version: typeof clientVersion === "string" ? clientVersion : null,
    ...hp.shape,
    browser_sent_hash: !!hash,
    browser_sent_raw: !!rawDataResponse,
    server_found_txn_id: !!hp.transactionId,
  });

  // Replay guard — a settled attempt is reported back, never re-processed.
  if (!["initiated", "pending"].includes(pay.status)) {
    return j(view(pay), 200, cors);
  }

  // ── GATE 1: integrity (ADVISORY) ───────────────────────────────────────────
  // The hash proves the browser did not edit Helcim's payload. It is useful but
  // it is NOT the security control -- GATE 2 re-fetches the transaction from
  // Helcim with our own admin token, which is strictly stronger evidence.
  //
  // Helcim's eventMessage shape varies (object vs JSON string, hash at the top
  // level vs nested), so a failed hash extraction must NEVER be reported to the
  // customer as a declined payment. We record it and let GATE 2 decide.
  // Helcim hashes JSON.stringify(<the node beside the hash>) + secretToken.
  // Which node that is depends on the wrapper, so try each candidate rather
  // than guessing one nesting level.
  const presentedHash = hp.hash ?? (typeof hash === "string" ? hash : null);
  let hashOk = false;
  if (presentedHash) {
    for (const cand of hp.hashCandidates) {
      const expected = await sha256Hex(cand + sess.secret_token);
      if (timingSafeEqual(presentedHash, expected)) { hashOk = true; break; }
    }
  }

  // Server-normalized id first; the old recursive walk stays as a last resort.
  const txnId = hp.transactionId ?? extractTxnId(eventMessage ?? rawDataResponse);
  if (!txnId) {
    // Helcim said SUCCESS but we cannot identify the transaction. Do not fail
    // the payment -- park it for the webhook / reconcile job.
    await sb.from("payments").update({ status: "unknown", failure_category: "no_transaction_id" }).eq("id", pay.id);
    await ev(sb, pay, "verify_deferred", "browser_validate",
      { hash_ok: hashOk, reason: "no_transaction_id", ...hp.shape });
    return j({ status: "unknown", invoice_id: pay.invoice_id }, 202, cors);
  }
  const inner = parseInner(eventMessage ?? rawDataResponse);
  if (!hashOk) {
    await ev(sb, pay, "hash_unverified", "browser_validate",
      { txn_id: txnId, wrapper: hp.shape.wrapper, candidates_tried: hp.hashCandidates.length,
        note: "proceeding to authoritative provider lookup" });
  }
  await ev(sb, pay, "transaction_response_normalized", "browser_validate",
    { txn_id: txnId, wrapper: hp.shape.wrapper, hash_ok: hashOk,
      provider_status: hp.status, provider_type: hp.type });


  // ── GATE 2: authority — ask Helcim directly ────────────────────────────────
  // payment-checkout no longer fixes the rail (Helcim's modal chooses), so we
  // try the likely endpoint and fall back to the other rather than guessing.
  const order = (looksACH(inner) || pay.method === "ach")
    ? ["ach/transactions", "card-transactions"]
    : ["card-transactions", "ach/transactions"];

  await ev(sb, pay, "provider_lookup_started", "browser_validate",
    { txn_id: txnId, order: order.join(",") });

  let txn: Record<string, unknown> | null = null;
  let lastStatus = 0;
  for (const seg of order) {
    const r = await fetch(`${HELCIM_API}/${seg}/${txnId}`, {
      headers: { "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, "accept": "application/json" },
    });
    lastStatus = r.status;
    if (r.ok) { txn = await r.json().catch(() => null); if (txn) break; }
  }

  if (!txn) {
    // Cannot confirm right now. Helcim already told the customer SUCCESS, so
    // this is NOT a failure -- park it and let the webhook / reconcile settle.
    await sb.from("payments").update({ status: "unknown", failure_category: "verify_unavailable",
      provider_transaction_id: txnId }).eq("id", pay.id);
    await ev(sb, pay, "verify_deferred", "browser_validate",
      { http: lastStatus, txn_id: txnId, hash_ok: hashOk });
    return j({ status: "unknown", invoice_id: pay.invoice_id }, 202, cors);
  }

  await ev(sb, pay, "provider_lookup_succeeded", "browser_validate",
    { txn_id: txnId, provider_status: txn.status ?? null, provider_type: txn.type ?? null });

  const status   = String(txn.status ?? "").toUpperCase();
  const approved = status === "APPROVED" || status === "APPROVAL";
  if (approved) {
    // Card APPROVED is final for our purposes. Settlement/deposit happens later
    // in Helcim's batch and is NOT a precondition for the invoice being paid.
    await ev(sb, pay, "provider_approved", "browser_validate",
      { txn_id: txnId, rail: achTxn ? "ach" : "card",
        note: achTxn ? "ACH stays pending until the bank clears"
                     : "card approved — invoice settles now, bank deposit is separate" });
  }
  const txnCents = Math.round(Number(txn.amount ?? 0) * 100);   // TOTAL charged (incl. Fee Saver)
  const currency = String(txn.currency ?? "").toUpperCase();
  const invNum   = String(txn.invoiceNumber ?? "");
  const achTxn   = looksACH(txn);

  // Invoice linkage, when Helcim returns it, must match ours.
  if (invNum && invNum !== pay.invoice_id) {
    await sb.from("payments").update({ status: "unknown", failure_category: "invoice_mismatch",
      provider_transaction_id: txnId, completed_at: new Date().toISOString() }).eq("id", pay.id);
    await ev(sb, pay, "amount_mismatch", "browser_validate",
      { expected_invoice: pay.invoice_id, got_invoice: invNum });
    return j({ error: "verification_failed" }, 409, cors);
  }

  // Fee Saver: the charged total legitimately exceeds the base on card payments.
  // We split it, and refuse to auto-settle anything outside the configured bound.
  const rec = await reconcileAmount(sb, {
    baseCents: Number(pay.amount_cents), chargedCents: txnCents,
    currency, expectedCurrency: pay.currency, isACH: achTxn,
  });
  if (!rec.ok) {
    const { error: mmErr } = await sb.from("payments").update({ status: "unknown", failure_category: `amount_${rec.reason}`,
      provider_transaction_id: txnId, total_charged_cents: txnCents,
      completed_at: new Date().toISOString() }).eq("id", pay.id);
    if (mmErr) console.error("[payment-validate] mismatch write failed", mmErr);
    await ev(sb, pay, "amount_mismatch", "browser_validate",
      { reason: rec.reason, base_cents: rec.baseCents, charged_cents: rec.totalCents,
        implied_fee_cents: rec.impliedFeeCents, currency, ach: achTxn });
    return j({ error: "verification_failed" }, 409, cors);
  }

  // Card APPROVED is final. ACH APPROVED at initiation is NOT settlement —
  // it stays pending until the bank clears (webhook or reconcile job).
  const achSettled = achTxn && /settl|clear|complet/i.test(String(txn.bankStatus ?? txn.settlementStatus ?? ""));
  const newStatus  = !approved ? "failed" : (achTxn && !achSettled) ? "pending" : "succeeded";
  const now = new Date().toISOString();

  // ── PERSIST ────────────────────────────────────────────────────────────────
  // Every write below is error-checked. The browser must NEVER be told the
  // payment persisted when it did not -- that is what produced "success, then
  // the invoice is unpaid again after a refresh".
  const { error: payErr } = await sb.from("payments").update({
    status: newStatus,
    provider_transaction_id: txnId,
    method: achTxn ? "ach" : "card",
    method_display: mask(txn),
    fee_cents: rec.feeCents,                 // 0 for ACH; inferred fee for card
    total_charged_cents: rec.totalCents,     // what the customer actually paid
    failure_category: approved ? null : "declined",
    approved_at: approved ? (pay.approved_at ?? now) : null,
    settled_at:  newStatus === "succeeded" ? now : null,
    declined_at: approved ? null : now,
    completed_at: newStatus === "pending" ? null : now,
  }).eq("id", pay.id);

  if (!payErr) {
    await ev(sb, pay, "payment_persisted", "browser_validate",
      { new_status: newStatus, txn_id: txnId, fee_cents: rec.feeCents, charged_cents: rec.totalCents });
  }
  if (payErr) {
    // The money moved but we could not record it. Do not claim success --
    // the webhook and reconcile job are still authoritative and will retry.
    console.error("[payment-validate] payments UPDATE failed", payErr);
    await ev(sb, pay, "persist_failed", "browser_validate",
      { step: "payments_update", txn_id: txnId, db_error: payErr.message, code: payErr.code });
    return j({ status: "unknown", invoice_id: pay.invoice_id, amount_cents: pay.amount_cents }, 202, cors);
  }

  await ev(sb, pay, newStatus === "succeeded" ? "approved" : newStatus === "pending" ? "pending" : "declined",
           "browser_validate", { txn_id: txnId, ach: achTxn, provider_status: status, hash_ok: hashOk,
             base_cents: rec.baseCents, fee_cents: rec.feeCents, charged_cents: rec.totalCents });

  // Invoice state is DERIVED from the ledger — never assigned here.
  const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: pay.invoice_id });
  if (recalcErr) {
    console.error("[payment-validate] recalc_invoice_status failed", recalcErr);
    await ev(sb, pay, "persist_failed", "browser_validate",
      { step: "recalc_invoice_status", invoice_id: pay.invoice_id,
        db_error: recalcErr.message, code: recalcErr.code, hint: recalcErr.hint });
    // The payment row IS correct. Only the derived invoice status is behind, so
    // report "confirming" rather than success or failure.
    return j({ status: "confirming", invoice_id: pay.invoice_id, amount_cents: pay.amount_cents,
               reason: "invoice_recalc_pending" }, 202, cors);
  }

  if (newStatus === "succeeded") {
    const { error: linkErr } = await sb.from("invoices")
      .update({ paid_via: "helcim", payment_id: pay.id }).eq("id", pay.invoice_id);
    if (linkErr) console.error("[payment-validate] invoice link update failed", linkErr);
  }

  // ── VERIFY THE WRITE ACTUALLY LANDED ───────────────────────────────────────
  // Triggers (guard_tax_totals, guard_payment) can raise and silently leave the
  // invoice behind. Read it back before telling the customer anything.
  const { data: invAfter, error: invErr } = await sb.from("invoices")
    .select("status, paid_at").eq("id", pay.invoice_id).maybeSingle();

  if (invErr) console.error("[payment-validate] invoice read-back failed", invErr);

  const expected = newStatus === "succeeded" ? "paid"
                 : newStatus === "pending"   ? "payment_pending" : null;

  if (expected && invAfter && invAfter.status !== expected) {
    // Payment recorded, invoice did not follow. This is an internal
    // inconsistency, not a customer-facing failure.
    console.error("[payment-validate] INCONSISTENCY: payment=%s but invoice=%s",
      newStatus, invAfter.status);
    await ev(sb, pay, "invoice_status_inconsistent", "browser_validate",
      { payment_status: newStatus, invoice_status: invAfter.status, expected });
    return j({ status: "confirming", invoice_id: pay.invoice_id, amount_cents: pay.amount_cents,
               reason: "invoice_status_lagging" }, 202, cors);
  }

  await ev(sb, pay, newStatus === "succeeded" ? "invoice_paid" : "invoice_recalculated",
    "browser_validate", { invoice_status: invAfter?.status ?? null, payment_status: newStatus });

  const { data: fresh } = await sb.from("payments").select("*").eq("id", pay.id).single();
  return j(view(fresh ?? pay), 200, cors);
});

function view(p: Record<string, unknown>) {
  return { status: p.status, invoice_id: p.invoice_id, amount_cents: p.amount_cents,
           fee_cents: p.fee_cents, total_charged_cents: p.total_charged_cents,
           method_display: p.method_display, reference: p.provider_transaction_id,
           fn_version: FN_VERSION };
}
async function ev(sb: ReturnType<typeof createClient>, pay: Record<string, unknown>,
                  event: string, source: string, detail: unknown) {
  await sb.from("payment_events").insert({ payment_id: pay.id, invoice_id: pay.invoice_id, event, source, detail });
}
// Helcim's eventMessage arrives in more than one shape depending on version and
// platform. Dig for the transaction id rather than assuming one path.
function parseInner(raw: unknown): Record<string, unknown> {
  let v: unknown = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch { break; }
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const d1 = (o.data ?? o) as Record<string, unknown>;
  const d2 = (d1.data ?? d1) as Record<string, unknown>;
  return d2;
}

function extractTxnId(raw: unknown): string {
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): string => {
    if (!v || depth > 6 || seen.has(v)) return "";
    if (typeof v === "string") {
      try { return walk(JSON.parse(v), depth + 1); } catch { return ""; }
    }
    if (typeof v !== "object") return "";
    seen.add(v);
    const o = v as Record<string, unknown>;
    for (const k of ["transactionId", "cardTransactionId", "bankTransactionId", "id"]) {
      const c = o[k];
      if (typeof c === "number" && Number.isFinite(c)) return String(c);
      if (typeof c === "string" && /^\d+$/.test(c.trim())) return c.trim();
    }
    for (const val of Object.values(o)) {
      const found = walk(val, depth + 1);
      if (found) return found;
    }
    return "";
  };
  return walk(raw, 0);
}

async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function mask(t: Record<string, string>) {
  if (t.cardNumber)        return `${t.cardType ?? "Card"} ····${String(t.cardNumber).slice(-4)}`;
  if (t.bankAccountNumber) return `Bank ····${String(t.bankAccountNumber).slice(-4)}`;
  return null;
}
function j(b: unknown, s: number, c: Record<string,string>) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...c, "Content-Type": "application/json" } });
}
