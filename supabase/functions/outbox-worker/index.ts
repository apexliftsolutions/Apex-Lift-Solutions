// Drains notification_outbox through Resend. Called by pg_cron every minute.
// Idempotent: a row is claimed by moving pending -> processing before send.
//
// v22: refund/void messages are rendered here with authoritative ledger data so
// the customer/admin email always includes amount, reason, references, and the
// resulting invoice state even if an older notification payload omitted them.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { render, sendViaResend } from "../_shared/email.ts";

const MAX_ATTEMPTS = 8;
const backoffMin = (n: number) => Math.min(2 ** n, 240);   // 2,4,8,…,240 minutes
const CORRECTION_EVENTS = new Set([
  "payment_refunded",
  "payment_refunded_admin",
  "payment_voided",
  "payment_voided_admin",
]);

type SB = ReturnType<typeof createClient>;
type OutboxRow = Record<string, any>;

type Message = { subject: string; html: string; text: string };

Deno.serve(async (req) => {
  // Shared-secret gate: only the cron job (or admin ops) may run the worker.
  if (req.headers.get("x-outbox-key") !== Deno.env.get("OUTBOX_WORKER_KEY")) {
    return new Response("Forbidden", { status: 403 });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: rows } = await sb.from("notification_outbox")
    .select("*").eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
    .order("created_at").limit(25);

  let sent = 0, failed = 0;
  for (const row of rows ?? []) {
    // Claim it. If another worker got there first, the update matches 0 rows.
    const { data: claimed } = await sb.from("notification_outbox")
      .update({ status: "processing", attempt_count: row.attempt_count + 1 })
      .eq("id", row.id).eq("status", "pending").select("id").maybeSingle();
    if (!claimed) continue;

    try {
      const { subject, html, text } = await buildMessage(sb, row);
      const msgId = await sendViaResend(row.recipient, subject, html, text);
      await sb.from("notification_outbox").update({ status: "sent", sent_at: new Date().toISOString(),
        provider_msg_id: msgId ?? null, last_error: null }).eq("id", row.id);
      await sb.from("activity_log").insert({ action: "email_sent", detail: `${row.event_type} → ${row.recipient}` });
      sent++;
    } catch (e) {
      const n = row.attempt_count + 1;
      const dead = n >= MAX_ATTEMPTS;
      await sb.from("notification_outbox").update({
        status: dead ? "failed" : "pending",
        last_error: String(e).slice(0, 500),
        next_attempt_at: new Date(Date.now() + backoffMin(n) * 60_000).toISOString(),
      }).eq("id", row.id);
      await sb.from("activity_log").insert({ action: dead ? "email_failed" : "email_retry", detail: `${row.event_type} → ${row.recipient}: ${String(e).slice(0,120)}` });
      failed++;
    }
  }
  return Response.json({ sent, failed });
});

