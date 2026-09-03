# RLS / Authorization Matrix

Enforced by Postgres, not the browser. **RPC** = the only write path is a
`security definer` function permitting one change. **Edge** = service role only.

| Table | Anonymous | Pending customer | Active customer A | Admin | Service |
|---|---|---|---|---|---|
| `customers` | — | S own · I own (status→`pending`) | S own · U via `update_my_profile()` (name/company/phone) | ALL | ALL |
| `quotes` | — | S own | S own · `respond_to_quote()` · `hide_declined_quote()` | ALL | ALL |
| `invoices` | — | S own | **S own only** | ALL | ALL |
| `payments` | — | S own | **S own only** | S | ALL |
| `payment_events` | — | S own (via payment) | S own (via payment) | S | ALL |
| `payment_webhook_events` | — | — | — | S | ALL |
| `service_requests` | — | S own · I own (`status='open'`) | same | ALL | ALL |
| `service_history` | — | S own | S own | ALL | ALL |
| `notification_outbox` | — | — | — | S | ALL |
| `contact_submissions` | — | — | — | S | ALL |
| `rate_limits` | — | — | — | — | ALL |
| `app_config` | — | — | — | ALL | ALL |
| `audit_log` | — | — | — | S | ALL (trigger) |
| `activity_log` | — | — | — | S | ALL |
| `private.*` | — | — | — | — | ALL (not exposed to PostgREST) |
| storage `apex-uploads` | — | RW `service-requests/<own uuid>/` · R `quotes/<own quote>/` | same | ALL | ALL |

S = SELECT, I = INSERT, U = UPDATE. Blank = no policy = denied.

Pending and active share grants because a pending account has no quotes,
invoices or history yet. Pending is gated at **login** (`portal-login.js` signs
them out) and at **checkout** (`payment-checkout` returns `account_not_active`).

## Customer A cannot, even by direct REST call
- Read any row where `customer_id ≠ auth.uid()` — every policy filters on it.
- Write `invoices` or `payments` in any way. No INSERT/UPDATE/DELETE policy exists.
- Change `amount`, `items`, `invoiced` or ownership on a quote. The RPC reassigns
  nothing but `status` and `responded_at`, refuses a non-`pending` quote, and
  takes `FOR UPDATE` so two tabs cannot race.
- Set their own `status` to `active`.
- Fetch B's files — the storage policy compares the UUID segment of the path.
- Read `private.helcim_checkout_session` — schema revoked from `anon`/`authenticated`
  and not in PostgREST's exposed schema list.
- Edit or delete `audit_log`.
- Call `payment-refund` (403 on non-admin email) or `admin-action` (same).
- Trigger `outbox-worker` / `payment-reconcile` (shared-secret header).
