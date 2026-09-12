// =============================================================================
//  resend-webhook  v1.0  — authoritative email delivery state
//
//  Resend signs webhooks with Svix. Verification here is manual and follows the
//  documented scheme exactly, because the raw body must be used and a bundled
//  SDK that re-serialises JSON would silently break every signature:
//
//    signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//    key            = base64-decode(secret after the "whsec_" prefix)
//    signature      = base64( HMAC-SHA256(key, signed content) )
//    header         = space-delimited list of "v1,<signature>" entries
//
//  Everything after verification is idempotent in the database:
//  apply_delivery_event() records the svix-id under a unique constraint, so a
//  replayed webhook is a no-op, and an unknown email_id updates nothing.
//
//  NOTHING here trusts the body before the signature passes.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const FN_VERSION = "resend-webhook v1.0";
const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET     = Deno.env.get("RESEND_WEBHOOK_SECRET") ?? "";

// Svix tolerance. An old timestamp is a replay; a future one is a clock problem.
const TOLERANCE_SECONDS = 300;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));

/** Verify a Svix signature over the RAW body. Returns true only on a match. */
async function verifySvix(rawBody: string, id: string, timestamp: string, sigHeader: string): Promise<boolean> {
  if (!SECRET) return false;                       // unconfigured: fail closed
  if (!id || !timestamp || !sigHeader) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > TOLERANCE_SECONDS) return false;      // replay / clock skew

  // The secret is "whsec_" + base64 key material. Both the prefix strip and the
  // decode are required; using the whole string never matches.
  const keyB64 = SECRET.startsWith("whsec_") ? SECRET.slice(6) : SECRET;
  let keyBytes: Uint8Array;
  try { keyBytes = b64ToBytes(keyB64); } catch { return false; }

  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = `${id}.${timestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = bytesToB64(mac);
  const expectedBytes = new TextEncoder().encode(expected);

  // The header may carry several space-delimited "v1,<sig>" entries. Any one
  // matching is a pass; comparison is constant-time.
  for (const part of sigHeader.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    if (version !== "v1") continue;
    if (timingSafeEqual(expectedBytes, new TextEncoder().encode(sig))) return true;
  }
  return false;
}

/** A short, safe explanation for the admin. Never a raw provider payload. */
function detailOf(type: string, data: Record<string, unknown>): string | null {
  const bounce = data?.bounce as Record<string, unknown> | undefined;
  if (type === "email.bounced" && bounce) {
    const kind = [bounce.type, bounce.subType].filter(Boolean).join(" / ");
    const msg = typeof bounce.message === "string" ? bounce.message.slice(0, 300) : "";
    return [kind, msg].filter(Boolean).join(" — ") || "Bounced";
  }
  if (type === "email.complained")       return "Recipient marked the message as spam";
  if (type === "email.delivery_delayed") return "Receiving server delayed delivery";
  if (type === "email.failed")           return "Provider reported a send failure";
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // RAW body, read once, never re-serialised. Parsing before verification would
  // break the signature and would also mean acting on unverified input.
  const raw = await req.text();

  const ok = await verifySvix(
    raw,
    req.headers.get("svix-id")        ?? req.headers.get("webhook-id")        ?? "",
    req.headers.get("svix-timestamp") ?? req.headers.get("webhook-timestamp") ?? "",
    req.headers.get("svix-signature") ?? req.headers.get("webhook-signature") ?? "",
  );
  if (!ok) {
    console.error("[resend-webhook] signature rejected");
    return json({ error: "invalid_signature" }, 401);
  }

  let evt: { type?: string; created_at?: string; data?: Record<string, unknown> };
  try { evt = JSON.parse(raw); } catch { return json({ error: "bad_payload" }, 400); }

  const type = String(evt?.type ?? "");
  const data = (evt?.data ?? {}) as Record<string, unknown>;
  const emailId = typeof data.email_id === "string" ? data.email_id : "";
  // svix-id identifies the webhook MESSAGE and is stable across provider
  // retries — which is exactly what makes deduplication work.
  const eventId = req.headers.get("svix-id") ?? req.headers.get("webhook-id") ?? "";

  if (!emailId) return json({ ok: true, ignored: "no_email_id", fn_version: FN_VERSION });

  const rawTs = evt?.created_at;
  const parsed = typeof rawTs === "string" ? Date.parse(rawTs) : NaN;
  const occurredAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  if (!occurredAt) console.warn("[resend-webhook] event has no usable created_at; retained but cannot decide state");

  const db = createClient(SB_URL, SB_SERVICE);
  const { data: result, error } = await db.rpc("apply_delivery_event", {
    p_provider_event_id: eventId,
    p_provider_msg_id:   emailId,
    p_event_type:        type,
    // Only a parseable ISO timestamp is passed through. A malformed one becomes
    // NULL, and the database refuses to let an unordered event decide state.
    p_occurred_at:       occurredAt,
    p_detail:            detailOf(type, data),
  });

  if (error) {
    console.error("[resend-webhook] apply failed", error.message?.slice(0, 120));
    // 500 asks the provider to retry; the unique event id keeps that safe.
    return json({ error: "apply_failed" }, 500);
  }

  // An UNRESOLVED event is one whose provider_msg_id is not on any outbox row
  // yet — almost always because this webhook raced outbox-worker committing the
  // id. The event is already stored safely. Answering non-2xx makes Resend
  // retry (it documents at-least-once delivery with automatic retries), and by
  // then the id is committed, so apply_delivery_event attaches the record it
  // already holds. Without this the event could stay orphaned forever and the
  // invoice would read "Sent" despite having been delivered.
  //
  // 409, not 500: nothing failed. This is a "not yet, please retry" answer.
  if (result?.unresolved) {
    console.warn("[resend-webhook] unresolved provider id, retained; asking provider to retry");
    return json({ ok: false, ...result, fn_version: FN_VERSION }, 409);
  }

  // 200 for every settled outcome — applied, duplicate, or an event type we
  // deliberately do not act on. Retrying those would not change anything.
  return json({ ok: true, ...result, fn_version: FN_VERSION });
});
