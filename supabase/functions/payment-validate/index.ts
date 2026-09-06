// POST /payment-validate
// body: { checkoutToken, eventMessage?, rawDataResponse?, hash?, clientVersion? }
//
// Credit cards:
//   HelcimPay SUCCESS -> server verifies the response hash with the checkout's
//   secretToken, validates amount/currency/type, and marks the payment succeeded
//   immediately. A secondary V2 transaction GET is attempted for reconciliation,
//   but a temporary 404 does not strand a cryptographically verified APPROVED card.
//
// ACH:
//   HelcimPay SUCCESS only means the ACH transaction was created. It remains
//   pending until Helcim reports clearing/settlement.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileAmount, looksACH } from "../_shared/feesaver.ts";
import { normalizeHelcimPayResponse } from "../_shared/helcimpay.ts";

const FN_VERSION = "2026-09-06.v21";
const HELCIM_API = "https://api.helcim.com/v2";

type Row = Record<string, any>;

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": Deno.env.get("PUBLIC_SITE_URL") ?? "https://apexliftsolutionsusa.com",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ error: "method_not_allowed" }, 405, cors);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return j({ error: "unauthorized" }, 401, cors);

  const body = await req.json().catch(() => ({}));
  const { checkoutToken, eventMessage, rawDataResponse, hash, clientVersion } = body ?? {};
  if (!checkoutToken) return j({ error: "bad_request" }, 400, cors);

  // The secret token is read only through a SECURITY DEFINER RPC. It never goes
  // to the browser and is unique to this checkout session.
  const { data: sess, error: sessErr } = await sb
    .rpc("read_checkout_session", { p_checkout_token: checkoutToken })
    .maybeSingle();

  if (!sess) {
    console.error("[payment-validate] unknown checkout session", sessErr?.message ?? "");
    await safeInsertEvent(sb, {
      event: "validation_failed",
      source: "browser_validate",
      detail: { reason: "unknown_checkout_session", db_error: sessErr?.message ?? null },
    });
    return j({ error: "unknown_session", fn_version: FN_VERSION }, 404, cors);
  }

  const { data: pay, error: payReadErr } = await sb.from("payments").select("*").eq("id", sess.attempt_id).maybeSingle();
  if (!pay) {
    await safeInsertEvent(sb, {
      event: "validation_failed",
      source: "browser_validate",
      detail: { reason: "attempt_row_missing", attempt_id: sess.attempt_id, db_error: payReadErr?.message ?? null },
    });
    return j({ error: "unknown_session", fn_version: FN_VERSION }, 404, cors);
  }
  if (pay.customer_id !== user.id) {
    await ev(sb, pay, "validation_failed", { reason: "ownership_mismatch" });
    return j({ error: "forbidden", fn_version: FN_VERSION }, 403, cors);
  }

  // Already-final rows are idempotent. Unknown is deliberately re-processable.
  if (!["initiated", "pending", "unknown"].includes(String(pay.status))) {
    return j(view(pay), 200, cors);
  }

  const raw = eventMessage ?? rawDataResponse;
  const hp = normalizeHelcimPayResponse(raw);
  const inner = parseInner(raw);
  const payloadIsAch = looksACH(inner) || /ach|bank|withdraw/i.test(String(hp.type ?? ""));

  await ev(sb, pay, "validation_started", {
    fn_version: FN_VERSION,
    client_version: typeof clientVersion === "string" ? clientVersion : null,
    ...hp.shape,
    browser_sent_hash: !!hash,
    browser_sent_raw: !!rawDataResponse,
    server_found_txn_id: !!hp.transactionId,
    rail_hint: payloadIsAch ? "ach" : "card",
  });

  // Validate the HelcimPay response integrity using the checkout's secretToken.
  const presentedHash = hp.hash ?? (typeof hash === "string" ? hash : null);
  let hashOk = false;
  if (presentedHash) {
    for (const candidate of hp.hashCandidates) {
      const expected = await sha256Hex(candidate + sess.secret_token);
      if (timingSafeEqual(presentedHash, expected)) {
        hashOk = true;
        break;
      }
    }
  }

  if (hashOk) {
    await ev(sb, pay, "helcimpay_hash_verified", {
      wrapper: hp.shape.wrapper,
      candidates_tried: hp.hashCandidates.length,
    });
  } else {
    await ev(sb, pay, "hash_unverified", {
      wrapper: hp.shape.wrapper,
      candidates_tried: hp.hashCandidates.length,
    });
  }

  const txnId = hp.transactionId ?? extractTxnId(raw);
  if (!txnId) {
    const { error } = await sb.from("payments")
      .update({ status: "unknown", failure_category: "no_transaction_id" })
      .eq("id", pay.id);
    if (error) console.error("[payment-validate] no-id state write failed", error);
    await ev(sb, pay, "verify_deferred", { reason: "no_transaction_id", hash_ok: hashOk });
    return j({ status: "unknown", invoice_id: pay.invoice_id, fn_version: FN_VERSION }, 202, cors);
  }

  await ev(sb, pay, "transaction_response_normalized", {
    txn_id: txnId,
    wrapper: hp.shape.wrapper,
    hash_ok: hashOk,
    provider_status: hp.status,
    provider_type: hp.type,
  });

  // Prevent one Helcim transaction from being attached to two Apex payments.
  const { data: dupTxn } = await sb.from("payments")
    .select("id,invoice_id,status")
    .eq("provider", "helcim")
    .eq("provider_transaction_id", txnId)
    .neq("id", pay.id)
    .limit(1)
    .maybeSingle();
  if (dupTxn) {
    await ev(sb, pay, "validation_failed", {
      reason: "transaction_already_used",
      txn_id: txnId,
      other_payment_id: dupTxn.id,
      other_invoice_id: dupTxn.invoice_id,
    });
    return j({ status: "unknown", invoice_id: pay.invoice_id, reason: "transaction_already_used", fn_version: FN_VERSION }, 409, cors);
  }

  // First try the provider's transaction API. For cards Helcim documents
  // /v2/card-transactions/{id}; for ACH it is /v2/ach/transactions/{id}.
  const lookupPath = payloadIsAch
    ? `ach/transactions/${encodeURIComponent(txnId)}`
    : `card-transactions/${encodeURIComponent(txnId)}`;

  await ev(sb, pay, "provider_lookup_started", { txn_id: txnId, path: lookupPath });

  let providerTxn: Row | null = null;
  let providerHttp = 0;
  let providerError: string | null = null;
  try {
    const r = await fetch(`${HELCIM_API}/${lookupPath}`, {
      headers: {
        "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!,
        "accept": "application/json",
      },
    });
    providerHttp = r.status;
    if (r.ok) {
      providerTxn = unwrapTxn(await r.json().catch(() => null));
    } else {
      providerError = await safeProviderError(r);
    }
  } catch (e) {
    providerError = e instanceof Error ? e.message : String(e);
  }

  if (providerTxn) {
    await ev(sb, pay, "provider_lookup_succeeded", {
      txn_id: txnId,
      http: providerHttp,
      provider_status: providerStatusLabel(providerTxn, payloadIsAch),
      provider_type: providerTxn.type ?? providerTxn.transactionType ?? null,
    });
  } else {
    await ev(sb, pay, "provider_lookup_deferred", {
      txn_id: txnId,
      http: providerHttp,
      path: lookupPath,
      hash_ok: hashOk,
      provider_error: providerError,
    });
    if (providerHttp === 401 || providerHttp === 403) {
      await ev(sb, pay, "provider_auth_failed", {
        txn_id: txnId,
        http: providerHttp,
        path: lookupPath,
        note: "HELCIM_ADMIN_API_TOKEN was not accepted for the provider lookup; hash-verified card flow may still complete, but webhook/reconcile credentials must be fixed",
      });
    }
  }

  // If the secondary V2 GET is unavailable, Helcim's documented hash validation
  // still gives us a server-verifiable HelcimPay response tied to this checkout.
  // For CARD only, APPROVED + valid hash + correct amount/currency/type is enough
  // to mark the Apex invoice paid immediately. ACH remains pending until clearing.
  let txn: Row | null = providerTxn;
  let verificationSource = providerTxn ? "provider_api" : "helcimpay_hash";

  if (!txn) {
    if (!hashOk) {
      await parkUnknown(sb, pay, txnId, "verify_unavailable");
      await ev(sb, pay, "verify_deferred", {
        reason: "provider_unavailable_and_hash_unverified",
        http: providerHttp,
        txn_id: txnId,
      });
      return j({ status: "unknown", invoice_id: pay.invoice_id, fn_version: FN_VERSION }, 202, cors);
    }

    // Use the parsed HelcimPay transaction object only after the server has
    // recomputed and matched the hash with the secretToken.
    txn = { ...inner };
    if (!txn.transactionId) txn.transactionId = txnId;
    if (!txn.amount && hp.amount != null) txn.amount = hp.amount;
    if (!txn.currency && hp.currency != null) txn.currency = hp.currency;
    if (!txn.status && hp.status != null) txn.status = hp.status;
    if (!txn.type && hp.type != null) txn.type = hp.type;

    await ev(sb, pay, "helcimpay_response_authoritative", {
      txn_id: txnId,
      rail: payloadIsAch ? "ach" : "card",
      note: payloadIsAch
        ? "hash verified; ACH transaction accepted as pending until clearing"
        : "hash verified; approved card may settle Apex invoice immediately",
    });
  }

  const achTxn = payloadIsAch || looksACH(txn);
  const txnCurrency = normalizeCurrency(txn.currency ?? hp.currency);
  const txnCents = Math.round(Number(txn.amount ?? hp.amount ?? 0) * 100);

  // IMPORTANT: Apex does NOT currently send its invoice id as Helcim's
  // invoiceNumber during checkout. Helcim may therefore return its own internal
  // invoice number (for example INV001005). That value is NOT an Apex linkage
  // and must not be compared to pay.invoice_id. The binding for this browser
  // validation path is the server-owned checkout session -> attempt_id, plus the
  // secretToken-verified HelcimPay response.
  const providerInvoiceNumber = String(txn.invoiceNumber ?? "");
  if (providerInvoiceNumber) {
    await ev(sb, pay, "provider_invoice_observed", {
      txn_id: txnId,
      provider_invoice_number: providerInvoiceNumber,
      note: "informational only; Apex checkout does not currently link an Apex invoiceNumber to Helcim",
    });
  }

  // Security: a transaction id supplied through the browser is not enough by
  // itself to claim a provider transaction. For this immediate validation path
  // require either the HelcimPay response hash to verify against this checkout's
  // private secretToken, or the transaction to have already been bound to this
  // payment by a trusted backend path (webhook/reconcile).
  const alreadyBound = String(pay.provider_transaction_id ?? "") === txnId;
  if (!hashOk && !alreadyBound) {
    await parkUnknown(sb, pay, txnId, "hash_unverified", txnCents || null);
    await ev(sb, pay, "verify_deferred", {
      reason: "hash_unverified_no_trusted_binding",
      txn_id: txnId,
      verification_source: verificationSource,
    });
    return j({ status: "unknown", invoice_id: pay.invoice_id, reason: "hash_unverified", fn_version: FN_VERSION }, 202, cors);
  }

  const rec = await reconcileAmount(sb, {
    baseCents: Number(pay.amount_cents),
    chargedCents: txnCents,
    currency: txnCurrency,
    expectedCurrency: pay.currency,
    isACH: achTxn,
  });

  if (!rec.ok) {
    await parkUnknown(sb, pay, txnId, `amount_${rec.reason}`, txnCents);
    await ev(sb, pay, "amount_mismatch", {
      reason: rec.reason,
      txn_id: txnId,
      base_cents: rec.baseCents,
      charged_cents: rec.totalCents,
      implied_fee_cents: rec.impliedFeeCents,
      currency: txnCurrency,
      ach: achTxn,
      verification_source: verificationSource,
    });
    return j({ status: "unknown", invoice_id: pay.invoice_id, reason: "amount_mismatch", fn_version: FN_VERSION }, 409, cors);
  }

  const now = new Date().toISOString();
  let newStatus: "succeeded" | "pending" | "failed" | "unknown";

  if (achTxn) {
    if (achFailed(txn)) newStatus = "failed";
    else if (achCleared(txn)) newStatus = "succeeded";
    else newStatus = "pending";
  } else {
    const status = String(txn.status ?? hp.status ?? "").toUpperCase();
    const type = String(txn.type ?? hp.type ?? "").toLowerCase();
    const approved = status === "APPROVED" || status === "APPROVAL";
    const purchaseType = !type || /purchase|payment|sale/.test(type);

    // If the V2 API explicitly says declined, that is authoritative. If we are
    // using the hash-verified HelcimPay fallback, require APPROVED + purchase.
    if (approved && purchaseType) newStatus = "succeeded";
    else if (providerTxn && /DECLIN|FAIL|CANCEL|VOID/.test(status)) newStatus = "failed";
    else newStatus = "unknown";
  }

  if (newStatus === "unknown") {
    await parkUnknown(sb, pay, txnId, "provider_status_unrecognized", txnCents);
    await ev(sb, pay, "verify_deferred", {
      reason: "provider_status_unrecognized",
      txn_id: txnId,
      provider_status: providerStatusLabel(txn, achTxn),
      verification_source: verificationSource,
    });
    return j({ status: "unknown", invoice_id: pay.invoice_id, fn_version: FN_VERSION }, 202, cors);
  }

  if (newStatus === "succeeded" && !achTxn) {
    await ev(sb, pay, "card_approved", {
      txn_id: txnId,
      verification_source: verificationSource,
      note: "card approved — Apex marks invoice paid now; bank deposit is separate",
    });
  }

  const update: Row = {
    status: newStatus,
    provider_transaction_id: txnId,
    method: achTxn ? "ach" : "card",
    method_display: mask(txn),
    fee_cents: rec.feeCents,
    total_charged_cents: rec.totalCents,
    failure_category: newStatus === "failed" ? (achTxn ? "ach_failed" : "declined") : null,
    approved_at: newStatus !== "failed" ? (pay.approved_at ?? now) : pay.approved_at,
    // Do not pretend a card has reached bank settlement merely because it was approved.
    // For ACH, settled_at is populated only after clearing.
    settled_at: achTxn && newStatus === "succeeded" ? now : pay.settled_at ?? null,
    declined_at: newStatus === "failed" ? now : null,
    completed_at: newStatus === "pending" ? null : now,
  };

  const { error: payErr } = await sb.from("payments").update(update).eq("id", pay.id);
  if (payErr) {
    console.error("[payment-validate] payment write failed", payErr);
    await ev(sb, pay, "persist_failed", {
      step: "payments_update",
      txn_id: txnId,
      db_error: payErr.message,
      code: payErr.code,
    });
    return j({ status: "unknown", invoice_id: pay.invoice_id, fn_version: FN_VERSION }, 202, cors);
  }

  await ev(sb, pay, "payment_persisted", {
    txn_id: txnId,
    new_status: newStatus,
    fee_cents: rec.feeCents,
    charged_cents: rec.totalCents,
    verification_source: verificationSource,
  });

  // Derive invoice state from the ledger. This transition is what drives the
  // existing payment notification trigger/outbox.
  const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: pay.invoice_id });
  if (recalcErr) {
    console.error("[payment-validate] recalc_invoice_status failed", recalcErr);
    await ev(sb, pay, "persist_failed", {
      step: "recalc_invoice_status",
      txn_id: txnId,
      db_error: recalcErr.message,
      code: recalcErr.code,
      hint: recalcErr.hint,
    });
    return j({ status: "confirming", invoice_id: pay.invoice_id, reason: "invoice_recalc_pending", fn_version: FN_VERSION }, 202, cors);
  }

  if (newStatus === "succeeded") {
    const { error: linkErr } = await sb.from("invoices")
      .update({ paid_via: "helcim", payment_id: pay.id })
      .eq("id", pay.invoice_id);
    if (linkErr) {
      console.error("[payment-validate] invoice link update failed", linkErr);
      await ev(sb, pay, "persist_failed", {
        step: "invoice_link",
        txn_id: txnId,
        db_error: linkErr.message,
        code: linkErr.code,
      });
    }
  }

  const { data: invAfter, error: invErr } = await sb.from("invoices")
    .select("status,paid_at,payment_id,paid_via")
    .eq("id", pay.invoice_id)
    .maybeSingle();

  if (invErr) console.error("[payment-validate] invoice read-back failed", invErr);

  const expected = newStatus === "succeeded" ? "paid"
    : newStatus === "pending" ? "payment_pending"
    : null;

  if (expected && (!invAfter || invAfter.status !== expected)) {
    await ev(sb, pay, "invoice_status_inconsistent", {
      payment_status: newStatus,
      invoice_status: invAfter?.status ?? null,
      expected,
    });
    return j({ status: "confirming", invoice_id: pay.invoice_id, reason: "invoice_status_lagging", fn_version: FN_VERSION }, 202, cors);
  }

  await ev(sb, pay, newStatus === "succeeded" ? "invoice_paid" : "invoice_recalculated", {
    invoice_status: invAfter?.status ?? null,
    payment_status: newStatus,
  });

  const { data: fresh } = await sb.from("payments").select("*").eq("id", pay.id).maybeSingle();
  return j(view(fresh ?? { ...pay, ...update }), 200, cors);
});

