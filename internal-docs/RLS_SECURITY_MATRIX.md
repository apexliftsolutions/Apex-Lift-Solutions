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

---

# Service Plans / Recurring Billing (added by SERVICE_PLANS_UPGRADE.sql)

| Table | Anonymous | Pending customer | Active customer A | Admin | Service |
|---|---|---|---|---|---|
| `customer_equipment` | — | S own | S own | ALL | ALL |
| `service_plan_offers` | — | S own (not `draft`) | S own (not `draft`) | ALL | ALL |
| `service_plan_agreements` | — | S own | S own | ALL | ALL |
| `service_subscriptions` | — | S own | S own · `set_subscription_reminder()` | ALL | ALL |
| `service_plan_events` | — | — | — | S | ALL |
| `private.helcim_verify_session` | — | — | — | — | ALL (not exposed to PostgREST) |
| storage `apex-agreements` | — | — | — | ALL | ALL |

S = SELECT. Blank = no policy = denied.

## Stricter than policies alone

These five tables additionally have `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE`
**revoked from `anon` and `authenticated`**, and `anon` has no privilege at all.
RLS is the second line, not the only one: even a mistaken future policy cannot
open a write path through PostgREST.

This intentionally removes admin PostgREST writes on these tables too. Admin
manages equipment, offers and subscriptions through admin-only server paths
(`admin-action` / service role), never by writing the table directly.

## Customer A cannot, even by direct REST call

- See a `draft` offer. Drafts are internal until sent.
- See B's equipment, offers, agreements or subscriptions — every policy filters
  on `customer_id = auth.uid()`.
- Insert, update or delete any service-plan row. The privilege is not granted.
- Change a signed agreement's amount, rail or snapshot — `guard_service_plan_agreement()`
  refuses in the database regardless of who is calling.
- Change a subscription's authorized recurring amount — `guard_service_subscription()`
  refuses. An amendment must produce a new agreement.
- Mark a subscription `active` — `ck_sub_active_needs_provider_id` requires a real
  Helcim subscription id.
- Toggle anything except the optional pre-charge reminder, and only on their own
  subscription (`set_subscription_reminder` re-checks ownership server-side).
- Read `service_plan_events` — provider error detail is admin-only.
- Read another customer's agreement PDF. The bucket is private with no customer
  policy; owners receive short-lived signed URLs minted server-side.

## Agreement PDF access path

| Function | Granted to | Purpose |
|---|---|---|
| `create_verify_session(text,text,uuid,uuid,text)` | `service_role` only | store a HelcimPay verify session bound to one agreement + one rail |
| `read_verify_session(text)` | `service_role` only | fetch `secret_token` during verify validation |
| `set_subscription_reminder(uuid,boolean)` | `authenticated` | the only customer-writable field in the whole subsystem |
| `cfg_bool(text)` | `service_role` only | reads the recurring gate; fails closed |

## Integrity that RLS cannot provide (revision 2)

RLS defends against a hostile browser. It does nothing against Apex's own
server code, because every Edge Function writes with the service role and
service_role bypasses RLS entirely. These rules are therefore enforced as
constraints and triggers, which DO fire for service_role:

| Rule | Mechanism |
|---|---|
| An offer cannot reference another customer's equipment | composite FK `fk_offer_equipment_same_customer` |
| An agreement's customer/equipment must be the offer's | composite FK `fk_agreement_matches_offer_chain` |
| A subscription must sit on the exact signed agreement chain | composite FK `fk_sub_matches_agreement_chain` |
| An agreement's amount must equal the offer's price for the signed rail | trigger `trg_validate_agreement` |
| An agreement cannot be signed against a draft, expired or already-accepted offer | trigger `trg_validate_agreement` |
| A subscription's amount, rail, term and dates are copied from the agreement | trigger `trg_validate_subscription` |
| A subscription cannot be born active or carry a provider id at creation | trigger `trg_validate_subscription` |
| Terminal states stay terminal (offer, agreement, subscription) | `assert_transition()` inside each guard |
| A signed agreement can never be DELETEd | trigger `trg_no_delete_agreement` |
| `service_plan_events` is append-only | trigger `trg_events_append_only` |
| A provider-bound or billed subscription can never be DELETEd | trigger `trg_no_delete_billed_sub` |

A superuser can still bypass triggers with `session_replication_role='replica'`.
That is a deliberate, auditable act rather than an accident, which is the point.

## Verify-session lifecycle

`private.helcim_verify_session` rows are bound to one agreement, one customer
and one rail, expire with the Helcim checkout token (60 minutes, configurable
via `service_plan_verify_session_minutes`), and are single-use.

| Function | Granted to | Behaviour |
|---|---|---|
| `create_verify_session` | `service_role` | raises if the token is already bound to a different agreement/customer/rail; an identical replay is a no-op |
| `read_verify_session` | `service_role` | read-only peek; returns nothing once expired or consumed |
| `consume_verify_session` | `service_role` | atomically marks consumed and returns the secret exactly once |
| `purge_expired_verify_sessions` | `service_role` | housekeeping; deletes rows expired more than 24h |

## Server-side write paths

| Function | Granted to | Purpose |
|---|---|---|
| `accept_offer_and_sign_agreement` | `service_role` | atomic offer-accept + agreement-insert; reads the money out of the offer row, re-checks ownership, refuses a missing contract snapshot |
| `create_subscription_from_agreement` | `service_role` | copies the signed agreement into a subscription; accepts no amount, rail, term or date from the caller |
