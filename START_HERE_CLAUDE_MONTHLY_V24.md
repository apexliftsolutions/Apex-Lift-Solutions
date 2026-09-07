# START HERE — Apex Lift Solutions Monthly Service Plans / Recurring Billing V24

Date baseline audited: 2026-09-06

## 0. Role and non-negotiable instruction

You are working on the CURRENT production-oriented Apex Lift Solutions repository. This repository already has a working one-time Helcim payment/refund/reversal system that took substantial debugging to make safe.

**Do not rewrite, simplify, replace, or regress the existing one-time payment stack.**

Treat the current files as the production baseline. Build recurring service-plan billing *alongside* the existing flow with isolated tables/functions where practical.

The most important invariant is:

> **Never create a path that can double-charge a customer.**

Before editing anything, read at minimum:

- `CLAUDE_HANDOFF_V23.md`
- `README_V23.md`
- `APEX_REFUND_VOID_V22.sql`
- `docs/RECURRING_ARCHITECTURE_APPROVED.md`
- `docs/RLS_SECURITY_MATRIX.md`
- `docs/SECRETS_SETUP.md`
- `supabase/functions/payment-checkout/index.ts`
- `supabase/functions/payment-validate/index.ts`
- `supabase/functions/payment-refund/index.ts`
- `supabase/functions/payment-events/index.ts`
- `supabase/functions/payment-reconcile/index.ts`
- `supabase/functions/outbox-worker/index.ts`
- `supabase/functions/_shared/email.ts`
- `supabase/functions/_shared/helcim-api.ts`
- `portal-admin.js`, `portal-admin.html`, `portal-admin.css`
- `portal-customer.js`, `portal-customer.html`, `portal-customer.css`
- `PRODUCTION_UPGRADE.sql`, `FEESAVER_UPGRADE.sql`, `TAX_UPGRADE.sql`

Old V22 handoff material is historical. **V23 + this file are authoritative.**

---

# 1. Baseline that MUST keep working

The baseline was audited from the supplied ZIP.

Current diagnostic versions:

- customer portal: `APEX_CLIENT_VERSION = 2026-09-06.v23`
- `payment-checkout`: `FN_VERSION = 2026-09-06.v23`
- `payment-validate`: `FN_VERSION = 2026-09-06.v21` — this is intentional; V21 is the fixed validator baseline, not evidence that the repo is stale.

Current one-time behavior that must survive unchanged:

1. Customer invoice ownership is `auth.users.id = customers.id = invoices.customer_id`.
2. Browser never sets financial state.
3. One-time Helcim checkout uses Fee Saver with `paymentMethod: "cc-ach"` and `hasConvenienceFee: 1`.
4. Apex sends the tax-inclusive invoice base amount; Helcim adds its card convenience fee separately.
5. Card APPROVED becomes Apex `payments.status='succeeded'` and invoice `paid` immediately after trusted server verification; card bank settlement is not the gate.
6. ACH stays pending until authoritative clearing.
7. `unknown`, `pending`, or fresh in-flight attempts suppress customer retry.
8. Refunds/reversals are append-only correction ledger rows. Never mutate/delete the original succeeded payment.
9. A true refund derives `partially_refunded` / `refunded`.
10. A successful full provider reversal returns a still-valid invoice to `unpaid` and allows safe repayment only after net retained funds are zero.
11. V23 checkout retry calculates net retained money rather than blocking forever on the historical succeeded payment.
12. Refund/void reasons are required and stored in the audit trail.
13. Customer and admin correction emails include amount/reason/references.
14. `notification_outbox.event_key` is the exactly-once notification key.
15. Existing RLS and service-role boundaries must not be weakened.
16. No raw card, CVV, ACH routing/account numbers, or Helcim `secretToken` may be stored in public tables or sent to the browser.

**Do not rerun old destructive/test migrations. Do not run `SUPABASE_FRESH_TEST_ONLY.sql`. Do not casually rerun `PRODUCTION_UPGRADE.sql`, `FEESAVER_UPGRADE.sql`, `TAX_UPGRADE.sql`, or `APEX_REFUND_VOID_V22.sql` on production.**

---

# 2. Objective

Add a professional **Monthly Service Plans** system for Apex forklift customers.

Version 1 business model:

