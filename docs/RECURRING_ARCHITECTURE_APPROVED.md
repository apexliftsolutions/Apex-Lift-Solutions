# Recurring Service Plans — Approved Architecture (NOT YET IMPLEMENTED)

**Status: on hold pending one-time payment verification.** Nothing in this
document has been built. It records the approved design so it survives.

## Two changes from my original plan

### Change 1 — do not overload `provider`

`payments.provider` describes the *processor*, not the workflow. It stays
`'helcim' | 'manual'`. Recurring vs one-time is a separate axis:

```sql
alter table payments
  add column if not exists payment_source text not null default 'one_time'
    check (payment_source in ('one_time','recurring')),
  add column if not exists subscription_id uuid references service_subscriptions(id),
  add column if not exists billing_period_start date,
  add column if not exists billing_period_end   date;
```

A recurring charge is then `provider='helcim', payment_source='recurring'`.
Reporting by processor and reporting by workflow stay independent.

### Change 2 — Helcim plan must be `taxType = no_tax`

Apex's tax system is authoritative. Helcim's payment plan object controls
"how the Helcim system will calculate tax for the payments when they are
processed" — if both apply tax, customers are double-charged on a signed
contract.

`subscription-activate` must, before creating any subscription:

1. GET the configured payment plan from Helcim
2. assert `taxType == 'no_tax'`
3. if not: **refuse activation**, write a config error to `payment_events`,
   leave the agreement signed and the subscription `failed_setup`
4. never create the subscription

This survives someone changing the plan in the Helcim dashboard later.

`recurringAmount` sent to Helcim is the final Apex-authorized amount for that
customer / equipment / payment method, already inclusive of whatever the Apex
tax model produced.

## Verified against current Helcim docs

| Claim | Source |
|---|---|
| Subscription overrides plan amount — one generic plan works | Recurring API → Subscribers: *"recurring amount for that subscription"* |
| `paymentType: "verify"` + `customerRequest` is the documented way to capture recurring payment details | Recurring API → Step 2 |
| A subscription charges the customer's **default** card or bank account | Recurring API → Payment methods |
| Method switching = `setcustomercarddefault` / `setcustomerbankaccountdefault` | Recurring API → Payment methods |
| Plan controls tax behaviour | Recurring API → Payment plans |
| Fee Saver is incompatible with Recurring | Helcim Learn |

Endpoints (v2.2): `payment-plan-create|collection|single|patch|delete`,
`subscription-create|collection|single|patch|delete`,
`subscription-payment-patch`, `procedure-process-payment`.

## Approved model

One lift = one recommendation = one signed agreement = one subscription.

New tables: `customer_equipment`, `service_plan_offers`,
`service_plan_agreements` (immutable), `service_subscriptions`.
No `subscription_billing_events` — recurring charges go in the existing
`payments` ledger.

New Edge Functions: `service-plan-offer`, `service-plan-sign`,
`subscription-activate`. Extended: `payment-events`, `payment-reconcile`,
`_shared/email.ts`.

## Held for human review

- Final ACH vs card price-differential wording (card-network + NY rules)
- Agreement legal terms
- Electronic signature enforceability

These get placeholders and a source comment, not invented language.

## Gate

Do not begin until `ONE_TIME_PAYMENT_TEST.sql` section C reads PASS on every row.