async function parkUnknown(sb: ReturnType<typeof createClient>, pay: Row, txnId: string, reason: string, totalCents?: number | null) {
  const patch: Row = {
    status: "unknown",
    failure_category: reason,
    provider_transaction_id: txnId,
  };
  if (typeof totalCents === "number") patch.total_charged_cents = totalCents;
  const { error } = await sb.from("payments").update(patch).eq("id", pay.id);
  if (error) console.error("[payment-validate] parkUnknown failed", error);
}

function providerStatusLabel(txn: Row, isAch: boolean): string | null {
  if (isAch) return String(txn.statusClearing ?? txn.statusAuth ?? txn.status ?? "") || null;
  return String(txn.status ?? "") || null;
}

function achCleared(txn: Row): boolean {
  const clearing = String(txn.statusClearing ?? txn.settlementStatus ?? txn.bankStatus ?? "").toUpperCase();
  const auth = String(txn.statusAuth ?? txn.status ?? "").toUpperCase();
  return ["1", "CLEARED", "SETTLED", "COMPLETED", "COMPLETE"].includes(clearing)
    && !["2", "4", "DECLINED", "CANCELLED", "FAILED"].includes(auth);
}

function achFailed(txn: Row): boolean {
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

async function safeProviderError(r: Response): Promise<string | null> {
  try {
    const text = await r.text();
    if (!text) return null;
    return text.replace(/\s+/g, " ").slice(0, 240);
  } catch {
    return null;
  }
}

function parseInner(raw: unknown): Row {
  let v: unknown = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try { v = JSON.parse(v); } catch { break; }
  }
  const o = (v && typeof v === "object" ? v : {}) as Row;
  const d1 = (o.data && typeof o.data === "object" ? o.data : o) as Row;
  const d2 = (d1.data && typeof d1.data === "object" ? d1.data : d1) as Row;
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
    const o = v as Row;
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

function mask(t: Row): string | null {
  if (t.cardNumber) return `${t.cardType ?? "Card"} ····${String(t.cardNumber).slice(-4)}`;
  if (t.bankAccountNumber) return `Bank ····${String(t.bankAccountNumber).slice(-4)}`;
  if (t.bankAccountL4L4) return `Bank ····${String(t.bankAccountL4L4).slice(-4)}`;
  return null;
}

function view(p: Row) {
  return {
    status: p.status,
    invoice_id: p.invoice_id,
    amount_cents: p.amount_cents,
    fee_cents: p.fee_cents,
    total_charged_cents: p.total_charged_cents,
    method_display: p.method_display,
    reference: p.provider_transaction_id,
    fn_version: FN_VERSION,
  };
}

async function ev(sb: ReturnType<typeof createClient>, pay: Row, event: string, detail: unknown) {
  const { error } = await sb.from("payment_events").insert({
    payment_id: pay.id,
    invoice_id: pay.invoice_id,
    event,
    source: "browser_validate",
    detail,
  });
  if (error) console.warn("[payment-validate] payment_events insert failed", event, error.message);
}

async function safeInsertEvent(sb: ReturnType<typeof createClient>, row: Row) {
  const { error } = await sb.from("payment_events").insert(row);
  if (error) console.warn("[payment-validate] diagnostic insert failed", error.message);
}

async function sha256Hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function j(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
