# PHASE A REPORT — REVISION 2

Revised after the independent audit. **Nothing was deployed, pushed, or run
against production.** `recurring_billing_enabled` ships `false`.

Every V23 file is byte-identical to the baseline. Migration numbering is
unchanged: `0005_refund_void_v22.sql` + `0006_service_plans.sql`.

---

# 1. What changed in revision 2

| # | Audit finding | Severity | What was done |
|---|---|---|---|
| 1 | Cross-customer relationships not DB-enforced | Blocker | Three composite FKs. `offer.(equipment_id, customer_id)` → `customer_equipment(id, customer_id)`; `agreement.(offer_id, customer_id, equipment_id)` → the offer's own triple; `subscription.(agreement_id, offer_id, customer_id, equipment_id)` → the agreement's own quad. Declarative, not trigger-based. |
| 2 | Agreement INSERT not validated against the offer | Blocker | `trg_validate_agreement` (BEFORE INSERT). Checks offer exists, is `sent`, is not expired, customer/equipment match, rail is card or ach, **and that subtotal/tax/total exactly equal the offer's price for the chosen rail**, plus currency, term, activation date, all four consents. |
| 3 | Subscription INSERT not validated against the agreement | Blocker | `trg_validate_subscription` (BEFORE INSERT). Agreement must be `signed`; offer/customer/equipment/rail/amounts/currency/term/activation must match; `max_cycles` must equal the term; `provider_subscription_id` may not be supplied; status must start `setup_pending`. |
| 4 | State transitions incomplete | High | `assert_transition()` + explicit graphs for all three entities. Offer: `draft → sent\|cancelled`, `sent → accepted\|declined\|expired\|cancelled`, everything else terminal. Agreement: `signed → superseded\|cancelled`, terminal after. Subscription: full 9-state graph, `cancelled` and `completed` terminal. |
| 5 | Signed agreements deletable by service role | High | `trg_no_delete_agreement` raises unconditionally. Also `trg_no_delete_billed_sub` for any subscription bound to Helcim or that has billed. |
| 6 | `service_plan_events` not enforced append-only | High | `trg_events_append_only` rejects UPDATE and DELETE. |
| 7 | Verify sessions had no expiry or consumed state | Medium | `expires_at` (60 min, configurable) + `consumed_at`. New `consume_verify_session()` is single-use and atomic. `read_verify_session()` returns nothing once expired or consumed. `create_verify_session()` now **raises** on a conflicting rebind instead of silently no-opping. Plus `purge_expired_verify_sessions()`. |
| 8 | Recurring discriminators too loose | Medium | Recurring invoices require subscription **and** both period bounds. Recurring charges require a period; recurring corrections require `refund_of` and must carry no cycle id. One-time rows may carry **no** recurring metadata at all. Cycle-uniqueness indexes narrowed to `kind='payment'` so partial refunds are not blocked. |
| 9 | `active` only meant "provider id non-null" | Medium | Documentation corrected in the SQL itself. Added `provider_verified_at`. The constraint is now described as a floor, not a proof: only a server-to-server GET can prove the Helcim subscription exists, and both `subscription-activate` and `subscription-reconcile` must do it. |
| 10 | ACH endpoint doc stale; `recurringAmount=0` assumed | Verify later | Helcim doc rewritten. `GET /v2/ach/transactions` **does** now support `page`, `limit`, `startDate`, `endDate`, `amountMin`, `amountMax`, `statusAuth`, `statusClearing`, `users`, `search` — verified against the changelog. The zero-dollar plan assumption is demoted to explicitly unverified. |

## One extra defect found while testing revision 2

The first version of `accept_offer_and_sign_agreement` merged an authoritative
block into the snapshot **before** the table constraint ran. A `null` snapshot
therefore became `{"authoritative": {...}}` — a technically valid object, so the
constraint passed, producing a signed agreement with no human-readable contract
body. Test A8 caught it. The RPC now rejects a missing, non-object or empty
snapshot up front.

---

# 2. Test results — 64 assertions, 0 failures

Run against a real PostgreSQL 16 instance carrying a replica of the production
schema plus the seeded V23 reversal scenario.

**Cross-entity integrity (3/3)** — an offer cannot reference another customer's
forklift; an agreement's customer and equipment must be the offer's.

**Agreement validation (12/12)** — price mismatch refused; **card rail cannot be
signed at the ACH price**; draft offer refused; expired offer refused; wrong
term refused; wrong activation date refused; missing consent refused; empty
snapshot refused; blank signature refused; another customer cannot sign;
**legitimate signing succeeds and the offer flips to accepted in the same
transaction**; an accepted offer cannot be signed twice.

**Subscription validation (8/8)** — amount, rail, equipment and customer must
all match the signed agreement; `provider_subscription_id` cannot be supplied at
creation; cannot be born `active`; `max_cycles` must equal the term; and the
positive control confirms `create_subscription_from_agreement` copies the
agreement exactly (19553c / ach / 6 cycles / `setup_pending`).

**Lifecycle transitions (8/8)** — accepted and declined offers cannot return to
`sent`; a draft cannot jump to `accepted`; `setup_pending` cannot jump to
`active`; the legitimate `setup_pending → method_verified → active` path
succeeds; **cancelled and completed subscriptions cannot be reactivated**; a
superseded agreement cannot return to `signed`.

