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

  // ── GATE 1: integrity ──────────────────────────────────────────────────────
  const expected = await sha256Hex(String(rawDataResponse ?? "") + sess.secret_token);
  if (!hash || !timingSafeEqual(String(hash), expected)) {
    await fail(sb, pay, "hash_mismatch");
    return j({ error: "verification_failed" }, 400, cors);
  }

  // The browser's own status/amount are read for the transaction ID ONLY.
  let claimed: Record<string, unknown> = {};
  try { claimed = JSON.parse(String(rawDataResponse)); } catch { /* ignore */ }
  const inner = (claimed.data ?? claimed) as Record<string, unknown>;
  const txnId = String(inner.transactionId ?? inner.id ?? "");
  if (!txnId) { await fail(sb, pay, "no_transaction_id"); return j({ error: "verification_failed" }, 400, cors); }

  const isACH = /ach|bank/i.test(String(inner.type ?? "")) || pay.method === "ach";

  // ── GATE 2: authority — ask Helcim directly ────────────────────────────────
  const path = isACH ? `bank-transactions/${txnId}` : `card-transactions/${txnId}`;
  const tRes = await fetch(`${HELCIM_API}/${path}`, {
    headers: { "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!, "accept": "application/json" },
  });
  if (!tRes.ok) {
    // We cannot confirm. Do NOT guess, and do NOT let the customer retry — the
    // webhook or the reconcile job will settle it.
    await sb.from("payments").update({ status: "unknown", failure_category: "verify_unavailable",
      provider_transaction_id: txnId }).eq("id", pay.id);
    await ev(sb, pay, "verify_unavailable", "browser_validate", { http: tRes.status, txn_id: txnId });
    return j({ status: "unknown", invoice_id: pay.invoice_id }, 202, cors);
  }
  const txn = await tRes.json();

  const status   = String(txn.status ?? "").toUpperCase();
  const approved = status === "APPROVED" || status === "APPROVAL";
  const txnCents = Math.round(Number(txn.amount ?? 0) * 100);
  const currency = String(txn.currency ?? "").toUpperCase();
  const invNum   = String(txn.invoiceNumber ?? "");

  // Amount, currency and invoice linkage must all match what the server set.
  if (txnCents !== Number(pay.amount_cents) || currency !== pay.currency || (invNum && invNum !== pay.invoice_id)) {
    await sb.from("payments").update({ status: "unknown", failure_category: "amount_mismatch",
      provider_transaction_id: txnId, completed_at: new Date().toISOString() }).eq("id", pay.id);
    await ev(sb, pay, "amount_mismatch", "browser_validate",
      { expected_cents: pay.amount_cents, got_cents: txnCents, currency, invoice_number: invNum });
    return j({ error: "verification_failed" }, 409, cors);
  }

  // Card APPROVED is final. ACH APPROVED at initiation is NOT settlement —
  // it stays pending until the bank clears (webhook or reconcile job).
  const achSettled = isACH && /settl|clear|complet/i.test(String(txn.bankStatus ?? txn.settlementStatus ?? ""));
  const newStatus  = !approved ? "failed" : (isACH && !achSettled) ? "pending" : "succeeded";
  const now = new Date().toISOString();

  await sb.from("payments").update({
    status: newStatus,
    provider_transaction_id: txnId,
    method: isACH ? "ach" : "card",
    method_display: mask(txn),
    failure_category: approved ? null : "declined",
    approved_at: approved ? (pay.approved_at ?? now) : null,
    settled_at:  newStatus === "succeeded" ? now : null,
    declined_at: approved ? null : now,
    completed_at: newStatus === "pending" ? null : now,
  }).eq("id", pay.id);

  await ev(sb, pay, newStatus === "succeeded" ? "approved" : newStatus === "pending" ? "pending" : "declined",
           "browser_validate", { txn_id: txnId, ach: isACH, provider_status: status });

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
async function fail(sb: ReturnType<typeof createClient>, pay: Record<string, unknown>, why: string) {
  await sb.from("payments").update({ status: "unknown", failure_category: why,
    completed_at: new Date().toISOString() }).eq("id", pay.id);
  await ev(sb, pay, "verification_failed", "browser_validate", { reason: why });
}
async function ev(sb: ReturnType<typeof createClient>, pay: Record<string, unknown>,
                  event: string, source: string, detail: unknown) {
  await sb.from("payment_events").insert({ payment_id: pay.id, invoice_id: pay.invoice_id, event, source, detail });
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
