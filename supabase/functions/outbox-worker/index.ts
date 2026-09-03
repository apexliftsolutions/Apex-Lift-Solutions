// Drains notification_outbox through Resend. Called by pg_cron every minute.
// Idempotent: a row is claimed by moving pending -> processing before send.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { render, sendViaResend } from "../_shared/email.ts";

const MAX_ATTEMPTS = 8;
const backoffMin = (n: number) => Math.min(2 ** n, 240);   // 2,4,8,…,240 minutes

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
      const { subject, html, text } = render(row.event_type, row.payload ?? {});
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
