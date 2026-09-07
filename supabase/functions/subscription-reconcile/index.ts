// Scheduled reconciler for Helcim recurring subscriptions.
// - Provider subscription object is authoritative.
// - One Apex invoice + one Apex payment per Helcim subscription payment sub-object.
// - Replay-safe via unique (subscription_id, provider_subscription_payment_id/payment_number).
// - Card approved => paid only after a unique provider transaction is resolved.
// - ACH approved => pending until the unique ACH transaction is resolved and CLEARED.
// - Declined/failed => unpaid invoice + failed payment, subscription past_due.
// - Waiting provider payments are not materialized into Apex invoices yet.
// - Ambiguous transaction matching is NEVER guessed.
//
// v24.6 adds two things and changes no reconciliation logic:
//   1. Single-subscription mode. An authenticated admin can reconcile one
//      subscription on demand ({ subscription_id }). This reuses the SAME loop
//      body as the scheduled run, so there is exactly one reconciliation
//      implementation. service-plans-admin must not reimplement any of it.
//   2. Health recording, including on a rejected worker key — see 0009.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { helcimCall } from "../_shared/helcim-api.ts";

const FN_VERSION = "2026-09-07.v24.6";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_KEY = Deno.env.get("RECONCILE_WORKER_KEY") ?? "";
const TOKEN = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
type Row = Record<string, any>;

