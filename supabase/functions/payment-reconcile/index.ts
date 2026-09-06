// Scheduled reconciliation safety net.
//
// Responsibilities:
// 1. Recover initiated/unknown Helcim attempts by checking Helcim before doing
//    anything destructive.
// 2. Never auto-void an UNKNOWN payment: UNKNOWN means the browser/provider told
//    us something happened but we could not finish verification.
// 3. Only void an INITIATED attempt after it is old enough and Helcim shows no
//    unambiguous matching transaction.
// 4. Poll pending ACH transactions until they clear or fail.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileAmount } from "../_shared/feesaver.ts";

const HELCIM_API = "https://api.helcim.com/v2";
type Row = Record<string, any>;

Deno.serve(async (req) => {
  if (req.headers.get("x-worker-key") !== Deno.env.get("RECONCILE_WORKER_KEY")) {
    return new Response("Forbidden", { status: 403 });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();

  // Revisit both INITIATED and UNKNOWN attempts. UNKNOWN is important: the old
  // worker ignored it, which made a failed immediate verification a dead-end.
  const { data: attempts, error: attemptsErr } = await sb.from("payments")
    .select("*")
    .eq("provider", "helcim")
    .eq("kind", "payment")
    .in("status", ["initiated", "unknown"])
    .lt("initiated_at", cutoff)
    .order("initiated_at", { ascending: true })
    .limit(50);

  if (attemptsErr) {
    console.error("[payment-reconcile] attempt query failed", attemptsErr);
    return Response.json({ error: "attempt_query_failed" }, { status: 500 });
  }

  let recovered = 0;
  let voided = 0;
  let leftForReview = 0;

  for (const p of attempts ?? []) {
    const found = await findHelcimTxn(p);

    if (found) {
      const applied = await applyFoundTransaction(sb, p, found, now);
      if (applied === "recovered") recovered++;
      else leftForReview++;
      continue;
    }

    // UNKNOWN is never auto-voided. There may be a real charged transaction we
    // still cannot identify; keep the duplicate-payment lock and require review.
    if (String(p.status) === "unknown") {
      leftForReview++;
      continue;
    }

    // INITIATED attempts younger than 6h are not safe to classify as abandoned.
    if (Date.now() - new Date(String(p.initiated_at)).getTime() < 6 * 60 * 60_000) {
      continue;
    }

    // Only an old INITIATED attempt with no matching provider transaction can be
    // voided. This update is conditional so a concurrent validator cannot race it.
    const { error: voidErr } = await sb.from("payments")
      .update({ status: "voided", failure_category: "abandoned", completed_at: now })
      .eq("id", p.id)
      .eq("status", "initiated");

    if (voidErr) {
      console.error("[payment-reconcile] void failed", p.id, voidErr);
      continue;
    }

    const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: p.invoice_id });
    if (recalcErr) console.error("[payment-reconcile] recalc after void failed", p.invoice_id, recalcErr);

    await addEvent(sb, p, "voided", {
      reason: "no_provider_transaction",
      checked_helcim: true,
      note: "only old initiated attempts may be auto-voided; unknown attempts are never auto-voided",
    });
    voided++;
  }

  // Pending ACH -> poll the documented ACH endpoint.
  const { data: pendingAch, error: achQueryErr } = await sb.from("payments")
    .select("*")
    .eq("provider", "helcim")
    .eq("method", "ach")
    .eq("status", "pending")
    .not("provider_transaction_id", "is", null)
    .limit(50);

  if (achQueryErr) console.error("[payment-reconcile] ACH query failed", achQueryErr);

  let achSettled = 0;
  let achFailed = 0;

  for (const p of pendingAch ?? []) {
    const got = await fetchTxnById(String(p.provider_transaction_id), "ach");
    if (!got.txn) continue;

    const txn = got.txn;
    let next: "succeeded" | "failed" | null = null;
    if (isAchCleared(txn)) next = "succeeded";
    else if (isAchFailed(txn)) next = "failed";
    if (!next) continue;

    const isCorrection = p.kind === "refund" || p.kind === "reversal";
    const now2 = new Date().toISOString();
    const { error: updateErr } = await sb.from("payments").update({
      status: next,
      settled_at: next === "succeeded" ? now2 : null,
      declined_at: next === "failed" ? now2 : null,
      completed_at: now2,
      fee_cents: 0,
      total_charged_cents: p.amount_cents,
      failure_category: next === "failed"
        ? (isCorrection ? "ach_refund_failed" : "ach_returned")
        : null,
    }).eq("id", p.id);

    if (updateErr) {
      console.error("[payment-reconcile] ACH state update failed", p.id, updateErr);
      continue;
    }

    await addEvent(sb, p,
      isCorrection
        ? (next === "succeeded" ? "refund_settled" : "refund_failed")
        : (next === "succeeded" ? "settled" : "declined"),
      {
        kind: p.kind,
        provider_status_auth: txn.statusAuth ?? null,
        provider_status_clearing: txn.statusClearing ?? null,
      });

    const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: p.invoice_id });
    if (recalcErr) {
      console.error("[payment-reconcile] ACH recalc failed", p.invoice_id, recalcErr);
      continue;
    }

    // Only an incoming payment becomes invoices.payment_id. A refund/reversal is
    // a correction row and must never replace the original receipt link.
    if (next === "succeeded" && !isCorrection) {
      const { error: linkErr } = await sb.from("invoices")
        .update({ paid_via: "helcim", payment_id: p.id })
        .eq("id", p.invoice_id);
      if (linkErr) console.error("[payment-reconcile] ACH invoice link failed", p.invoice_id, linkErr);
    }

    if (next === "succeeded") achSettled++;
    else achFailed++;
  }

  return Response.json({
    attempts_checked: attempts?.length ?? 0,
    recovered,
    voided,
    left_for_review: leftForReview,
    ach_checked: pendingAch?.length ?? 0,
    ach_settled: achSettled,
    ach_failed: achFailed,
  });
});