- One forklift/equipment unit = one service-plan offer = one immutable signed agreement = one Helcim subscription.
- One company/customer may have many forklifts and therefore many independent subscriptions.
- Default contract term is **6 months**, but make `term_months` data-driven so Apex can later offer other terms.
- Admin chooses an explicit monthly ACH price and an explicit monthly card price.
- **Do not use Helcim Fee Saver for recurring billing.** Recurring Payments are not compatible with Fee Saver.
- Card-vs-ACH price wording and final legal contract language must be clearly tagged `LEGAL REVIEW REQUIRED`; do not invent legal conclusions.
- Customer may turn the optional pre-charge reminder on/off. Mandatory transactional notices cannot be disabled.

The end-to-end UX:

Admin:

```
Service Plans
  -> select customer
  -> select existing forklift OR add forklift
  -> create recommendation / offer
  -> set plan name + services + exclusions
  -> set ACH monthly price + Card monthly price
  -> set tax / tax exempt using Apex tax authority
  -> set start date / term
  -> send offer
```

Customer:

```
Service Plans
  -> review exact forklift
  -> review included services / exclusions / term
  -> compare ACH and card monthly prices
  -> choose payment method
  -> review agreement
  -> required consent checkboxes
  -> type signer name/title + electronic signature/acceptance
  -> immutable agreement created
  -> verify chosen payment method through HelcimPay.js
  -> subscription activation (ONLY when production gate is enabled)
```

After activation:

```
Helcim owns recurring schedule + tokenized/default payment method
Apex owns contract + equipment + tax + invoices + payment ledger + receipts + email + reconciliation
```

---

# 3. Current official Helcim facts — verify again before coding

You MUST check CURRENT official Helcim developer docs before implementing API requests. Do not rely solely on this handoff if docs changed.

As of this baseline audit:

- Helcim Recurring API recommends creating/capturing the customer payment method first, then creating the subscription.
- HelcimPay.js `paymentType: "verify"` is the recommended way to capture/tokenize card or ACH details for recurring use.
- `setAsDefaultPaymentMethod: 1` sets newly captured details as that Helcim customer's default.
- A Helcim subscription charges the customer's **default card or bank account**, depending on the subscription payment method.
- HelcimPay initialize supports `paymentMethod: "cc" | "ach" | "cc-ach"`.
- Verify is a $0 verification/tokenization transaction; confirm the exact initialize payload required by the current docs before coding.
- Recurring Payments are **not compatible with Helcim Fee Saver**.
- Subscription `recurringAmount` can override the payment-plan recurring amount.
- `POST /v2/subscriptions` requires an **exactly 25-character alphanumeric** `idempotency-key`. Use the existing `subscriptionIdempotencyKey()` helper in `_shared/helcim-api.ts`; do not use a UUID here.
- Payment API refund/reverse idempotency rules are different; preserve the existing UUID helper for one-time Payment API actions.
- Payment plans control billing frequency, term type, payment methods, and tax behavior.
- Apex is the tax authority. Any Helcim recurring payment plan used by this integration MUST have `taxType = "no_tax"` so Helcim does not add a second tax calculation.
- A monthly plan uses `billingPeriod = "monthly"`, `billingPeriodIncrements = 1`.
- A fixed-term subscription must be used with a Helcim payment plan whose `termType` supports expiration; current docs state an expiring subscription cannot be placed on a forever plan.
- Do not guess body field names for `activationDate`, `maxCycles`, `paymentMethod`, etc. Verify the current Create Subscription reference before implementation.

Do not create or delete Helcim payment plans automatically in production in this first version. Prefer configured provider plan IDs created deliberately in Helcim and verified by the backend before activation.

---

# 4. Production safety gate

Implement recurring features with activation OFF by default.

Add app configuration / environment-backed protection such as:

```
recurring_billing_enabled = false
service_plan_contract_mode = test
helcim_recurring_plan_id_expires = <blank until configured>
helcim_recurring_plan_id_forever = <blank until configured, optional future use>
```

The exact storage location can be `app_config` for non-secret flags/IDs and Edge Function secrets only for secrets.

**While `recurring_billing_enabled=false`:**

- admin can add equipment
- admin can create/send offers
- customer can review/sign agreements
- PDF generation/storage can work
- payment-method verification may be tested only when explicitly authorized
- no Helcim subscription may be created
- no recurring charge may be initiated