const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const ADMIN_EMAIL = (Deno.env.get("ADMIN_EMAIL") ?? "admin@apexliftsolutionsusa.com").toLowerCase();
const ORIGIN = Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("APP_BASE_URL") ?? "https://apexliftsolutionsusa.com";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const db = createClient(SB_URL, SB_SERVICE);
  const body = await req.json().catch(() => ({}));
  const wantsOne = String(body?.subscription_id ?? "").trim();

  // Two callers are allowed: the cron worker (shared key) and the signed-in
  // admin (JWT). Everything else is rejected — and a rejection is RECORDED,
  // because a silently-403ing cron job is the failure mode that would let
  // Helcim keep billing while Apex's ledger quietly stopped updating.
  const workerOk = !!WORKER_KEY && req.headers.get("x-worker-key") === WORKER_KEY;
  let source = "cron";
  let adminId: string | null = null;

  if (!workerOk) {
    const auth = req.headers.get("Authorization");
    let ok = false;
    if (auth && SB_ANON) {
      const uc = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await uc.auth.getUser();
      if (user && String(user.email ?? "").toLowerCase() === ADMIN_EMAIL) {
        ok = true; source = "admin"; adminId = user.id;
      }
    }
    if (!ok) {
      await db.rpc("record_sync_forbidden").catch(() => {});
      return Response.json({ error: "forbidden" }, { status: 403, headers: CORS });
    }
  }

  if (!TOKEN) {
    await db.rpc("record_sync_health", { p_source: source, p_ok: false, p_error: "helcim_not_configured" }).catch(() => {});
    return Response.json({ error: "helcim_not_configured" }, { status: 500, headers: CORS });
  }

  // Single-subscription mode. Cancelled and completed subscriptions ARE
  // reconcilable here on purpose: a refund, an ACH return or a late settlement
  // can land after billing stops, and an admin needs to be able to pull that in.
  // The scheduled sweep keeps its narrower active-set for cost reasons.
  let q = db.from("service_subscriptions").select("*")
    .eq("provider", "helcim")
    .not("provider_subscription_id", "is", null);

  q = wantsOne
    ? q.eq("id", wantsOne)
    : q.in("status", ["active", "past_due", "paused", "cancel_requested"])
       .order("created_at", { ascending: true }).limit(100);

  const { data: subs, error } = await q;
  if (error) {
    await db.rpc("record_sync_health", { p_source: source, p_ok: false, p_error: "subscription_query_failed" }).catch(() => {});
    return Response.json({ error: "subscription_query_failed" }, { status: 500, headers: CORS });
  }
  if (wantsOne && !(subs ?? []).length) {
    return Response.json({ error: "not_found_or_not_provider_bound" }, { status: 404, headers: CORS });
  }

  let synced = 0, invoicesCreated = 0, paymentsCreated = 0, paymentsUpdated = 0;
  let completed = 0, cancelled = 0, pastDue = 0, ambiguous = 0, providerErrors = 0;

  for (const s of subs ?? []) {
    const r = await helcimCall(`subscriptions/${s.provider_subscription_id}?includeSubObjects=true`, TOKEN);
    if (!r.ok) {
      providerErrors++;
      await event(db, s, "subscription_reconcile_provider_error", {
        provider_http: r.httpStatus, category: r.category, fn_version: FN_VERSION,
      });
      continue;
    }
    const p = unwrap(r.body);
    const mismatch = subscriptionMismatch(s, p);
    if (mismatch) {
      ambiguous++;
      await event(db, s, "subscription_provider_mismatch", { detail: mismatch, fn_version: FN_VERSION });
      continue;
    }

    let localPastDue = false;
    const providerPayments = Array.isArray(p.payments) ? p.payments : [];
    for (const pp of providerPayments) {
      const pst = String(pp?.status ?? "").toLowerCase();
      if (pst === "waiting") continue;
      const paymentNumber = toInt(pp?.paymentNumber);
      const providerPaymentId = toInt(pp?.id);
      if (!paymentNumber || !providerPaymentId) {
        ambiguous++;
        await event(db, s, "subscription_payment_invalid", { payment_number: paymentNumber, provider_payment_id: providerPaymentId });
        continue;
      }

      const dueDate = dateOnly(pp?.dateDue) || cycleDate(s.activation_date, paymentNumber - 1);
      const periodStart = dueDate;
      const periodEnd = endOfMonthlyPeriod(periodStart);
      const invoice = await ensureInvoice(db, s, paymentNumber, periodStart, periodEnd);
      if (!invoice) { ambiguous++; continue; }
      if (invoice.created) invoicesCreated++;

      let desired: "succeeded" | "pending" | "failed" | "unknown";
      let txn: Row | null = null;
      let methodDisplay: string | null = s.payment_method_display ?? null;
      const processedAt = parseProviderDate(pp?.dateProcessed) ?? parseProviderDate(pp?.dateDue) ?? Date.now();

      if (pst === "declined" || pst === "failed") {
        desired = "failed";
        localPastDue = true;
      } else if (pst === "approved") {
        const match = await findUniqueTransaction(db, s, Number(s.recurring_total_cents), processedAt);
        txn = match.txn;
        if (match.ambiguous) ambiguous++;
        if (s.payment_method === "ach") {
          if (!txn) desired = "pending";
          else if (isAchFailed(txn)) { desired = "failed"; localPastDue = true; }
          else if (isAchCleared(txn)) desired = "succeeded";
          else desired = "pending";
        } else {
          desired = txn && isApprovedCard(txn) ? "succeeded" : "unknown";
        }
        methodDisplay = maskedMethod(txn, s.payment_method) || methodDisplay;
      } else {
        // A provider status we do not understand must never be treated as paid.
        desired = "unknown";
      }

      const up = await ensurePayment(db, s, invoice.row, pp, desired, txn, methodDisplay);
      if (up.created) paymentsCreated++;
      if (up.updated) paymentsUpdated++;
      if (up.row?.status === "succeeded") {
        await db.from("invoices").update({ paid_via: "helcim", payment_id: up.row.id }).eq("id", invoice.row.id);
      }
      await db.rpc("recalc_invoice_status", { p_invoice_id: invoice.row.id });
    }

    const providerStatus = String(p.status ?? "").toLowerCase();
    const timesBilled = Math.max(0, Number(p.timesBilled ?? s.times_billed ?? 0));
    const maxCycles = Math.max(1, Number(s.max_cycles ?? s.term_months ?? 1));
    const failed = truthy(p.hasFailedPayments) || localPastDue;
    let localStatus = String(s.status);
    if ((providerStatus === "term_ended" || providerStatus === "cancelled") && timesBilled >= maxCycles) {
      localStatus = "completed"; completed++;
    } else if (providerStatus === "cancelled") {
      localStatus = "cancelled"; cancelled++;
    } else if (providerStatus === "paused") {
      localStatus = "paused";
    } else if (failed) {
      localStatus = "past_due"; pastDue++;
    } else if (providerStatus === "active" || providerStatus === "term_ending") {
      localStatus = "active";
    }

    const now = new Date().toISOString();
    await db.from("service_subscriptions").update({
      status: localStatus,
      times_billed: timesBilled,
      has_failed_payments: failed,
      next_billing_date: validFutureDate(p.dateBilling),
      provider_verified_at: now,
      provider_cancel_confirmed: localStatus === "cancelled" ? true : s.provider_cancel_confirmed,
      cancelled_at: localStatus === "cancelled" ? (s.cancelled_at ?? now) : s.cancelled_at,
      last_synced_at: now,
      updated_at: now,
    }).eq("id", s.id);
    synced++;
  }

  // Health is recorded for BOTH the scheduled sweep and an admin's on-demand
  // sync. A provider error inside the loop does not fail the run — the run
  // completed — but the count is surfaced so a persistent provider problem is
  // visible in the admin UI rather than only in function logs.
  await db.rpc("record_sync_health", {
    p_source: source,
    p_ok: true,
    p_error: null,
    p_scanned: subs?.length ?? 0,
    p_invoices: invoicesCreated,
    p_payments_created: paymentsCreated,
    p_payments_updated: paymentsUpdated,
    p_ambiguous: ambiguous,
    p_provider_errors: providerErrors,
  }).catch(() => {});

  if (source === "admin" && wantsOne) {
    await db.from("service_plan_events").insert({
      event: "subscription_synced", source: "admin",
      subscription_id: wantsOne, customer_id: subs?.[0]?.customer_id ?? null,
      detail: { by: adminId, invoices_created: invoicesCreated,
                payments_created: paymentsCreated, payments_updated: paymentsUpdated,
                ambiguous, provider_errors: providerErrors, fn_version: FN_VERSION },
    }).catch?.(() => {});
  }

  // The freshly-reconciled row is returned so the admin UI renders provider
  // truth rather than the state it had before the sync.
  let subscription: Row | null = null;
  if (wantsOne) {
    const { data } = await db.from("service_subscriptions").select("*").eq("id", wantsOne).maybeSingle();
    subscription = data ?? null;
  }

  return Response.json({
    ok: true, fn_version: FN_VERSION, mode: wantsOne ? "single" : "sweep",
    source, checked: subs?.length ?? 0, synced,
    invoices_created: invoicesCreated, payments_created: paymentsCreated,
    payments_updated: paymentsUpdated, completed, cancelled, past_due: pastDue,
    ambiguous, provider_errors: providerErrors,
    subscription,
  }, { headers: CORS });
});