async function applyFoundTransaction(
  sb: ReturnType<typeof createClient>,
  pay: Row,
  found: { txn: Row; rail: "card" | "ach"; source: string },
  now: string,
): Promise<"recovered" | "review"> {
  const { txn, rail, source } = found;
  const chargedCents = Math.round(Number(txn.amount ?? 0) * 100);
  const currency = normalizeCurrency(txn.currency);
  const isAch = rail === "ach";

  const rec = await reconcileAmount(sb, {
    baseCents: Number(pay.amount_cents),
    chargedCents,
    currency,
    expectedCurrency: pay.currency,
    isACH: isAch,
  });

  const txnId = String(txn.transactionId ?? txn.id ?? pay.provider_transaction_id ?? "");

  if (!rec.ok) {
    const { error } = await sb.from("payments").update({
      status: "unknown",
      failure_category: `amount_${rec.reason}`,
      provider_transaction_id: txnId || null,
      total_charged_cents: chargedCents || null,
    }).eq("id", pay.id);
    if (error) console.error("[payment-reconcile] mismatch write failed", pay.id, error);
    await addEvent(sb, pay, "amount_mismatch", {
      reason: rec.reason,
      txn_id: txnId,
      base_cents: rec.baseCents,
      charged_cents: rec.totalCents,
      source,
    });
    return "review";
  }

  let next: "succeeded" | "pending" | "failed" | null = null;
  if (isAch) {
    if (isAchCleared(txn)) next = "succeeded";
    else if (isAchFailed(txn)) next = "failed";
    else next = "pending";
  } else {
    const status = String(txn.status ?? "").toUpperCase();
    if (status === "APPROVED" || status === "APPROVAL") next = "succeeded";
    else if (/DECLIN|FAIL|CANCEL|VOID/.test(status)) next = "failed";
  }

  if (!next) {
    await addEvent(sb, pay, "reconcile_unrecognized_status", {
      txn_id: txnId,
      rail,
      source,
      provider_status: providerStatus(txn, isAch),
    });
    return "review";
  }

  const { data: duplicate } = await sb.from("payments")
    .select("id,invoice_id")
    .eq("provider", "helcim")
    .eq("provider_transaction_id", txnId)
    .neq("id", pay.id)
    .limit(1)
    .maybeSingle();
  if (duplicate) {
    await addEvent(sb, pay, "reconcile_duplicate_transaction", {
      txn_id: txnId,
      other_payment_id: duplicate.id,
      other_invoice_id: duplicate.invoice_id,
    });
    return "review";
  }

  const { error: updateErr } = await sb.from("payments").update({
    status: next,
    provider_transaction_id: txnId || null,
    method: isAch ? "ach" : "card",
    method_display: mask(txn),
    fee_cents: rec.feeCents,
    total_charged_cents: rec.totalCents,
    approved_at: next !== "failed" ? (pay.approved_at ?? now) : pay.approved_at,
    settled_at: isAch && next === "succeeded" ? now : pay.settled_at ?? null,
    declined_at: next === "failed" ? now : null,
    completed_at: next === "pending" ? null : now,
    failure_category: next === "failed" ? (isAch ? "ach_failed" : "declined") : null,
  }).eq("id", pay.id);

  if (updateErr) {
    console.error("[payment-reconcile] recovery update failed", pay.id, updateErr);
    await addEvent(sb, pay, "persist_failed", {
      step: "reconcile_payment_update",
      db_error: updateErr.message,
      code: updateErr.code,
    });
    return "review";
  }

  await addEvent(sb, pay,
    next === "succeeded" ? "recovered_succeeded" : next === "pending" ? "recovered_pending" : "recovered_failed",
    {
      txn_id: txnId,
      rail,
      source,
      base_cents: rec.baseCents,
      fee_cents: rec.feeCents,
      charged_cents: rec.totalCents,
    });

  const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: pay.invoice_id });
  if (recalcErr) {
    console.error("[payment-reconcile] recovery recalc failed", pay.invoice_id, recalcErr);
    await addEvent(sb, pay, "persist_failed", {
      step: "reconcile_invoice_recalc",
      db_error: recalcErr.message,
      code: recalcErr.code,
    });
    return "review";
  }

  if (next === "succeeded") {
    const { error: linkErr } = await sb.from("invoices")
      .update({ paid_via: "helcim", payment_id: pay.id })
      .eq("id", pay.invoice_id);
    if (linkErr) console.error("[payment-reconcile] recovery invoice link failed", pay.invoice_id, linkErr);
  }

  return "recovered";
}

