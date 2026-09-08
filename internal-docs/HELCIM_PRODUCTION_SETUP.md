# Helcim Setup — Exact Owner Steps

## A. Checkout configuration (least privilege)
**All Tools → Integrations → API Access → New Configuration**

| Field | Value |
|---|---|
| Name | `Apex Portal Checkout` |
| Checkout Integration | **ON** |
| Production URL | `https://apexliftsolutionsusa.com` |
| General | **No access** |
| Settings | **No access** |
| Transaction Processing | **Positive Transaction** |

*Why Positive Transaction:* `payment-checkout` only ever calls
`helcim-pay/initialize` to start a purchase. It never reads settings, never
lists customers, and must never be able to refund. If this token leaks, the
worst an attacker can do is create checkout sessions — they cannot move money out.

Token → `HELCIM_CHECKOUT_API_TOKEN`.

## B. Admin configuration (second, separate token)
**New Configuration** again:

| Field | Value |
|---|---|
| Name | `Apex Payment Admin` |
| Checkout Integration | OFF |
| General | **No access** |
| Settings | **No access** |
| Transaction Processing | **Admin** |

*Why Admin:* three endpoints need it — `payment-events` and
`payment-reconcile` read `card-transactions/{id}` and `bank-transactions/{id}`
to verify amounts server-side, and `payment-refund` issues refunds. Refund
requires Admin. Settings access is **not** requested because nothing calls a
settings endpoint.

Token → `HELCIM_ADMIN_API_TOKEN`.

## C. Domain whitelist
Add `apexliftsolutionsusa.com` under permitted domains. **HelcimPay.js renders
nothing at all on a non-whitelisted domain** and gives no visible error — this
is the most common cause of a dead first integration.

## D. Confirm ACH is enabled
**Settings → Payment Methods.** Card is active once you're approved; **ACH is a
separate enablement** with its own underwriting. If bank/ACH is not active,
call Helcim. Until then remove the ACH button in `portal-customer.html`
(`#pay-method-choice`) or customers will pick an option that fails.

## E. Webhook
**Integrations → Webhooks → Enable.** Delivery URL:
```
https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1/payment-events
```
HTTPS, and deliberately does not contain the provider's name — Helcim rejects
URLs that do. Enable **card transaction** and **bank transaction** events.

Copy the **Webhook Verifier Token** → `HELCIM_WEBHOOK_VERIFIER_TOKEN`.

Verification implemented per Helcim's scheme:
`base64(HMAC-SHA256(base64decode(verifier), "webhook-id.webhook-timestamp.rawBody"))`
compared constant-time against every `vN,` entry in the `webhook-signature`
header, with a 5-minute timestamp window and a UNIQUE constraint on
`webhook_id` for replay/duplicate safety.

## F. Deploy
```bash
supabase db push        # or paste SUPABASE_FRESH.sql into the SQL Editor
supabase functions deploy payment-checkout
supabase functions deploy payment-validate
supabase functions deploy payment-events --no-verify-jwt   # HMAC is the auth
supabase functions deploy payment-refund
supabase functions deploy payment-reconcile --no-verify-jwt
supabase functions deploy outbox-worker    --no-verify-jwt
supabase functions deploy public-contact   --no-verify-jwt
supabase functions deploy admin-action
```
`--no-verify-jwt` is correct only for the four that authenticate themselves
(HMAC signature, shared worker key, or public-by-design). `payment-checkout`,
`payment-validate` and `admin-action` verify a real Supabase JWT.

## G. Cron
Enable `pg_cron` and `pg_net` under **Database → Extensions**, then run the
commented block at the end of `SUPABASE_FRESH.sql` with your project ref and
`OUTBOX_WORKER_KEY` filled in. Two jobs: outbox drain every minute, ACH
reconcile every 30 minutes.

## H. Test mode, then live
Test Mode ON → run the test plan → Test Mode OFF → one real $1 payment to
yourself → confirm `payments.status = succeeded`, the invoice flipped **via the
webhook** (`payment_webhook_events.result`), and a receipt arrived → refund it
in the Helcim dashboard.
