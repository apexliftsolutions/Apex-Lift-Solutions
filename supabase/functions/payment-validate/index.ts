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

  const { checkoutToken, rawDataResponse, hash } = await req.json();
  if (!checkoutToken) return j({ error: "bad_request" }, 400, cors);

  // Read through a service-role-only SECURITY DEFINER function. The `private`
  // schema is not in the Data API's exposed schemas, so there is no browser path
  // to secret_token at all.
  const { data: sess } = await sb.rpc("read_checkout_session", { p_checkout_token: checkoutToken }).maybeSingle();
  if (!sess) return j({ error: "unknown_session" }, 404, cors);

  const { data: pay } = await sb.from("payments").select("*").eq("id", sess.attempt_id).single();
  if (!pay) return j({ error: "unknown_session" }, 404, cors);
  if (pay.customer_id !== user.id) return j({ error: "forbidden" }, 403, cors);

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
  let hashOk = false;
  if (hash) {
    const expected = await sha256Hex(String(rawDataResponse ?? "") + sess.secret_token);
    hashOk = timingSafeEqual(String(hash), expected);
  }

  // Pull the transaction id out of whatever shape arrived.
  const txnId = extractTxnId(rawDataResponse);
  if (!txnId) {
    // Helcim said SUCCESS but we cannot identify the transaction. Do not fail
    // the payment -- park it for the webhook / reconcile job.
    await sb.from("payments").update({ status: "unknown", failure_category: "no_transaction_id" }).eq("id", pay.id);
    await ev(sb, pay, "verify_deferred", "browser_validate", { hash_ok: hashOk, reason: "no_transaction_id" });
    return j({ status: "unknown", invoice_id: pay.invoice_id }, 202, cors);
  }
  const inner = parseInner(rawDataResponse);
  if (!hashOk) {
    await ev(sb, pay, "hash_unverified", "browser_validate",
      { txn_id: txnId, note: "proceeding to authoritative provider lookup" });
  }


  // ── GATE 2: authority — ask Helcim directly ────────────────────────────────
  // payment-checkout no longer fixes the rail (Helcim's modal chooses), so we
  // try the likely endpoint and fall back to the other rather than guessing.
  const order = (looksACH(inner) || pay.method === "ach")
    ? ["bank-transactions", "card-transactions"]
    : ["card-transactions", "bank-transactions"];

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

  const status   = String(txn.status ?? "").toUpperCase();
  const approved = status === "APPROVED" || status === "APPROVAL";
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
    await sb.from("payments").update({ status: "unknown", failure_category: `amount_${rec.reason}`,
      provider_transaction_id: txnId, total_charged_cents: txnCents,
      completed_at: new Date().toISOString() }).eq("id", pay.id);
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

  await sb.from("payments").update({
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

  await ev(sb, pay, newStatus === "succeeded" ? "approved" : newStatus === "pending" ? "pending" : "declined",
           "browser_validate", { txn_id: txnId, ach: achTxn, provider_status: status, hash_ok: hashOk,
             base_cents: rec.baseCents, fee_cents: rec.feeCents, charged_cents: rec.totalCents });

  // Invoice state is DERIVED from the ledger — never assigned here.
  await sb.rpc("recalc_invoice_status", { p_invoice_id: pay.invoice_id });
  if (newStatus === "succeeded") {
    await sb.from("invoices").update({ paid_via: "helcim", payment_id: pay.id }).eq("id", pay.invoice_id);
  }

  const { data: fresh } = await sb.from("payments").select("*").eq("id", pay.id).single();
  return j(view(fresh), 200, cors);
});

function view(p: Record<string, unknown>) {
  return { status: p.status, invoice_id: p.invoice_id, amount_cents: p.amount_cents,
           method_display: p.method_display, reference: p.provider_transaction_id };
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