// Try the exact transaction id first. If Helcim's single-record endpoint is not
// immediately available, fall back to conservative collection matching.
async function findHelcimTxn(pay: Row): Promise<{ txn: Row; rail: "card" | "ach"; source: string } | null> {
  const knownId = String(pay.provider_transaction_id ?? "");
  const method = String(pay.method ?? "").toLowerCase();

  if (knownId) {
    const rails: Array<"card" | "ach"> = method === "ach"
      ? ["ach", "card"]
      : method === "card"
        ? ["card", "ach"]
        : ["card", "ach"];

    for (const rail of rails) {
      const got = await fetchTxnById(knownId, rail);
      if (got.txn) return { txn: got.txn, rail, source: `direct_${rail}` };
    }
  }

  const started = new Date(String(pay.initiated_at)).getTime();
  if (!Number.isFinite(started)) return null;
  // Helcim card date filters are documented in Mountain Time while our DB timestamps
  // are UTC. Query a wider date envelope; the amount/currency + uniqueness checks
  // below prevent a broad date query from being treated as an automatic match.
  const dateFrom = new Date(started - 12 * 60 * 60_000).toISOString().slice(0, 10);
  const dateTo = new Date(started + 12 * 60 * 60_000).toISOString().slice(0, 10);
  const base = Number(pay.amount_cents);
  const ceiling = Math.max(Math.ceil(base * 0.10), 200);
  const minAmount = Math.max(0, base) / 100;
  const maxAmount = (base + ceiling) / 100;

  const hits: Array<{ txn: Row; rail: "card" | "ach"; source: string }> = [];

  // Card collection: documented dateFrom/dateTo parameters.
  try {
    const url = `${HELCIM_API}/card-transactions?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&limit=1000`;
    const r = await helcimFetch(url);
    if (r.ok) {
      const body = await r.json().catch(() => null);
      for (const raw of asList(body)) {
        const txn = unwrapTxn(raw);
        if (!txn) continue;
        if (!isApprovedCard(txn)) continue;
        if (!candidateMatches(txn, pay, started, base, ceiling)) continue;
        hits.push({ txn, rail: "card", source: "card_collection" });
      }
    }
  } catch (e) {
    console.warn("[payment-reconcile] card collection lookup failed", e);
  }

  // ACH collection: documented startDate/endDate and amountMin/amountMax.
  try {
    const url = `${HELCIM_API}/ach/transactions?startDate=${encodeURIComponent(dateFrom)}&endDate=${encodeURIComponent(dateTo)}`
      + `&amountMin=${encodeURIComponent(String(minAmount))}&amountMax=${encodeURIComponent(String(maxAmount))}&limit=125`;
    const r = await helcimFetch(url);
    if (r.ok) {
      const body = await r.json().catch(() => null);
      for (const raw of asList(body)) {
        const txn = unwrapTxn(raw);
        if (!txn) continue;
        if (isAchFailed(txn)) continue;
        if (!candidateMatches(txn, pay, started, base, ceiling)) continue;
        hits.push({ txn, rail: "ach", source: "ach_collection" });
      }
    }
  } catch (e) {
    console.warn("[payment-reconcile] ACH collection lookup failed", e);
  }

  // Deduplicate the same transaction if it appeared more than once.
  const unique = new Map<string, { txn: Row; rail: "card" | "ach"; source: string }>();
  for (const h of hits) {
    const id = String(h.txn.transactionId ?? h.txn.id ?? `${h.rail}:${h.txn.dateCreated}:${h.txn.amount}`);
    unique.set(`${h.rail}:${id}`, h);
  }

  if (unique.size === 1) return [...unique.values()][0];
  if (unique.size > 1) {
    console.warn("[payment-reconcile] ambiguous provider match — leaving for review", {
      payment_id: pay.id,
      invoice_id: pay.invoice_id,
      candidates: unique.size,
    });
  }
  return null;
}

