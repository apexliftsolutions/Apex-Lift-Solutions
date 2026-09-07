// POST /payment-refund   body: { payment_id, amount?, reason } — ADMIN ONLY
//
// One endpoint for Apex admin refunds/voids:
// - Card full amount: try POST /v2/payment/reverse first (open batch), then
//   POST /v2/payment/refund if the batch is already closed.
// - Card partial amount: refund only.
// - ACH: fetch the authoritative ACH transaction first. Open+approved can be
//   voided only for the full remaining amount; closed+approved is refunded via
//   the ACH refund endpoint. ACH refunds remain pending until clearing.
//
// Apex writes an initiated correction row before contacting Helcim for
// idempotency/audit, but it only counts financially after Helcim accepts it.
import { createClient } from "jsr:@supabase/supabase-js@2";

const HELCIM_API = "https://api.helcim.com/v2";
type Row = Record<string, any>;

type ProviderResult = {
  ok: boolean;
  httpStatus: number;
  category: "ok" | "auth" | "permission" | "declined" | "network" | "bad_json";
  body: Row | null;
  text: string | null;
};

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
  if (!user || user.email !== "admin@apexliftsolutionsusa.com") return j({ error: "forbidden" }, 403, cors);

  const { payment_id, amount, reason } = await req.json().catch(() => ({}));
  if (!payment_id) return j({ error: "bad_request" }, 400, cors);
  const reasonText = typeof reason === "string" ? reason.trim() : "";
  if (!reasonText) return j({ error: "reason_required", message: "A refund/void reason is required." }, 400, cors);
  if (reasonText.length > 500) return j({ error: "reason_too_long", message: "Reason must be 500 characters or less." }, 400, cors);

  const { data: orig, error: origErr } = await sb.from("payments")
    .select("*").eq("id", payment_id).eq("kind", "payment").maybeSingle();
  if (origErr) return j({ error: "ledger_read_failed", detail: origErr.message }, 500, cors);
  if (!orig) return j({ error: "not_found" }, 404, cors);
  if (orig.status !== "succeeded" || orig.provider !== "helcim" || !orig.provider_transaction_id) {
    return j({ error: "not_refundable" }, 409, cors);
  }

  const { data: prior, error: priorErr } = await sb.from("payments")
    .select("amount_cents,status,kind")
    .eq("refund_of", orig.id)
    .in("kind", ["refund", "reversal"]);
  if (priorErr) return j({ error: "ledger_read_failed", detail: priorErr.message }, 500, cors);

  const returned = (prior ?? [])
    .filter((r: Row) => r.status === "succeeded")
    .reduce((sum: number, r: Row) => sum + Number(r.amount_cents || 0), 0);
  const inFlight = (prior ?? []).some((r: Row) => ["initiated", "pending", "unknown"].includes(String(r.status)));
  if (inFlight) return j({ error: "refund_already_processing" }, 409, cors);

  const refundable = Math.max(0, Number(orig.amount_cents) - returned);
  const want = amount != null ? Math.round(Number(amount) * 100) : refundable;
  if (!(want > 0) || want > refundable) {
    return j({ error: "amount_exceeds_refundable", refundable_cents: refundable }, 400, cors);
  }

  const idem = crypto.randomUUID();
  const { data: correction, error: insErr } = await sb.from("payments").insert({
    invoice_id: orig.invoice_id,
    customer_id: orig.customer_id,
    provider: "helcim",
    kind: "refund",
    method: orig.method,
    amount_cents: want,
    fee_cents: 0,
    total_charged_cents: null,
    currency: orig.currency,
    status: "initiated",
    idempotency_key: idem,
    refund_of: orig.id,
    notes: reasonText,
    recorded_by: user.id,
    // Preserve the workflow axis. Recurring corrections stay attached to the
    // service subscription, but intentionally carry no cycle identity; refund_of
    // is the authoritative link to the original recurring charge.
    payment_source: orig.payment_source ?? "one_time",
    subscription_id: orig.payment_source === "recurring" ? orig.subscription_id : null,
    billing_period_start: null,
    billing_period_end: null,
    provider_subscription_payment_id: null,
    provider_payment_number: null,
  }).select().single();
  if (insErr || !correction) return j({ error: "ledger_error", detail: insErr?.message ?? null }, 500, cors);

  const token = Deno.env.get("HELCIM_ADMIN_API_TOKEN")!;
  const isAch = orig.method === "ach";
  const fullRemaining = want === refundable;
  const now = new Date().toISOString();
  let action: "reverse" | "refund" = "refund";
  let provider: ProviderResult;
  let correctionStatus: "succeeded" | "pending" | "failed" = "failed";

  if (isAch) {
    // ACH actions depend on the authoritative batch/auth state.
    const lookup = await helcim(`${HELCIM_API}/ach/transactions/${encodeURIComponent(String(orig.provider_transaction_id))}`,
      token, { method: "GET" });
    if (!lookup.ok) {
      await failCorrection(sb, correction, orig, "ach_lookup_failed", lookup, now);
      return providerErrorResponse(lookup, cors);
    }

    const ach = unwrapTxn(lookup.body) ?? {};
    const statusBatch = Number(ach.statusBatch ?? 0);
    const statusAuth = Number(ach.statusAuth ?? 0);

    if (statusAuth === 2 || statusAuth === 4) {
      await failCorrection(sb, correction, orig, "ach_not_refundable", lookup, now);
      return j({ error: "ach_not_refundable", status_auth: statusAuth, status_batch: statusBatch }, 409, cors);
    }

    if (statusBatch === 1 && statusAuth === 1) {
      if (!fullRemaining) {
        await failCorrection(sb, correction, orig, "ach_open_batch_partial", lookup, now);
        return j({ error: "ach_open_batch_partial_not_supported",
          message: "This ACH payment is still in an open batch. Helcim only allows a full void while open; wait for the batch to close before issuing a partial refund." }, 409, cors);
      }
      action = "reverse";
      provider = await helcim(`${HELCIM_API}/ach/transactions/${encodeURIComponent(String(orig.provider_transaction_id))}/void`,
        token, { method: "PUT", idem: crypto.randomUUID() });
      correctionStatus = provider.ok ? "succeeded" : "failed";
    } else if (statusBatch === 2 && statusAuth === 1) {
      action = "refund";
      provider = await helcim(`${HELCIM_API}/ach/transactions/${encodeURIComponent(String(orig.provider_transaction_id))}/refund`,
        token, { method: "PUT", idem: crypto.randomUUID(), body: { amount: Number((want / 100).toFixed(2)) } });
      // ACH refund creation is not settlement; keep it pending until reconcile sees
      // the refund transaction clear.
      correctionStatus = provider.ok ? "pending" : "failed";
    } else {
      await failCorrection(sb, correction, orig, "ach_state_not_actionable", lookup, now);
      return j({ error: "ach_state_not_actionable", status_auth: statusAuth, status_batch: statusBatch }, 409, cors);
    }
  } else {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
    provider = { ok: false, httpStatus: 0, category: "declined", body: null, text: null };

    if (fullRemaining) {
      const reverse = await helcim(`${HELCIM_API}/payment/reverse`, token, {
        method: "POST",
        idem: crypto.randomUUID(),
        body: { cardTransactionId: Number(orig.provider_transaction_id), ipAddress: ip },
      });
      if (providerApproved(reverse)) {
        provider = reverse;
        action = "reverse";
      }
    }

    if (!providerApproved(provider)) {
      provider = await helcim(`${HELCIM_API}/payment/refund`, token, {
        method: "POST",
        idem: crypto.randomUUID(),
        body: {
          originalTransactionId: Number(orig.provider_transaction_id),
          amount: Number((want / 100).toFixed(2)),
          ipAddress: ip,
        },
      });
      action = "refund";
    }
    correctionStatus = providerApproved(provider) ? "succeeded" : "failed";
  }

  if (provider.category === "auth" || provider.category === "permission") {
    await failCorrection(sb, correction, orig, `helcim_${provider.category}`, provider, now);
    return providerErrorResponse(provider, cors);
  }

  const out = unwrapTxn(provider.body) ?? provider.body ?? {};
  const providerId = String(out.transactionId ?? out.id ?? out.cardTransactionId ?? "") || null;
  const success = correctionStatus !== "failed";

  const { error: updateErr } = await sb.from("payments").update({
    status: correctionStatus,
    kind: action === "reverse" ? "reversal" : "refund",
    provider_transaction_id: providerId,
    failure_category: success ? null : `${action}_declined`,
    approved_at: success ? now : null,
    settled_at: correctionStatus === "succeeded" ? now : null,
    completed_at: correctionStatus === "pending" ? null : now,
    fee_cents: 0,
    total_charged_cents: want,
  }).eq("id", correction.id);

  if (updateErr) {
    console.error("[payment-refund] correction ledger update failed", updateErr);
    return j({ error: "ledger_update_failed", provider_action_succeeded: success }, 500, cors);
  }

  await sb.from("payment_events").insert({
    payment_id: correction.id,
    invoice_id: orig.invoice_id,
    source: "admin",
    event: success
      ? (action === "reverse" ? "reversed" : correctionStatus === "pending" ? "refund_pending" : "refunded")
      : "declined",
    detail: {
      action,
      refund_of: orig.id,
      amount_cents: want,
      http: provider.httpStatus,
      category: provider.category,
      provider_transaction_id: providerId,
      reason: reasonText,
    },
  });

  // Only succeeded corrections affect net collected now. A pending ACH refund
  // will be applied when payment-reconcile marks the correction succeeded.
  if (success && correctionStatus === "succeeded") {
    const { error: recalcErr } = await sb.rpc("recalc_invoice_status", { p_invoice_id: orig.invoice_id });
    if (recalcErr) console.error("[payment-refund] recalc failed", recalcErr);
  }

  await sb.from("activity_log").insert({
    actor_id: user.id,
    action: success ? `payment_${action}ed` : `${action}_failed`,
    detail: `${orig.invoice_id} $${(want / 100).toFixed(2)} — ${reasonText}`,
  });

  if (!success) {
    return j({ error: `${action}_declined`, http: provider.httpStatus,
      provider_message: provider.text }, 502, cors);
  }

  return j({
    ok: true,
    action,
    refund_id: correction.id,
    amount_cents: want,
    status: correctionStatus,
    provider_transaction_id: providerId,
    reason: reasonText,
  }, 200, cors);
});