async function ensureInvoice(db: any, s: Row, paymentNumber: number, start: string, end: string) {
  const existing = await db.from("invoices").select("*")
    .eq("subscription_id", s.id).eq("billing_period_start", start).maybeSingle();
  if (existing.data) return { row: existing.data, created: false };
  const [{ data: cust }, { data: a }, { data: eq }] = await Promise.all([
    db.from("customers").select("email,name,company").eq("id", s.customer_id).maybeSingle(),
    db.from("service_plan_agreements").select("monthly_subtotal_cents,monthly_tax_cents,monthly_total_cents,snapshot").eq("id", s.agreement_id).maybeSingle(),
    db.from("customer_equipment").select("unit_number,year,make,model,serial_number").eq("id", s.equipment_id).maybeSingle(),
  ]);
  if (!cust || !a) return null;
  const snap = a.snapshot ?? {};
  const taxRate = Number(snap?.offer?.tax_rate_milli_pct ?? snap?.tax_rate_milli_pct ?? 0);
  const taxExempt = Boolean(snap?.offer?.tax_exempt ?? snap?.tax_exempt ?? false);
  const taxJurisdiction = String(snap?.offer?.tax_jurisdiction ?? snap?.tax_jurisdiction ?? "") || null;
  const equipment = [eq?.unit_number, eq?.year, eq?.make, eq?.model].filter(Boolean).join(" — ") || "Forklift";
  const amount = Number((Number(s.recurring_total_cents) / 100).toFixed(2));
  const row = {
    customer_id: s.customer_id,
    customer_email: cust.email,
    customer_name: cust.name,
    company: cust.company,
    description: `Monthly Service Plan — ${equipment} — Payment ${paymentNumber} of ${s.max_cycles}`,
    items: [{ description: `Fixed-term monthly maintenance — payment ${paymentNumber} of ${s.max_cycles}`, quantity: 1, amount }],
    subtotal_cents: Number(s.recurring_subtotal_cents),
    tax_cents: Number(s.recurring_tax_cents),
    tax_rate_milli_pct: taxRate,
    tax_exempt: taxExempt,
    tax_jurisdiction: taxJurisdiction,
    amount,
    status: "unpaid",
    due: `${start}T23:59:59Z`,
    invoice_source: "recurring",
    subscription_id: s.id,
    billing_period_start: start,
    billing_period_end: end,
  };
  const ins = await db.from("invoices").insert(row).select("*").single();
  if (ins.error) {
    // Concurrent replay: unique period index wins. Read the winner.
    const retry = await db.from("invoices").select("*")
      .eq("subscription_id", s.id).eq("billing_period_start", start).maybeSingle();
    if (retry.data) return { row: retry.data, created: false };
    console.error("[subscription-reconcile] invoice insert", ins.error);
    return null;
  }
  return { row: ins.data, created: true };
}