async function buildMessage(sb: SB, row: OutboxRow): Promise<Message> {
  if (!CORRECTION_EVENTS.has(String(row.event_type))) {
    return render(row.event_type, row.payload ?? {});
  }

  const payload = row.payload ?? {};
  let correction: Record<string, any> | null = null;
  let original: Record<string, any> | null = null;
  let invoice: Record<string, any> | null = null;

  // entity_id is the correction payment UUID for payment notifications.
  if (row.entity_id) {
    const { data } = await sb.from("payments")
      .select("id,invoice_id,kind,status,amount_cents,provider_transaction_id,reference,refund_of,notes,created_at,approved_at,settled_at,completed_at")
      .eq("id", row.entity_id).maybeSingle();
    correction = data ?? null;
  }

  const invoiceId = String(correction?.invoice_id ?? payload.invoice_id ?? "");
  if (invoiceId) {
    const { data } = await sb.from("invoices")
      .select("id,status,customer_name,company,amount")
      .eq("id", invoiceId).maybeSingle();
    invoice = data ?? null;
  }

  const originalId = correction?.refund_of ?? payload.original_payment_id ?? null;
  if (originalId) {
    const { data } = await sb.from("payments")
      .select("id,amount_cents,provider_transaction_id,reference,method_display,method")
      .eq("id", originalId).maybeSingle();
    original = data ?? null;
  }

  // Older database functions used payment_refunded for reversals too. The ledger
  // kind is authoritative, so the email wording remains correct for those rows.
  const isVoid = correction?.kind === "reversal" || String(row.event_type).startsWith("payment_voided");
  const isAdmin = String(row.event_type).endsWith("_admin");
  const action = isVoid ? "Payment Voided / Reversed" : "Refund Processed";
  const amountCents = Number(correction?.amount_cents ?? Math.round(Number(payload.refund_amount ?? payload.amount ?? 0) * 100));
  const reason = String(correction?.notes ?? payload.reason ?? "No reason provided");
  const correctionRef = String(correction?.provider_transaction_id ?? correction?.reference ?? payload.reference ?? "—");
  const originalRef = String(original?.provider_transaction_id ?? original?.reference ?? "—");
  const resultingStatus = String(invoice?.status ?? payload.invoice_status ?? "—").replaceAll("_", " ");
  const customerName = String(invoice?.customer_name ?? payload.customer_name ?? "Customer");
  const company = String(invoice?.company ?? payload.company ?? "");
  const whenRaw = correction?.completed_at ?? correction?.settled_at ?? correction?.approved_at ?? correction?.created_at ?? new Date().toISOString();
  const when = new Date(whenRaw).toLocaleString("en-US", { timeZone: "America/New_York" });
  const amount = money(amountCents);
  const originalAmount = original ? money(Number(original.amount_cents || 0)) : "—";

  const subject = isAdmin
    ? `[Apex Admin] ${action} — ${invoiceId || "payment"} — ${amount}`
    : `${action} — ${invoiceId || "Apex payment"} — ${amount}`;

  const intro = isVoid
    ? `A payment of ${amount} was successfully voided/reversed through Helcim.`
    : `A refund of ${amount} was successfully processed through Helcim.`;

  const rows = [
    ["Invoice", invoiceId || "—"],
    [isVoid ? "Voided amount" : "Refund amount", amount],
    ["Reason", reason],
    ["Original payment amount", originalAmount],
    ["Original payment reference", originalRef],
    [isVoid ? "Void/reversal reference" : "Refund reference", correctionRef],
    ["Resulting invoice status", titleCase(resultingStatus)],
    ["Processed", when],
  ];

  const htmlRows = rows.map(([k, v]) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;">${esc(k)}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${esc(v)}</td></tr>`
  ).join("");

  const adminExtra = isAdmin
    ? `<p style="margin-top:16px;color:#555;">Customer: <strong>${esc(customerName)}</strong>${company ? ` — ${esc(company)}` : ""}</p>`
    : "";

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;">
    <div style="max-width:640px;margin:0 auto;padding:24px;">
      <h2 style="margin:0 0 12px;color:#b00000;">${esc(action)}</h2>
      <p>${esc(intro)}</p>
      ${adminExtra}
      <table style="width:100%;border-collapse:collapse;margin-top:18px;">${htmlRows}</table>
      <p style="margin-top:22px;color:#666;font-size:13px;">Apex Lift Solutions · (516) 644-7187 · apexliftsolutionsusa.com</p>
    </div></body></html>`;

  const text = [
    action,
    "",
    intro,
    isAdmin ? `Customer: ${customerName}${company ? ` — ${company}` : ""}` : "",
    ...rows.map(([k, v]) => `${k}: ${v}`),
    "",
    "Apex Lift Solutions · (516) 644-7187 · apexliftsolutionsusa.com",
  ].filter(Boolean).join("\n");

  return { subject, html, text };
}

function money(cents: number): string {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] ?? c));
}
