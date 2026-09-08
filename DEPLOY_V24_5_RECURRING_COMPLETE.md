# Apex V24.5 — recurring billing completion

## What this release adds
- subscription-reconcile Edge Function (replay-safe recurring cycle ledger)
- admin Activate billing button
- admin Cancel future billing button (no customer cancel control)
- recurring-card and recurring-ACH invoice/payment mirroring
- recurring refund/reversal support through existing payment-refund endpoint
- recurring invoice one-time-checkout suppression
- recurring-aware invoice/failure emails
- production go-live gate SQL

## Safety model
- Helcim remains the processor authority.
- One provider subscription payment => at most one Apex recurring invoice/payment pair.
- Ambiguous transaction matches are never guessed.
- ACH is not marked paid until the underlying ACH transaction is cleared.
- Cancel stops future provider subscription billing; it does not refund prior charges.
- Refund is a separate admin action against an already-successful payment.
- Signed agreements are not edited or deleted.
- Production activation refuses a historical activation date.

## Deploy
Run migration 0008 only:

```bash
npx supabase db push
```

Or run `RECURRING_OPERATIONS_V24_5.sql` in Supabase SQL Editor if you manage production migrations manually.

Deploy functions:

```bash
npx supabase functions deploy service-plans-admin
npx supabase functions deploy subscription-activate
npx supabase functions deploy subscription-reconcile
npx supabase functions deploy payment-refund
npx supabase functions deploy outbox-worker
```

`outbox-worker` must be redeployed because `_shared/email.ts` changed.

Push frontend:

```bash
git add portal-admin.html portal-admin.js portal-customer.html portal-customer.js \
  supabase/functions/service-plans-admin/index.ts \
  supabase/functions/subscription-activate/index.ts \
  supabase/functions/subscription-reconcile/index.ts \
  supabase/functions/payment-refund/index.ts \
  supabase/functions/_shared/email.ts \
  supabase/migrations/0008_recurring_operations.sql

git commit -m "Complete recurring service plan billing"
git push
```

## Schedule reconciliation
Open `RECURRING_CRON_SETUP.sql`, replace `<RECONCILE_WORKER_KEY>` with the same secret used by payment-reconcile, then run it once in Supabase SQL Editor.

## Final go-live gate
After all functions/frontends are deployed and your Helcim recurring payment plan id is configured, run:

`GO_LIVE_RECURRING_V24_5.sql`

It refuses to enable recurring billing unless `service_plan_contract_mode=live` and a recurring Helcim plan id is configured.

## First live test
Use a low-dollar signed plan with a future activation date.
1. Verify payment method ($0).
2. Activate plan.
3. Confirm exactly one subscription in Helcim.
4. Run subscription-reconcile manually once with the worker header or wait for cron.
5. On the billing date, confirm exactly one Helcim charge, one Apex recurring invoice, and one Apex payment row.
6. Run reconcile again and verify counts do not increase for the same provider payment.
7. Test admin refund on that invoice.
8. Test admin cancellation on a separate low-dollar subscription so future charges stop.
