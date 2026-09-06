# Apex payment fix v21

This package is based on the exact `apex-payment-review.zip` supplied after the
`INV-1A10E21B6E` / Helcim transaction `54434319` test.

## Exact root cause of the newest UNPAID regression

The live event trail reached:

- `validation_started`
- `transaction_response_normalized`
- `provider_lookup_started`
- `provider_lookup_succeeded` (`APPROVED`)

and then stopped until the admin manually reconciled it.

The uploaded tree had `payment-validate` back on `2026-09-05.v18`. In that
file, the APPROVED branch referenced `achTxn` before `const achTxn` was declared.
That is a JavaScript temporal-dead-zone `ReferenceError`, which explains why the
function vanished immediately after `provider_lookup_succeeded` and never
wrote `payment_persisted` / `invoice_paid`.

That same regressed v18 file also still contained the invalid comparison of
Helcim's internal `invoiceNumber` to the Apex invoice id. The current checkout
does not bind an Apex invoice into Helcim, so that comparison must not exist.

In other words: the new Helcim/Admin token was working; the validator itself had
been overwritten by an older implementation.

## Files changed in v21

### `supabase/functions/payment-validate/index.ts`

- version `2026-09-06.v21`
- fixes the `achTxn` use-before-declaration crash
- removes the false Helcim `invoiceNumber == Apex invoice id` requirement
- allows safe reprocessing of `unknown` attempts
- keeps server-side HelcimPay hash verification
- uses the now-working provider lookup when available
- retains a hash-verified HelcimPay fallback if provider lookup is temporarily unavailable
- Fee Saver split remains: Apex base / fee / total charged
- card `APPROVED` => Apex `succeeded` immediately
- ACH remains pending until clearing
- card approval does not pretend bank settlement occurred
- error-checks the payment update, invoice recalc and invoice readback
- emits `payment_persisted` and `invoice_paid` checkpoints

### `supabase/functions/payment-events/index.ts`

- preserves top-level Helcim webhook transaction-id handling
- uses `/v2/ach/transactions/{id}` for ACH
- provider fetch failure is retryable; it is not falsely marked processed
- duplicate provider transaction protection retained

### `supabase/functions/payment-reconcile/index.ts`

- checks `initiated` **and** `unknown`
- never automatically abandons/voids `unknown`
- card collection uses `dateFrom` / `dateTo`
- ACH collection uses `startDate` / `endDate` and amount bounds
- ACH direct lookup uses `/v2/ach/transactions/{id}`
- pending ACH refund rows are also reconciled safely
- refund correction settlement does not replace the invoice's original `payment_id`

### `portal-customer.js`

- payment behavior unchanged except diagnostic client version is now `2026-09-06.v21`
- existing explicit refund/void invoice state renderer is retained

### `portal-admin.js` / `portal-admin.html`

The current tree had a `refundPayment()` function, but no invoice action ever
called it. That is why the admin portal showed no refund/void option.

v21 wires it into the invoice list:

- paid eligible Helcim payment => `Refund / Void`
- partially refunded => `Refund Remaining`
- pending correction => no duplicate refund button
- fully returned => no duplicate refund button
- added invoice filters for payment pending / partially refunded / refunded / void
- admin payment summary considers original payment plus refund/reversal rows

### `supabase/functions/payment-refund/index.ts`

Rewritten as a self-contained admin-only provider action.

- preserves the original successful payment row
- creates a separate correction ledger row
- full card return: tries Helcim reverse first, then refund when reverse is not available
- partial card return: refund
- ACH transaction is fetched first
- open approved ACH + full remaining amount: ACH void
- open ACH + partial: waits for the batch to close rather than inventing a partial void
- closed approved ACH: ACH refund
- ACH refund remains `pending` until provider clearing; it is not falsely marked settled
- prevents a second correction while one is already in flight

## IMPORTANT: no SQL migration is included yet

The uploaded zip did not include the production definitions of:

- `recalc_invoice_status`
- `notify_on_payment`
- `guard_payment`
- the complete current `payments` constraints/columns

Therefore **do not perform the first live Refund/Void action yet**.

Run `READ_ONLY_REFUND_AUDIT.sql` first and review/send the results. We need to
verify the existing database really understands `kind = refund/reversal`,
`refund_of`, and does not send a normal `payment_received` email when a refund
row succeeds.

This audit is read-only and changes nothing.

## Safe deployment order

### A. Fix the automatic card-payment regression first

From repo root:

```bash
npx supabase link --project-ref cjtezsgfdfijmdxzzbiq
npx supabase functions deploy payment-validate
npx supabase functions deploy payment-events --no-verify-jwt
npx supabase functions deploy payment-reconcile --no-verify-jwt
```

Push the updated `portal-customer.js` as part of the normal frontend deploy.

`payment-checkout` and `admin-action` are included for context but were not
changed by this v21 automatic-payment fix.

Do **not** pay `INV-1A10E21B6E` again. It was already manually reconciled to
`succeeded` for Helcim transaction `54434319`.

### B. Refund/Void feature

Before deploying/testing this part:

1. Run `READ_ONLY_REFUND_AUDIT.sql`.
2. Verify the DB functions/constraints support the correction ledger semantics.
3. Then deploy:

```bash
npx supabase functions deploy payment-refund
```

and push:

- `portal-admin.js`
- `portal-admin.html`

If the audit shows the DB needs a migration, create/review that migration before
any live refund.

## Next fresh card acceptance test (only after v21 is deployed)

Use ONE brand-new low-value invoice exactly once.

Expected events:

1. `checkout_created`
2. `validation_started` with `fn_version = 2026-09-06.v21`
3. `helcimpay_hash_verified` (or equivalent verified integrity trail)
4. `transaction_response_normalized`
5. `provider_lookup_started`
6. `provider_lookup_succeeded`
7. `provider_approved`
8. `payment_persisted`
9. `invoice_paid`

Expected DB state:

- payment status `succeeded`
- method `card`
- `amount_cents` = Apex invoice base
- `fee_cents` = Fee Saver amount
- `total_charged_cents` = actual Helcim total
- provider transaction id populated
- invoice status `paid`
- invoice paid timestamp populated
- Pay button gone after refresh/login
- exactly one customer payment receipt email
- exactly one admin payment email

If the trail again stops before `payment_persisted`, do **not** create another
charge; inspect that exact event trail.
