# Apex V24.3 — Phase D/E

Adds the first real Helcim recurring contact while preserving V23 one-time/refund/reversal paths.

## Fixed-term contract decision
- Individual forklift agreements remain 6 scheduled monthly payments by default.
- No customer cancellation action is exposed after signature.
- Contract Section 9 now states fixed term / no ordinary customer cancellation and remains LEGAL REVIEW REQUIRED while contract mode is test.
- Internal cancelled fields/status remain reserved for exceptional operational/provider/legal intervention; they are not a customer contract right.

## New Edge Functions
- `subscription-verify-checkout`: creates/locates Helcim customer, creates Apex subscription mirror if needed, initializes HelcimPay.js `paymentType=verify`, `amount=0`, selected signed rail only, and `setAsDefaultPaymentMethod=1`.
- `subscription-verify-validate`: validates hash, confirms provider customer server-to-server, stores only safe masked display and marks `method_verified`.
- `subscription-activate`: gated by `recurring_billing_enabled=true`, verifies Helcim payment plan immediately before create, persists 25-char idempotency key before POST, reconciles ambiguous prior attempts before any new create, and GET-confirms provider subscription before marking active.

## Still gated
`recurring_billing_enabled` remains false. Deploying this code cannot create a subscription until the flag is deliberately changed by hand.

## Required provider plan
Configure one Helcim expiring plan and save its id in `app_config.helcim_recurring_plan_id_expires`:
- status active
- type subscription
- USD
- billingPeriod monthly
- billingPeriodIncrements 1
- dateBilling Sign-up
- termType expires
- taxType no_tax
- paymentMethod card_bank
- no setup fee charged immediately

Apex sends the exact signed agreement total as subscription `recurringAmount` and `maxCycles=6` (or the agreement term).

## Deployment order
1. Deploy `service-plans-customer` (new fixed-term wording/UI support).
2. Deploy `subscription-verify-checkout`.
3. Deploy `subscription-verify-validate`.
4. Deploy `subscription-activate`.
5. Push updated `portal-customer.js`.
6. Keep recurring gate false and test $0 verify.
7. Configure/verify Helcim recurring plan ID.
8. Only after review, turn gate true and activate one future-date test subscription.

Do not use a same-day activation during initial testing.
