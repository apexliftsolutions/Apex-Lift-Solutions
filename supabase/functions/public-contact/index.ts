// POST /public-contact  — homepage / contact / careers forms. No auth (public).
// Validates, honeypot, rate-limits per IP, stores the submission, enqueues email.
import { createClient } from "jsr:@supabase/supabase-js@2";

// Anything not listed here is discarded. The contact form previously posted
// phone_number / service_needed / number_of_forklifts, none of which were
// allowed, so request_service failed its own required-field check every time.
const LIMITS: Record<string, number> = {
  company:120, name:120, phone:40, email:160, zip:20,
  make_model:120, machine_down:40, issue:3000,
  service_needed:120, number_of_forklifts:20,
  about:4000, experience:80, equipment:200,
  position:120, availability:120, portfolio_link:300,
};
const RATE_PER_HOUR = 5;

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": Deno.env.get("PUBLIC_SITE_URL") ?? "https://apexliftsolutionsusa.com",
                 "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return new Response("Method not allowed", { status: 405, headers: cors });

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400, cors); }

  // Honeypot: real users never fill this.
  if (body._gotcha) return json({ ok: true }, 200, cors);

  const form = body.form === "careers" ? "careers" : "request_service";
  const clean: Record<string, string> = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    if (body[k] != null) clean[k] = String(body[k]).trim().slice(0, max);
  }
  if (form === "request_service" && (!clean.name || !clean.phone || !clean.issue || !clean.zip)) return json({ error: "missing_fields" }, 400, cors);
  if (form === "careers" && (!clean.name || !clean.email || !clean.about)) return json({ error: "missing_fields" }, 400, cors);
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) return json({ error: "bad_email" }, 400, cors);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Rate limit: N per IP per hour. IP is hashed — we don't keep raw addresses.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "0";
  // Dedicated salt. Reusing a worker credential here would mean anyone who could
  // observe a hash had a lever on a privileged secret, and rotating one would
  // silently break the other.
  const salt = Deno.env.get("CONTACT_IP_HASH_SALT");
  if (!salt) return json({ error: "server_misconfigured" }, 500, cors);
  const ipHash = await sha(ip + salt);
  const bucket = `contact:${ipHash}`;
  const { data: rl, error: rlErr } = await sb.from("rate_limits").select("*").eq("bucket", bucket).maybeSingle();
  if (rlErr) console.error("[public-contact] rate-limit read failed", rlErr.code);   // fail open: an enquiry is worth more than a perfect counter
  const windowFresh = rl && (Date.now() - new Date(rl.window_start).getTime()) < 3_600_000;
  if (windowFresh && rl.hits >= RATE_PER_HOUR) return json({ error: "rate_limited" }, 429, cors);
  const { error: upErr } = await sb.from("rate_limits").upsert({ bucket, hits: windowFresh ? rl.hits + 1 : 1,
    window_start: windowFresh ? rl.window_start : new Date().toISOString() });
  if (upErr) console.error("[public-contact] rate-limit upsert failed", upErr.code);

  // The submission itself is the thing that must not be lost. A failed insert
  // used to fall through to `sub!.id`, which throws and returns an opaque 500
  // after the caller has already been told nothing.
  const { data: sub, error: subErr } = await sb.from("contact_submissions")
    .insert({ form, payload: clean, ip_hash: ipHash }).select("id").single();
  if (subErr || !sub?.id) {
    console.error("[public-contact] submission insert failed", subErr?.code ?? "no_row");
    return json({ error: "submission_failed" }, 500, cors);   // no provider detail leaked
  }

  // The notification is best effort. The enquiry is already safely stored, so a
  // queueing failure must not tell the customer their message was lost.
  try {
    const to = form === "careers" ? "jobs@apexliftsolutionsusa.com" : (await cfg(sb, "service_notification_email"));
    const { error: qErr } = await sb.rpc("enqueue_notification", { p_event_key: `contact:${sub.id}`,
      p_event_type: form === "careers" ? "contact_careers" : "contact_request_service",
      p_recipient: to, p_entity_type: "contact", p_entity_id: sub.id, p_payload: clean });
    if (qErr) console.error("[public-contact] enqueue failed for", sub.id, qErr.code);
  } catch (e) {
    console.error("[public-contact] enqueue threw for", sub.id);
  }

  return json({ ok: true }, 200, cors);
});
async function cfg(sb: ReturnType<typeof createClient>, k: string) {
  const { data } = await sb.from("app_config").select("value").eq("key", k).maybeSingle();
  return data?.value ?? "admin@apexliftsolutionsusa.com";
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
function json(b: unknown, s: number, c: Record<string,string>) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...c, "Content-Type": "application/json" } });
}