`subscription-activate` must refuse with a clear safe response when the flag is disabled.

Do not enable the flag in code, SQL defaults, or deployment docs.

---

# 5. Database model

Create one non-destructive production migration:

```
SERVICE_PLANS_UPGRADE.sql
```

Also add it as the next numbered Supabase migration without altering prior migration files.

## A. `customer_equipment`

Minimum model:

- `id uuid primary key default gen_random_uuid()`
- `customer_id uuid not null references customers(id)`
- `unit_number text`
- `year text`
- `make text`
- `model text`
- `serial_number text`
- `equipment_type text default 'forklift'`
- `service_location text`
- `notes text`
- `status text` (`active`,`inactive`,`retired`)
- `created_at`, `updated_at`

Do not require serial number because some customers may not have it at offer time.

## B. `service_plan_offers`

One row is a versioned recommendation sent to one customer for one equipment unit.

Include at minimum:

- `id uuid`
- `customer_id`
- `equipment_id`
- `status` (`draft`,`sent`,`accepted`,`declined`,`expired`,`cancelled`)
- `plan_name`
- `description`
- `included_services jsonb`
- `exclusions jsonb` or structured text
- `term_months integer` default 6
- `activation_date date`
- `ach_monthly_subtotal_cents`
- `ach_monthly_tax_cents`
- `ach_monthly_total_cents`
- `card_monthly_subtotal_cents`
- `card_monthly_tax_cents`
- `card_monthly_total_cents`
- tax snapshot fields matching current Apex tax semantics (`tax_rate_milli_pct`, `tax_exempt`, etc.)
- `offer_version integer`
- `sent_at`, `expires_at`, `accepted_at`, `declined_at`
- `created_by uuid`
- timestamps

Money must be integer cents in service-plan tables. Never floats for authoritative recurring price.

Offer becomes immutable once accepted. If admin changes price/services afterward, create a new offer/version rather than silently rewriting what the customer accepted.

## C. `service_plan_agreements`

One accepted offer produces exactly one immutable agreement snapshot.

Include:

- `id uuid`
- `offer_id unique`
- `customer_id`
- `equipment_id`
- `agreement_version text`
- `selected_payment_method` (`card`,`ach`)
- selected `monthly_subtotal_cents`, `monthly_tax_cents`, `monthly_total_cents`
- `term_months`
- `activation_date`
- `snapshot jsonb not null` containing ALL accepted business terms, prices, equipment, customer, plan services/exclusions, and the full agreement text/version
- signer name
- signer title
- typed signature / signature representation
- explicit consent flags
- `signed_at timestamptz`
- optional `signer_ip_hash` (hash only; never store raw IP unless there is a documented business/legal reason)
- user-agent or minimal audit metadata if desired
- `pdf_path` to a PRIVATE storage bucket
- `document_sha256`
- `status` such as `signed`,`superseded`,`cancelled`

Implement an immutability guard. After creation, accepted contract data cannot be edited in place. If a payment method/price/term change changes the authorized amount, create an amendment/new agreement.

## D. `service_subscriptions`

Apex's mirror of the Helcim subscription:

- `id uuid`
- `agreement_id unique`
- `offer_id`
- `customer_id`
- `equipment_id`
- `provider text default 'helcim'`
- `provider_customer_code text`
- `provider_payment_plan_id text/integer as appropriate`
- `provider_subscription_id text/integer unique nullable until activated`
- `payment_method` (`card`,`ach`)
- `recurring_subtotal_cents`
- `recurring_tax_cents`
- `recurring_total_cents`
- `activation_date`
- `next_billing_date`
- `term_months`
- `max_cycles`
- `times_billed default 0`
- `reminder_enabled boolean not null default true`
- `status` (`setup_pending`,`active`,`past_due`,`paused`,`cancel_requested`,`cancelled`,`completed`,`failed_setup`)
- `has_failed_payments`
- `last_synced_at`
- cancellation/request metadata
- timestamps

## E. Existing `customers`

Add a nullable unique-ish Helcim customer mapping only if needed by current Helcim flow, e.g. `helcim_customer_code text`.

Before adding, search the current schema to ensure an equivalent field does not already exist.

## F. Existing `payments`

