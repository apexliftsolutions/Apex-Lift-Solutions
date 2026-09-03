# Secrets Setup

All of these are **Supabase Edge Function secrets**. None may ever appear in
HTML, portal JS, `main.js`, a URL, or a commit. This repo is public.

```bash
supabase secrets set HELCIM_CHECKOUT_API_TOKEN=…
supabase secrets set HELCIM_ADMIN_API_TOKEN=…
supabase secrets set HELCIM_WEBHOOK_VERIFIER_TOKEN=…
supabase secrets set RESEND_API_KEY=…
supabase secrets set OUTBOX_WORKER_KEY=…            # openssl rand -hex 32
supabase secrets set RECONCILE_WORKER_KEY=…         # openssl rand -hex 32  (different value)
supabase secrets set CONTACT_IP_HASH_SALT=…         # openssl rand -hex 32  (different value)
supabase secrets set TRANSACTIONAL_FROM_EMAIL="Apex Lift Solutions <notifications@apexliftsolutionsusa.com>"
supabase secrets set TRANSACTIONAL_REPLY_TO=service@apexliftsolutionsusa.com
supabase secrets set PUBLIC_SITE_URL=https://apexliftsolutionsusa.com
```

`supabase secrets list` shows names and digests only — never values.

| Secret | Used by | Why it is separate |
|---|---|---|
| `HELCIM_CHECKOUT_API_TOKEN` | `payment-checkout` | Can only start a purchase. Cannot refund. |
| `HELCIM_ADMIN_API_TOKEN` | `payment-refund`, `payment-events`, `payment-reconcile` | Can read transactions and refund. Never touches the checkout path. |
| `HELCIM_WEBHOOK_VERIFIER_TOKEN` | `payment-events` | HMAC key. This *is* the webhook's authentication. |
| `RESEND_API_KEY` | `outbox-worker` | Only the worker sends mail. |
| `OUTBOX_WORKER_KEY` | `outbox-worker` | Shared secret so only cron can drain the outbox. |
| `RECONCILE_WORKER_KEY` | `payment-reconcile` | Separate from the outbox key. Reconcile can move an invoice to *paid*; the outbox only sends mail. They should not share a blast radius. |
| `CONTACT_IP_HASH_SALT` | `public-contact` | Salts the hashed visitor IP for rate limiting. Deliberately **not** a worker credential — an IP hash is semi-public, and reusing a privileged secret as a hash salt means rotating one silently breaks the other. `public-contact` returns 500 if it is unset rather than falling back to an empty salt. |

Recipients (`admin_notification_email`, `service_notification_email`) live in the
`app_config` table, not in JavaScript. Change them with a SQL update, no deploy.

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically —
do not set them, and never ship them to a browser.

## Private schema access path

`private.helcim_checkout_session` holds each checkout's `secret_token` — the
value that proves a HelcimPay.js response is genuine.

**The `private` schema is never added to the Data API's exposed schemas**
(Supabase → Settings → API → Exposed schemas should list `public` only). PostgREST
therefore has no route to that table under any role.

Edge Functions reach it through two `SECURITY DEFINER` functions in `public`:

| Function | Granted to | Purpose |
|---|---|---|
| `create_checkout_session(text,text,uuid)` | `service_role` only | store the session at checkout init |
| `read_checkout_session(text)` | `service_role` only | fetch `secret_token` + `attempt_id` during validation |

Both are revoked from `public`, `anon` and `authenticated`. A browser calling
either gets a permission error, and `secret_token` never appears in any
PostgREST response.
