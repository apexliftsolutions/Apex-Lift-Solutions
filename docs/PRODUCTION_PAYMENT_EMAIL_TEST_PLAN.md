# Production Payment + Email Test Plan

**Status: NONE OF THE PROVIDER TESTS HAVE BEEN RUN.**
I have no Helcim credentials, no Resend key, and this build environment cannot
reach either service or your Supabase project. Every row below is unverified.
Fill in the Result column yourself. Nothing here should be read as "it works."

## Setup
Apply `SUPABASE_FRESH.sql`, deploy all eight functions, set the secrets, enable
Helcim **Test Mode**. Register two accounts and approve both in admin:
`custa@test.local` (A), `custb@test.local` (B). Leave a third, `pending@test.local`,
unapproved.

```bash
ANON="<anon key from portal-data.js>"; URL="https://cjtezsgfdfijmdxzzbiq.supabase.co"
tok(){ curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" \
  -H "Content-Type: application/json" -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
A=$(tok custa@test.local 'pw'); B=$(tok custb@test.local 'pw')
```

| # | Test | Expected | Result |
|---|---|---|---|
| 1 | Admin creates a quote | `quotes` row; **one** `notification_outbox` row `quote_created`; one customer email | |
| 2 | A approves own quote (portal button) | `status=approved`; 2 outbox rows (customer + admin); no others | |
| 3 | A alters quote amount: `PATCH /quotes?id=eq.<A quote> {"amount":0.01}` | `[]` — 0 rows. No UPDATE policy exists | |
| 4 | A responds to B's quote: `POST /rpc/respond_to_quote` with B's id | error `Quote not found` | |
| 5 | Admin creates an invoice | one `invoice_created` outbox row, one email | |
| 6 | A sets own invoice paid: `PATCH /invoices?id=eq.<A inv> {"status":"paid"}` | `[]` — 0 rows | |
| 7 | A pays B's invoice: `POST /functions/v1/payment-checkout {"invoice_id":"<B inv>"}` | `404 not_found` | |
| 8 | **Amount tampering:** `{"invoice_id":"<A $1500 inv>","amount":1.00,"idempotency_key":"x"}` | Helcim session opens for **$1500**. Field ignored — server reads the DB | |
| 9 | Card payment, Helcim test card | modal opens → approved → `payments.status=succeeded` → invoice `paid` → 1 customer receipt + 1 admin notice | |
| 10 | **Fake redirect:** open `portal-customer.html?paid=<A inv>` | nothing happens. Code removed; no policy would allow it | |
| 11 | **Fake webhook:** `POST /functions/v1/payment-events` with junk body, no headers | `400`. Wrong signature → `401`. Invoice untouched | |
| 12 | **Duplicate webhook:** replay the same valid delivery twice | 2nd returns `ok (duplicate)`. One `payments` row, one receipt, one admin email | |
| 13 | Declined test card | `payments.status=failed`, invoice still `unpaid`, no receipt | |
| 14 | ACH submitted | `payments.status=pending`, invoice `payment_pending`, email says **"Bank Payment Submitted"** — never "Paid" | |
| 15 | ACH settles (or run `payment-reconcile`) | `status=succeeded`, `settled_at` set, invoice `paid`, receipt sent | |
| 16 | ACH returned/declined | `status=failed`, invoice back to `unpaid`, original attempt row retained | |
| 17 | **Email outage:** set a bad `RESEND_API_KEY`, then take a payment | payment + invoice **correct**; outbox row `pending` with `last_error`, retried with backoff. Restore key → next run sends it | |
| 18 | Admin records a manual check payment | `payments` row `provider=manual`; `audit_log` entry; invoice `paid`; receipt queued | |
| 19 | Pending customer self-activates: `PATCH /customers {"status":"active"}` | `[]` — 0 rows. Also `POST /customers {"status":"active"}` lands as `pending` | |
| 20 | A/B isolation: `GET` quotes, invoices, payments, service_requests, service_history as A | only A's rows in every table | |
| 21 | A reads B's file: `GET /storage/v1/object/apex-uploads/service-requests/<B uuid>/x.jpg` | 400/403 | |
| 22 | A writes to B's folder or to `quotes/` | 403 | |
| 23 | Signed-out user opens a previously-working file URL | fails — bucket is private | |
| 24 | A calls `payment-refund` | `403 forbidden` | |
| 25 | Double-click Pay | one `payments` row (unique index on `customer_id,idempotency_key`), one charge | |
| 26 | Two tabs, both Pay on the same invoice | second gets `409 duplicate_in_flight` (partial unique index) | |
| 27 | Refresh during "Confirming…" | no second charge; the webhook still settles it | |
| 28 | Public contact form | `contact_submissions` row + outbox email; 6th submit in an hour → `429` | |
| 29 | Honeypot: submit with `_gotcha` filled | returns `ok` but sends nothing | |
| 30 | Admin refund of a card payment | new `payments` row `kind=refund`; original intact; invoice → `refunded`; both emails | |

## Automated checks that WERE run
| Check | Result |
|---|---|
| `node --check` on all 6 browser JS files | PASS |
| SQL `$$` block balance | PASS |
| No `emailjs` / `EJS_` reference in any portal file | PASS (0) |
| No `stripe` reference anywhere | PASS (0) |
| No `?paid=` handler | PASS (0) |
| No `getPublicUrl` in portal JS | PASS (0) |
| No wildcard CORS in any Edge Function | PASS |
| No `sk_live` / service-role literal committed | PASS |
| Public-form field names match the `public-contact` contract | PASS |
| Deno typecheck of Edge Functions | **NOT RUN** — Deno unavailable in this environment |

## Blocked
Everything involving Helcim or Resend is **BLOCKED BY MERCHANT/PROVIDER
CREDENTIALS**. Do not treat the payment path as exercised until rows 9–17 and
25–30 are green with real test-mode transactions.
