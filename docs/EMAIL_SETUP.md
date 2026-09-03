# Email Architecture

## Before
EmailJS in browser JS (`portal-admin.js`, `portal-customer.js`, `portal-login.js`)
with hard-coded service, template and public key. Anyone could read them from
View Source. Delivery required the tab to stay open — close the browser during a
payment and the receipt never sent. One generic template for everything.

## After
```
business write (quote / invoice / payment / request / signup)
        │  same transaction
        ▼
DB trigger → enqueue_notification()  →  notification_outbox   (event_key UNIQUE)
                                              │
                              pg_cron, 1 min  ▼
                                        outbox-worker  ──► Resend
                                              │
                                     sent | pending+backoff | failed
```

**Email failure cannot corrupt business state.** The outbox row is written in the
same transaction as the payment; sending happens later, separately. If Resend is
down, the payment and invoice stay correct and the row retries with exponential
backoff (2, 4, 8 … 240 min, 8 attempts) before being marked `failed`.

**One business event = one email.** `event_key` is UNIQUE and
`enqueue_notification` uses `ON CONFLICT DO NOTHING`, so seven duplicate webhook
deliveries still produce one receipt.

**Claiming.** The worker moves `pending → processing` with a conditional update
before sending; a concurrent worker matches 0 rows and skips.

## Events
| Event | To | Trigger |
|---|---|---|
| `quote_created` | customer | quotes INSERT |
| `quote_approved` / `quote_declined` | customer | quotes status transition |
| `quote_approved_admin` / `quote_declined_admin` | admin | same |
| `invoice_created` | customer | invoices INSERT |
| `payment_received` / `_admin` | customer + admin | payments → `succeeded` |
| `ach_submitted` / `_admin` | customer + admin | payments → `pending` (ach) |
| `payment_declined` | customer only — admins are not spammed | payments → `failed` |
| `payment_refunded` / `_admin` | customer + admin | refund row → `succeeded` |
| `service_request_admin` | service inbox | service_requests INSERT |
| `registration_admin` | admin | customers INSERT |
| `account_activated` | customer | customers → `active` |
| `contact_request_service` / `contact_careers` | service / jobs inbox | public-contact fn |

All branded responsive HTML with a plain-text fallback, built in
`supabase/functions/_shared/email.ts`. One `render(event, payload)` function —
no provider code duplicated per workflow.

**Never emailed:** card numbers, CVV, bank account numbers, API tokens, session
tokens. Payment emails carry only invoice number, amount, date, a generalised
method (`Visa ····4242`), and a transaction reference.

Recipients come from the `app_config` table, not JavaScript. Change them with a
SQL update — no redeploy.

Domain/DNS steps are in `RESEND_PRODUCTION_SETUP.md`. **DNS authentication is
not done** — until SPF and DKIM verify, mail will land in spam.