Do **not** overload `provider`.

Add only if absent:

- `payment_source text not null default 'one_time' check in ('one_time','recurring')`
- `subscription_id uuid references service_subscriptions(id)`
- `billing_period_start date`
- `billing_period_end date`
- provider recurring payment number/id fields needed for idempotent reconciliation

A recurring payment is:

```
provider='helcim'
payment_source='recurring'
subscription_id=<Apex subscription uuid>
```

Do not invent `provider='helcim_recurring'`.

## G. Existing `invoices`

Recurring cycle invoices must be distinguishable from ordinary invoices and must not accidentally expose the existing one-time `Pay Securely` button.

Add safe fields as needed, e.g.:

- `invoice_source` (`one_time`,`recurring`)
- `subscription_id`
- `billing_period_start`
- `billing_period_end`

Then update `payment-checkout` defensively so a recurring invoice cannot be paid through the one-time Fee Saver checkout unless a future explicit past-due flow is designed. This must be a very small isolated guard and must not change normal one-time behavior.

---

# 6. Required uniqueness / idempotency

Add database protections so repeated workers/webhooks/API retries cannot duplicate money records:

- unique Helcim subscription ID when present
- unique agreement per accepted offer
- one active Apex subscription per agreement
- unique recurring cycle identity such as `(subscription_id, provider_payment_number)` where available
- unique recurring invoice per `(subscription_id, billing_period_start)` or another authoritative cycle key
- unique provider transaction remains preserved by existing payment constraint
- all notification events retain unique `notification_outbox.event_key`

If Helcim does not expose a stable payment number/id in a particular response, do not invent one. Verify the current recurring payment sub-object fields and choose the most authoritative stable key.

---

# 7. RLS and authorization

Follow the current security style.

Customers:

- may SELECT only their own equipment/offers/agreements/subscriptions
- may not directly INSERT/UPDATE/DELETE authoritative financial/contract tables through PostgREST
- customer actions (accept/decline/sign/reminder toggle/payment-method verification) go through narrow Edge Functions or SECURITY DEFINER RPCs with ownership checks

Admin:

- may manage equipment/offers/subscriptions through admin-only server paths

Agreement PDF bucket:

- private
- customer can receive a short-lived signed URL only for an agreement they own
- admin can access through authorized server/admin path

Never weaken invoice/payment RLS to make recurring work.

---

# 8. Contract/e-sign flow

Create a versioned agreement renderer such as:

```
supabase/functions/_shared/service-plan-agreement.ts
```

The agreement must snapshot, at minimum:

- Apex Lift Solutions identification/contact
- customer/company
- signer name/title
- equipment make/model/year/serial/unit/location
- service plan name
- included services
- exclusions
- monthly ACH price (subtotal/tax/total)
- monthly card price (subtotal/tax/total)
- selected payment method and exact authorized recurring amount
- activation date
- term / cycle count
- recurring payment authorization
- cancellation / failed payment / service scope sections
- electronic signature consent
- agreement version
- signed timestamp

**Do not present invented legal terms as attorney-approved.** Mark terms needing review with `LEGAL REVIEW REQUIRED` in source comments and handoff notes. The production UI may use a neutral draft contract only if the owner explicitly approves the text.

Require explicit checkboxes, not one blanket checkbox, for at least:

1. customer reviewed service scope / exclusions;
2. customer authorizes the exact selected recurring monthly amount and method;
3. customer agrees to electronic records/signatures;
4. customer acknowledges term/cancellation language.

Agreement is signed FIRST. Payment verification/activation happens afterward.

If customer changes from ACH to card (or reverse) and that changes the monthly authorized price, require a new agreement/amendment before changing the subscription.

---

# 9. PDF and immutable record

Generate a real server-side PDF after signing, not a browser-only printable page.

Requirements:

- no external user-controlled HTML fetching
- use a deterministic server-side PDF library compatible with Supabase Edge/Deno
- standard embedded font only; no secret/local font files
- include agreement version, signature, signed date, equipment, selected amount/method, and terms
- compute SHA-256 for the canonical agreement snapshot and/or final PDF
- store PDF in a private bucket under an ownership-safe path
- save `pdf_path` + hash on the immutable agreement row

If generation fails, do not activate recurring billing. Agreement/sign flow should return a recoverable setup error and not create a provider subscription.