async function ensurePayment(db: any, s: Row, inv: Row, pp: Row,
  desired: "succeeded" | "pending" | "failed" | "unknown", txn: Row | null, methodDisplay: string | null) {
  const existing = await db.from("payments").select("*")
    .eq("subscription_id", s.id).eq("provider_subscription_payment_id", Number(pp.id)).eq("kind", "payment").maybeSingle();
  const now = new Date().toISOString();
  const txnId = txn ? String(txn.transactionId ?? txn.id ?? "") || null : null;
  const patch: Row = {
    status: desired,
    provider_transaction_id: txnId,
    method_display: methodDisplay,
    failure_category: desired === "failed" ? `recurring_${String(pp.status ?? "failed").toLowerCase()}` : desired === "unknown" ? "recurring_transaction_unresolved" : null,
    approved_at: desired === "succeeded" || desired === "pending" ? now : null,
    settled_at: desired === "succeeded" ? now : null,
    declined_at: desired === "failed" ? now : null,
    completed_at: ["succeeded", "failed"].includes(desired) ? now : null,
    fee_cents: 0,
    total_charged_cents: desired === "succeeded" || desired === "pending" ? Number(s.recurring_total_cents) : null,
  };
  if (existing.data) {
    const cur = existing.data;
    // A succeeded ledger row is immutable by trigger. Never try to downgrade it.
    if (cur.status === "succeeded") return { row: cur, created: false, updated: false };
    // Do not replace one known provider transaction id with another.
    if (cur.provider_transaction_id && txnId && String(cur.provider_transaction_id) !== txnId) {
      await event(db, s, "recurring_transaction_conflict", { payment_id: cur.id, old: cur.provider_transaction_id, new: txnId });
      return { row: cur, created: false, updated: false };
    }
    if (cur.provider_transaction_id && !txnId) delete patch.provider_transaction_id;
    const u = await db.from("payments").update(patch).eq("id", cur.id).select("*").single();
    if (u.error) { console.error("[subscription-reconcile] payment update", u.error); return { row: cur, created: false, updated: false }; }
    return { row: u.data, created: false, updated: true };
  }

  const row = {
    invoice_id: inv.id,
    customer_id: s.customer_id,
    provider: "helcim",
    kind: "payment",
    method: s.payment_method,
    amount_cents: Number(s.recurring_total_cents),
    currency: s.currency,
    ...patch,
    payment_source: "recurring",
    subscription_id: s.id,
    billing_period_start: inv.billing_period_start,
    billing_period_end: inv.billing_period_end,
    provider_subscription_payment_id: Number(pp.id),
    provider_payment_number: Number(pp.paymentNumber),
    initiated_at: dateIso(pp.dateProcessed) ?? now,
  };
  const ins = await db.from("payments").insert(row).select("*").single();
  if (ins.error) {
    const retry = await db.from("payments").select("*")
      .eq("subscription_id", s.id).eq("provider_subscription_payment_id", Number(pp.id)).eq("kind", "payment").maybeSingle();
    if (retry.data) return { row: retry.data, created: false, updated: false };
    console.error("[subscription-reconcile] payment insert", ins.error);
    return { row: null, created: false, updated: false };
  }
  await db.from("payment_events").insert({
    payment_id: ins.data.id, invoice_id: inv.id, source: "subscription_reconcile",
    event: desired === "succeeded" ? "recurring_paid" : desired === "failed" ? "recurring_failed" : "recurring_processing",
    detail: { subscription_id: s.id, provider_subscription_id: s.provider_subscription_id, provider_payment_id: pp.id, payment_number: pp.paymentNumber, fn_version: FN_VERSION },
  });
  return { row: ins.data, created: true, updated: false };
}