function candidateMatches(txn: Row, pay: Row, started: number, base: number, ceiling: number): boolean {
  const currency = normalizeCurrency(txn.currency);
  if (currency && currency !== normalizeCurrency(pay.currency)) return false;

  const cents = Math.round(Number(txn.amount ?? 0) * 100);
  if (cents < base || cents - base > ceiling) return false;

  const when = parseHelcimDate(txn.dateCreated ?? txn.createdAt ?? txn.date);
  if (!Number.isFinite(when)) return false;
  // Helcim dateCreated strings are timezone-naive. Allow the UTC/Mountain offset
  // here; if more than one candidate survives, we refuse to auto-link.
  if (Math.abs(when - started) > 12 * 60 * 60_000) return false;

  return true;
}

async function fetchTxnById(id: string, rail: "card" | "ach"): Promise<{ txn: Row | null; http: number }> {
  const path = rail === "ach"
    ? `ach/transactions/${encodeURIComponent(id)}`
    : `card-transactions/${encodeURIComponent(id)}`;
  try {
    const r = await helcimFetch(`${HELCIM_API}/${path}`);
    if (!r.ok) return { txn: null, http: r.status };
    return { txn: unwrapTxn(await r.json().catch(() => null)), http: r.status };
  } catch {
    return { txn: null, http: 0 };
  }
}

function helcimFetch(url: string) {
  return fetch(url, {
    headers: {
      "api-token": Deno.env.get("HELCIM_ADMIN_API_TOKEN")!,
      "accept": "application/json",
    },
  });
}

function asList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const o = body as Row;
  for (const k of ["data", "transactions", "items", "results"]) {
    if (Array.isArray(o[k])) return o[k];
  }
  return [body];
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

function isApprovedCard(txn: Row): boolean {
  const s = String(txn.status ?? "").toUpperCase();
  return s === "APPROVED" || s === "APPROVAL";
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

function providerStatus(txn: Row, isAch: boolean): string | null {
  return isAch
    ? String(txn.statusClearing ?? txn.statusAuth ?? txn.status ?? "") || null
    : String(txn.status ?? "") || null;
}

function normalizeCurrency(v: unknown): string {
  const s = String(v ?? "").toUpperCase();
  if (s === "1") return "CAD";
  if (s === "2") return "USD";
  return s;
}

function parseHelcimDate(v: unknown): number {
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  // Helcim commonly returns YYYY-MM-DD HH:mm:ss. Treat it as a parseable local-ish
  // timestamp only for a broad 85-minute correlation window.
  return new Date(s.includes("T") ? s : s.replace(" ", "T")).getTime();
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
    event,
    source: "reconcile",
    detail,
  });
  if (error) console.warn("[payment-reconcile] event insert failed", event, error.message);
}