---

# 10. Helcim customer + payment-method verification

Implement this in separate recurring-specific functions. Do not reuse `payment-checkout` as a shortcut.

Suggested functions:

```
subscription-verify-checkout
subscription-verify-validate
```

Flow:

1. Require authenticated active customer + signed agreement ownership.
2. Read selected method from signed agreement; browser cannot choose an arbitrary lower price after signing.
3. If Apex already has a validated `helcim_customer_code`, initialize verify against that customer.
4. Otherwise use Helcim's documented `customerRequest` to create/link a customer and capture the resulting customer code after trusted verification.
5. Initialize HelcimPay.js with `paymentType='verify'` and ONLY the selected method (`cc` or `ach`) plus `setAsDefaultPaymentMethod=1` as allowed by current docs.
6. **No Fee Saver** on verify/recurring.
7. Keep checkout `secretToken` private using the existing private-session pattern or an equally strong recurring-specific private table/RPC.
8. Validate the HelcimPay.js response server-side; do not accept a browser success event as authority.
9. Persist only safe provider identifiers / customer code / masked method metadata. Never raw payment credentials.
10. Mark subscription setup `setup_pending` / method_verified only after authoritative success.

Do not store the card token in Apex if Helcim recurring only needs the customer's default method. Let Helcim own vault data.

---

# 11. Subscription activation

Create `subscription-activate` as an idempotent server-only activation function.

It MUST verify all of these before calling Helcim:

- recurring feature flag is ON
- agreement exists, belongs to customer, is signed, immutable, and not superseded/cancelled
- payment method was verified for this exact agreement / selected rail
- provider customer code exists
- no provider subscription already exists for this agreement
- selected recurring cents exactly equal agreement-authorized cents
- activation date and term exactly equal signed agreement snapshot
- configured Helcim payment-plan ID exists
- GET current Helcim payment plan immediately before activation
- plan is active
- plan currency is USD
- plan billing period is monthly with increments 1
- plan allows selected card/bank method
- **plan `taxType` is `no_tax`**; otherwise refuse activation
- plan term type is compatible with the agreement's fixed-term/forever semantics

Use `subscriptionIdempotencyKey()` for the Create Subscription request: exactly 25 alphanumeric characters.

Persist the idempotency key before the provider call so a network ambiguity can be reconciled rather than creating a second subscription.

If the provider call times out after submission, DO NOT blindly retry with a new key. Reconcile first against Helcim using customer/payment-plan/agreement context.

Do not mark Apex subscription active until Helcim confirms creation and the returned subscription identity is stored.

---

# 12. Recurring billing reconciliation — keep separate from one-time reconcile

Prefer a new worker:

```
subscription-reconcile
```

Do not substantially rewrite `payment-reconcile`, which is already responsible for one-time/ACH safety.

Run recurring reconciliation on a scheduled cadence appropriate for billing (hourly is fine).

For each active/past_due subscription:

- GET authoritative Helcim subscription (including payment sub-objects as required by current docs)
- update next billing date, times billed, status, failed-payment indicator
- detect new processed recurring payment cycles idempotently
- create/update ONE Apex recurring invoice per provider billing cycle
- create/update ONE Apex `payments` ledger row per provider billing cycle
- never create duplicate invoice/payment on worker replay

Helcim subscription payments and transaction objects are distinct. If you need the transaction ID, use current Helcim documentation to reconcile the recurring payment sub-object to its transaction conservatively. Do not guess based solely on amount when ambiguous.

## Card recurring payment

After authoritative provider approval:

- Apex recurring payment `status='succeeded'`
- invoice becomes paid
- payment source recurring
- emit receipt/customer/admin notifications exactly once

## ACH recurring payment

Do not assume provider subscription `approved` means bank settlement if current Helcim ACH semantics distinguish authorization from clearing.

Use authoritative ACH transaction state and existing ACH conventions:

- pending -> invoice `payment_pending`
- settled/cleared -> succeeded/paid
- returned/failed -> failed/unpaid + subscription past_due

No browser can change these states.

## Declined/failed recurring payment

- record failed payment attempt/cycle without fabricating money movement
- invoice remains unpaid (or appropriate non-paid state)
- subscription becomes `past_due`
- customer + admin failure email exactly once
- do not create an automatic one-time Pay button on the recurring invoice