async function findUniqueTransaction(db: any, s: Row, cents: number, processedAt: number) {
  const used = await db.from("payments").select("provider_transaction_id")
    .eq("provider", "helcim").not("provider_transaction_id", "is", null);
  const usedIds = new Set((used.data ?? []).map((x: Row) => String(x.provider_transaction_id)));
  const day = new Date(processedAt).toISOString().slice(0, 10);
  const prev = new Date(processedAt - 12 * 3600_000).toISOString().slice(0, 10);
  const next = new Date(processedAt + 12 * 3600_000).toISOString().slice(0, 10);
  const hits: Row[] = [];

  if (s.payment_method === "card") {
    const r = await helcimCall(`card-transactions?customerCode=${encodeURIComponent(String(s.provider_customer_code))}&dateFrom=${prev}&dateTo=${next}&limit=1000`, TOKEN);
    if (r.ok) for (const raw of list(r.body)) {
      const t = unwrapTxn(raw); if (!t || !isApprovedCard(t)) continue;
      const id = String(t.transactionId ?? t.id ?? ""); if (!id || usedIds.has(id)) continue;
      if (String(t.customerCode ?? "") !== String(s.provider_customer_code)) continue;
      if (Math.round(Number(t.amount ?? 0) * 100) !== cents) continue;
      if (!near(t.dateCreated, processedAt)) continue;
      hits.push(t);
    }
  } else {
    const amount = Number((cents / 100).toFixed(2));
    const r = await helcimCall(`ach/transactions?startDate=${prev}&endDate=${next}&amountMin=${amount}&amountMax=${amount}&limit=125`, TOKEN);
    if (r.ok) for (const raw of list(r.body)) {
      const t = unwrapTxn(raw); if (!t) continue;
      const id = String(t.transactionId ?? t.id ?? ""); if (!id || usedIds.has(id)) continue;
      if (Math.round(Number(t.amount ?? 0) * 100) !== cents) continue;
      if (!near(t.dateCreated, processedAt)) continue;
      hits.push(t);
    }
  }
  const uniq = new Map<string, Row>();
  for (const t of hits) uniq.set(String(t.transactionId ?? t.id), t);
  return { txn: uniq.size === 1 ? [...uniq.values()][0] : null, ambiguous: uniq.size > 1 };
}