**Durability (4/4)** — signed agreement DELETE refused; `service_plan_events`
UPDATE and DELETE refused; provider-bound subscription DELETE refused. All four
attempted as the table owner, which is strictly stronger than service_role.

**Immutability (8/8)** — agreement amount, rail and snapshot frozen; PDF
write-once; sent offer pricing frozen; subscription amount frozen; provider
binding permanent; `times_billed` cannot decrease.

**Double-charge protection (7/7)** — replayed billing cycle cannot create a
second money row; one invoice per billing period; a recurring charge must name
its period; a one-time row cannot carry recurring metadata; recurring amounts
immutable under the existing `guard_payment()`; **two partial refunds of one
cycle are still allowed** (the correction flexibility the audit asked to
preserve); gate reads false.

**Verify-session lifecycle (7/7)** — live session reads back; rebinding a token
to a different customer/rail raises; first consume returns the secret; second
consume returns nothing; a consumed session no longer reads; an expired session
neither reads nor consumes.

**RLS with two real authenticated customers (7/7 + 4 + 2)** — B sees none of A's
offers, agreements, subscriptions or equipment; A cannot see internal drafts but
does see their own sent offers; `service_plan_events` invisible; four write
attempts all returned `permission denied for table`; the reminder toggle works
on their own subscription and raises `Subscription not found` on another's.

**Existing V23 flow (3/3)** — `INV-1A10E21B68` still `unpaid`, net retained
still exactly 0 cents so the retry path is still permitted, both original
payments intact and classified `one_time`.

---

# 3. Migration reproducibility

The audit asked for proof the system rebuilds from migrations alone, not just
that the existing database upgrades.

```
0001_fresh_test_only      OK
0002_production_upgrade   OK
0003_feesaver             OK
0004_tax                  OK
0005_refund_void_v22      OK
0006_service_plans        OK
```

Resulting fresh database: 19 public tables, 3 chain-integrity FKs, 5
validation/durability triggers, `recurring_billing_enabled = false`, and
`recalc_invoice_status` containing the reversal branch — confirming `0005`
closes the migration-history hole.

---

# 4. Non-regression, re-measured on revision 2

Fingerprint of every function definition hash, policy, column, constraint,
index, trigger and row on the payment stack, before and after:

```
REMOVED or CHANGED:  0
ADDED:              28   (11 columns, 10 constraints, 5 indexes, 2 FKs)
```

No `ROWDATA`, `COUNT` or `FUNC` line differs at all — no existing row was
touched and no existing function was replaced. A second run of the migration
produced a byte-identical fingerprint.

`recalc_invoice_status`, `notify_on_payment`, `notify_on_invoice`,
`guard_payment`, `guard_tax_totals`, `enqueue_notification`, `write_audit`,
`is_admin`, `create_checkout_session`, `read_checkout_session` — all
hash-identical.

## Why the drops in this file are safe

Revision 2 tightens constraints revision 1 defined more loosely, so it contains
`drop constraint if exists` / `drop index if exists`. Every dropped name is one
this same migration creates. Nothing pre-existing is dropped, and since the
migration has never been run in production, on your database these are no-ops
that simply create the tightened version.

---

# 5. Run order, unchanged

```
1. SERVICE_PLANS_PREFLIGHT.sql      READ ONLY — record sections 3/4/5, expect no collisions
2. SERVICE_PLANS_UPGRADE.sql        the migration (single transaction)
3. SERVICE_PLANS_PREFLIGHT.sql      again — section 5/6 hashes must be IDENTICAL
```

Then, and only then, deploy the `payment-checkout` guard
(`patches/PAYMENT_CHECKOUT_RECURRING_GUARD.md`). Deploying it first breaks
one-time checkout, because the function would select a column that does not yet
exist.

Preferred rollback remains: set `recurring_billing_enabled = false` and stop
creating offers. Once an agreement is signed, dropping these tables destroys a
signed contract and its payment history.

---

# 6. Confirmed and carried forward

- **One forklift = one offer = one agreement = one subscription = one monthly
  charge.** Three forklifts means three contracts and three charges. The portal
  can group them visually under one company; the authorization stays per machine.
- **6 payments then `completed`, no silent renewal.** The subscription graph
  makes `completed` terminal, so renewal must go through a new offer and a new
  signature. Helcim cannot resume a cancelled subscription either, which is
  consistent.
- **Activation date is never "today" in testing** unless we intend to charge,
  because a `type=subscription` plan bills on its activation date.

---

# 7. Still not done, deliberately

- No SQL run against production. No deploy. No push.
- No Edge Functions (Phase B onward), no portal UI (Phase B/C).
- No notification triggers on the new tables — they land with their
  outbox-worker templates so nothing can queue an unrenderable email.
- **No legal language invented.** The agreement body remains a
  `LEGAL REVIEW REQUIRED` placeholder.

# 8. Open items for the auditor

1. **`recurringAmount = 0`** — now flagged unverified in the Helcim doc. Decide
   whether to create the plan with a nominal base amount that every subscription
   overrides, or to confirm the zero-dollar plan with a sandbox call first.
2. **ACH clearing status enumeration** — `CLEARED`, `REJECTED`, `CONTESTED`,
   `RETURNED` are confirmed to exist. The full enum should be read off the
   endpoint reference before Phase F writes the settlement mapping.
3. **`cancel_requested → active`** is permitted in the subscription graph so an
   admin can decline a cancellation request. Confirm that matches the business
   rule you want, or I will make cancellation requests irreversible.