async function failCorrection(
  sb: ReturnType<typeof createClient>, correction: Row, orig: Row,
  failure: string, provider: ProviderResult, now: string,
) {
  await sb.from("payments").update({
    status: "failed",
    failure_category: failure,
    completed_at: now,
  }).eq("id", correction.id);
  await sb.from("payment_events").insert({
    payment_id: correction.id,
    invoice_id: orig.invoice_id,
    source: "admin",
    event: "declined",
    detail: { failure, http: provider.httpStatus, category: provider.category },
  });
}

function providerErrorResponse(r: ProviderResult, cors: Record<string, string>) {
  if (r.category === "auth" || r.category === "permission") {
    return j({ error: "provider_auth_failed",
      message: "Helcim rejected the admin API request. Check HELCIM_ADMIN_API_TOKEN and API Access permissions." }, 502, cors);
  }
  return j({ error: "provider_request_failed", http: r.httpStatus, provider_message: r.text }, 502, cors);
}

function providerApproved(r: ProviderResult): boolean {
  if (!r.ok) return false;
  const t = unwrapTxn(r.body) ?? r.body ?? {};
  const status = String(t.status ?? "").toUpperCase();
  // Current card refund/reverse responses report APPROVED. Keep an HTTP-only
  // fallback only when the response has no status field at all.
  return !status || status === "APPROVED" || status === "APPROVAL";
}

async function helcim(
  url: string,
  token: string,
  opts: { method: "GET" | "POST" | "PUT"; idem?: string; body?: Row },
): Promise<ProviderResult> {
  try {
    const headers: Record<string, string> = { "api-token": token, "accept": "application/json" };
    if (opts.body) headers["content-type"] = "application/json";
    if (opts.idem) headers["idempotency-key"] = opts.idem;
    const res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: Row | null = null;
    if (text) {
      try { body = JSON.parse(text); } catch { /* retain text below */ }
    }
    const category: ProviderResult["category"] = res.ok ? "ok"
      : res.status === 401 ? "auth"
      : res.status === 403 ? "permission"
      : "declined";
    return { ok: res.ok, httpStatus: res.status, category, body, text: text ? text.slice(0, 300) : null };
  } catch (e) {
    return { ok: false, httpStatus: 0, category: "network", body: null,
      text: e instanceof Error ? e.message : String(e) };
  }
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

function j(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
