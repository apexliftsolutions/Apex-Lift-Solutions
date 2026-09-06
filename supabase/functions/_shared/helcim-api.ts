// Central Helcim API surface. Endpoints and constraints below are taken from
// Helcim's current v2 docs, not inferred.
export const HELCIM_API = "https://api.helcim.com/v2";

/** GET — "Tests connectivity to the Helcim API". Ideal for diagnosing 401s. */
export const PATH_CONNECTION_TEST = "connection-test";

/** GET /v2/card-transactions/{id} */
export const cardTxnPath = (id: string) => `card-transactions/${encodeURIComponent(id)}`;

/** GET /v2/ach/transactions/{id} — NOT /bank-transactions/, which does not exist. */
export const achTxnPath  = (id: string) => `ach/transactions/${encodeURIComponent(id)}`;

/**
 * TWO DIFFERENT RULES. Do not conflate them.
 *
 * PAYMENT API  (purchase / refund / reverse / capture)
 *   "You can submit any unique 25 to 36 character alphanumeric value that also
 *    contains hyphens and underscores... We recommend the following UUID
 *    functions for generating keys."
 *   Changelog: "Idempotency updated to support 36 character UUID keys through
 *   Payment API... UUID keys will no longer fail the check."
 *   -> crypto.randomUUID() is valid and is what Helcim recommends.
 *
 * SUBSCRIPTION API  (subscription-create, procedures/process-payment)
 *   Reference: "length between 25 and 25 — A unique 25 character alphanumeric
 *   key". Hyphens are NOT allowed there.
 *
 * An older `idempotency-keys` page still says "25 character" for everything;
 * it is superseded by the `idempotency` page and the changelog above.
 */
export function paymentIdempotencyKey(): string {
  return crypto.randomUUID();            // 36 chars, hyphens — accepted, recommended
}

/** Exactly 25 alphanumeric characters. Subscription endpoints only. */
export function subscriptionIdempotencyKey(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** @deprecated Ambiguous. Use paymentIdempotencyKey or subscriptionIdempotencyKey. */
export const idempotencyKey = subscriptionIdempotencyKey;

export function helcimHeaders(token: string, idem?: string): Record<string, string> {
  const h: Record<string, string> = {
    "api-token": token, "accept": "application/json", "content-type": "application/json",
  };
  if (idem) h["idempotency-key"] = idem;
  return h;
}

/**
 * Whether a card payment can be REVERSED (voided) or must be REFUNDED.
 *
 *   Reverse  POST /v2/payment/reverse   body { cardTransactionId, ipAddress }
 *            Requires an OPEN card batch. Full amount only.
 *   Refund   POST /v2/payment/refund    body { originalTransactionId, amount, ipAddress }
 *            Requires a CLOSED card batch. Partial allowed, repeatable up to the total.
 *
 * We cannot reliably know the batch state from our side, so callers should try
 * reverse first for a full-amount cancellation and fall back to refund.
 */
export const PATH_REVERSE = "payment/reverse";
export const PATH_REFUND  = "payment/refund";

export interface HelcimCallResult {
  ok: boolean;
  httpStatus: number;
  body: unknown;
  /** Coarse, safe-to-store reason. Never the raw processor message. */
  category: "ok" | "auth" | "permission" | "not_found" | "invalid" | "conflict" | "provider_error" | "network";
}

export async function helcimCall(
  path: string, token: string,
  init: { method?: string; body?: unknown; idem?: string } = {},
): Promise<HelcimCallResult> {
  try {
    const res = await fetch(`${HELCIM_API}/${path}`, {
      method: init.method ?? "GET",
      headers: helcimHeaders(token, init.idem),
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { ok: res.ok, httpStatus: res.status, body, category: categorize(res.status) };
  } catch (e) {
    return { ok: false, httpStatus: 0, body: String(e), category: "network" };
  }
}

// 401/403 mean the TOKEN is wrong or lacks permission -- they must never be
// mistaken for "this transaction does not exist".
function categorize(status: number): HelcimCallResult["category"] {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid";
  return "provider_error";
}