function subscriptionMismatch(s: Row, p: Row) {
  if (Number(p.id) !== Number(s.provider_subscription_id)) return "provider subscription id differs";
  if (String(p.customerCode ?? "") !== String(s.provider_customer_code ?? "")) return "customerCode differs";
  if (Number(p.paymentPlanId) !== Number(s.provider_payment_plan_id)) return "payment plan differs";
  if (Math.round(Number(p.recurringAmount ?? 0) * 100) !== Number(s.recurring_total_cents)) return "recurring amount differs";
  if (String(p.dateActivated ?? "") !== String(s.activation_date ?? "")) return "activation date differs";
  return null;
}
async function event(db:any,s:Row,name:string,detail:Row){await db.from("service_plan_events").insert({event:name,source:"reconcile",customer_id:s.customer_id,equipment_id:s.equipment_id,offer_id:s.offer_id,agreement_id:s.agreement_id,subscription_id:s.id,detail});}
function unwrap(b:any):Row{if(Array.isArray(b))return b[0]??{};if(b?.data&&!Array.isArray(b.data)&&typeof b.data==="object")return b.data;return b??{}}
function list(b:any):any[]{if(Array.isArray(b))return b;if(!b||typeof b!=="object")return[];for(const k of ["data","transactions","results","items"]){if(Array.isArray(b[k]))return b[k]}return[b]}
function unwrapTxn(raw:any):Row|null{if(!raw||typeof raw!=="object")return null;if(raw.transaction&&typeof raw.transaction==="object")return raw.transaction;if(raw.data&&typeof raw.data==="object")return raw.data.transaction??raw.data.data??raw.data;return raw}
function isApprovedCard(t:Row){const x=String(t.status??"").toUpperCase();return x==="APPROVED"||x==="APPROVAL"}
function isAchCleared(t:Row){const c=String(t.statusClearing??t.settlementStatus??"").toUpperCase();const a=String(t.statusAuth??t.status??"").toUpperCase();return ["1","CLEARED","SETTLED","COMPLETED"].includes(c)&&!["2","4","DECLINED","CANCELLED","FAILED","REJECTED","RETURNED"].includes(a)}
function isAchFailed(t:Row){const c=String(t.statusClearing??"").toUpperCase();const a=String(t.statusAuth??t.status??"").toUpperCase();return ["2","4","DECLINED","CANCELLED","FAILED","REJECTED","RETURNED"].includes(a)||["4","REJECTED","RETURNED","CONTESTED"].includes(c)}
function maskedMethod(t:Row|null,rail:string){if(!t)return null;if(rail==="card"){const brand=String(t.cardType??"Card");const n=String(t.cardNumber??"").replace(/\D/g,"");return n?`${brand} ····${n.slice(-4)}`:brand}const n=String(t.bankAccountL4L4??t.bankAccountNumber??"").replace(/\D/g,"");return n?`Bank ····${n.slice(-4)}`:"Bank account"}
function truthy(v:any){return v===true||v===1||["true","yes","1"].includes(String(v).toLowerCase())}
function toInt(v:any){const n=Number(v);return Number.isInteger(n)&&n>0?n:null}
function dateOnly(v:any){const m=String(v??"").match(/^(\d{4}-\d{2}-\d{2})/);return m?.[1]??null}
function validFutureDate(v:any){const d=dateOnly(v);return d&&d!=="0000-00-00"?d:null}
function cycleDate(start:string,months:number){const [y,m,d]=String(start).split("-").map(Number);const x=new Date(Date.UTC(y,m-1+months,d));return x.toISOString().slice(0,10)}
function endOfMonthlyPeriod(start:string){const [y,m,d]=start.split("-").map(Number);const next=new Date(Date.UTC(y,m,d));next.setUTCDate(next.getUTCDate()-1);return next.toISOString().slice(0,10)}
function parseProviderDate(v:any){const s=String(v??"");if(!s||s.startsWith("0000-00-00"))return null;const ms=Date.parse(s.includes("T")?s:s.replace(" ","T")+"Z");return Number.isFinite(ms)?ms:null}
function dateIso(v:any){const ms=parseProviderDate(v);return ms?new Date(ms).toISOString():null}
function near(v:any,at:number){const ms=parseProviderDate(v);return ms!=null&&Math.abs(ms-at)<=12*3600_000}
