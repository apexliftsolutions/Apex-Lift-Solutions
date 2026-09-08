# Phase A — decisions on record

Settled after the independent audit. These are business/architecture decisions,
not open questions. Change them deliberately, not incidentally.

## 1. Contract granularity — one machine, one contract

One forklift = one offer = one agreement = one subscription = one monthly charge.
A customer with three forklifts signs three agreements and sees three charges.

The portal may group them visually under one company account. The legal and
financial authorization stays explicit per machine.

## 2. Term — six payments, then completed. No silent renewal.

The subscription ends after six cycles and moves to `completed`, which is a
terminal state in the database. Continuing the plan requires a new offer, a new
signature and a new subscription.

This is deliberate while the contract language is unreviewed, and it matches
Helcim: a cancelled subscription there cannot be resumed either.

## 3. Helcim payment plan — nominal base amount, never zero

One generic expiring monthly plan with a nominal base amount. Every subscription
overrides it with the exact signed contract total. See
`docs/HELCIM_RECURRING_VERIFIED_V24.md` §7.

Plan configuration, re-verified by `subscription-activate` before every
activation: `status=active`, `currency=USD`, `type=subscription`,
`billingPeriod=monthly`, `billingPeriodIncrements=1`, `termType=expires`,
`taxType=no_tax`, `paymentMethod=card_bank`, `dateBilling=Sign-up`.

## 4. Activation date during testing — never today

A `type=subscription` plan bills on its activation date. Test subscriptions use
tomorrow or later unless a live charge is the explicit intent.

## 5. ACH settlement — clearing status, not auth status

`APPROVED` means submitted, not settled. Only `statusClearing = CLEARED`
settles an Apex invoice. `CONTESTED` is flagged for a human and never
auto-resolved. Full mapping in `docs/HELCIM_RECURRING_VERIFIED_V24.md` §5.3.

## 6. `cancel_requested → active` stays in the graph

An admin may decline a cancellation request. **Declining is not a silent
dismissal.** When Phase G implements it, denial requires all three:

1. an admin reason, recorded on the subscription (`cancel_reason`),
2. an append-only `service_plan_events` row naming the admin and the reason,
3. an email to the customer telling them the request was declined and why.

No schema change is needed for this — `service_plan_events.detail` is jsonb and
append-only, and `cancel_reason` is already writable. Recorded here so the
requirement is not lost between phases.

## 7. Migration numbering

`0005_refund_void_v22.sql` (parity with production) + `0006_service_plans.sql`.
Confirmed by the auditor. The migration chain now rebuilds a complete, correct
database from scratch.