---

# 13. Recurring invoices / receipts

Each actual recurring billing cycle must appear in the existing customer/admin financial history.

Invoice should clearly indicate:

- `Monthly Service Plan`
- equipment unit
- billing period
- selected method
- subtotal / Apex tax / total
- service plan / agreement reference

Payment receipt should clearly indicate recurring payment and provider reference.

A recurring invoice must never disappear from customer history.

Refunds for successful recurring payment rows should reuse the existing `payment-refund` correction-ledger semantics wherever compatible. Make only the minimum changes needed to support `payment_source='recurring'`; do not create a second refund ledger.

---

# 14. Reminder email

Default `reminder_enabled=true`.

Send an optional reminder roughly 24 hours before the next scheduled charge.

Because billing dates are date-based and Apex operates in New York, use explicit `America/New_York` date handling in the worker rather than assuming server UTC is local time.

A safe implementation is an hourly worker that checks for `next_billing_date = tomorrow in America/New_York` and queues a unique reminder event once.

Reminder includes:

- customer/company
- equipment
- charge date
- exact selected recurring total
- selected payment method (masked/generic, never credentials)
- service plan name

Customer can toggle only this reminder.

They CANNOT disable:

- agreement signed
- method verified/setup status
- subscription activation
- payment receipt
- ACH submitted/settled/returned
- payment failure
- cancellation
- material agreement changes
- refunds/reversals
- legally required notices

---

# 15. Customer portal UI

Add a first-class **Service Plans** navigation section.

Views/states:

### Offer awaiting action
- equipment
- scope
- exclusions
- term
- ACH monthly subtotal/tax/total
- Card monthly subtotal/tax/total
- Review Agreement
- Decline

### Signed but setup incomplete
- Agreement Signed
- selected method / amount
- Verify Payment Method button
- no subscription-active badge yet

### Active
- ACTIVE
- equipment
- service plan
- selected monthly amount/method
- next payment date
- term / payments completed
- reminder toggle
- View Signed Agreement PDF
- View Invoices & Receipts
- Update Payment Method (must follow amendment rule when price changes)
- Request Cancellation

### Past due
- clear non-alarming past-due explanation
- payment-method update flow
- no generic one-time Fee Saver Pay button unless specifically designed later

### Cancelled/completed
- historical agreement + invoices remain permanently accessible

---

# 16. Admin portal UI

Add **Service Plans** to admin navigation with professional sections:

- Overview
- Equipment
- Offers
- Active Plans
- Past Due
- Cancel / Completed

Admin actions:

- add/edit customer equipment (before agreement; historical agreement snapshot never changes)
- create/edit draft offer
- send offer
- duplicate/revise offer
- view signed agreement/PDF
- view Helcim/Apex subscription state
- see next billing / last payment / failed payment
- cancel subscription only through a backend provider-authoritative action
- resend customer setup link/email
- no manual toggle that can mark a provider subscription active without Helcim

---

# 17. Cancellation / pause / payment-method changes

Do not invent legal cancellation policy.

V1 customer portal should **request cancellation**, not silently terminate provider billing unless the business contract explicitly permits immediate self-service cancellation.

Admin cancellation backend must:

1. fetch current provider subscription
2. make the documented provider cancellation/update call
3. only then mirror cancellation in Apex
4. preserve all invoices/payments/agreement history
5. send customer/admin cancellation notices once

If provider state is ambiguous, leave Apex in `cancel_requested`/review state; do not claim cancelled.

Payment method change:

- use HelcimPay.js verify to set a new default method
- if switching rail changes price, require signed amendment/new agreement BEFORE provider subscription method/amount changes
- if only replacing card with another card at same authorized price, an agreement amendment may not be necessary; still record audit trail and verify current legal/business requirement

---

# 18. Failed payment retry

Use the current official Helcim Recurring Procedure for retrying a failed subscription payment only after the reason is corrected.

Do not implement a blind client-side retry loop.

If Helcim account settings already perform automated retry, do not create a second competing retry schedule in Apex. Reconcile provider state and surface it.

---

# 19. Notifications

Extend `_shared/email.ts` / outbox events with distinct event types such as:

- `service_plan_offer_sent`
- `service_plan_offer_declined_admin`
- `service_plan_agreement_signed`
- `service_plan_agreement_signed_admin`
- `subscription_setup_required`
- `subscription_activated`
- `subscription_activated_admin`
- `subscription_payment_reminder`
- `recurring_payment_received`
- `recurring_payment_received_admin`
- `recurring_ach_submitted`
- `recurring_payment_failed`
- `recurring_payment_failed_admin`
- `subscription_cancel_requested_admin`
- `subscription_cancelled`
- `subscription_cancelled_admin`

Every business event must have a deterministic unique event key so worker replay never sends duplicates.

Do not make email failure roll back contract/payment/provider state.

---

# 20. Audit trail

Add useful `activity_log` / `payment_events` or a dedicated service-plan event table for:

- offer created/sent/declined/accepted
- agreement signed + version/hash
- payment method verification started/succeeded/failed
- subscription activation attempted/succeeded/ambiguous/failed
- recurring sync results
- payment cycle detected
- reminder sent
- cancellation request/provider cancellation
- method change/amendment

Never log API tokens, secret tokens, raw card/bank data, webhook secrets, or full sensitive provider responses.

---

# 21. Testing phases — DO NOT skip ahead

Implement in phases and stop after each phase with exact test steps.

## Phase A — schema + RLS only

- produce `SERVICE_PLANS_UPGRADE.sql`
- do NOT run it
- give me read-only preflight queries and expected output
- prove no existing table/column is dropped or renamed

## Phase B — admin equipment + offer creation

No Helcim recurring calls.

Test:
- add test forklift
- create test offer
- send to test customer
- verify ownership/RLS

## Phase C — customer offer + contract

No subscription creation.

Test:
- customer sees only their offer
- chooses ACH/card
- agreement snapshot exact
- signature + PDF generated
- immutable after sign
- customer/admin agreement emails once

## Phase D — Helcim payment-method VERIFY only

Recurring activation remains OFF.

Test card and ACH verify separately with test customer. No purchase/recurring charge.

Verify customer mapping/default payment method securely.

## Phase E — subscription activation in non-production/test mode

Before a live subscription:
- GET configured Helcim plan
- prove `taxType=no_tax`
- prove monthly cadence/payment method/term compatibility
- prove exact 25-char idempotency key
- prove activation flag protects production

## Phase F — one controlled recurring test

Only after explicit owner approval.

Use one low-dollar test agreement/subscription and verify exactly one first provider billing, one Apex invoice, one payment row, and one set of emails.

## Phase G — cancellation + failed payment + refund

Test cancellation and refund/correction behavior before production rollout.

---

# 22. Deliverables from you in this Claude chat

Do not just explain what should be built. Modify the supplied repository files.

At the end provide:

1. exact list of every file added/changed
2. a new `SERVICE_PLANS_UPGRADE.sql`
3. next numbered Supabase migration file
4. all new Edge Functions
5. all admin/customer portal changes
6. any shared Helcim/email helpers changed
7. RLS matrix additions
8. secrets/config additions (names only, never values)
9. pg_cron jobs required, but do not schedule them without approval
10. exact deployment commands
11. exact SQL run order
12. exact test plan, one test at a time
13. rollback strategy that does not destroy signed agreements/payment history
14. a final `CLAUDE_HANDOFF_V24.md` recording what was actually implemented

Also create a ZIP of the fully modified repo for review.

---

# 23. Coding rules

- Do not deploy.
- Do not push.
- Do not run production SQL.
- Do not enable recurring billing.
- Do not change working one-time behavior unless absolutely required for an isolated recurring guard.
- Do not remove historical payment/refund/reversal rows.
- Do not trust browser price, status, agreement state, or customer ownership.
- Do not use floating point for authoritative cents.
- Do not store payment credentials.
- Do not fabricate provider success if an API call times out.
- Do not make a new provider request after an ambiguous timeout until reconciliation determines whether the first request succeeded.
- Do not make recurring invoices payable through the one-time Fee Saver checkout by accident.
- Do not invent legal conclusions. Flag legal language for review.
- Prefer small isolated recurring functions over modifying the already-working payment functions.

If current Helcim documentation contradicts this handoff, STOP, cite the current official documentation in your report, explain the conflict, and update the design before coding that piece.
