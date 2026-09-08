# Helcim Recurring API — verified against live docs

**Verified 2026-09-06 against Helcim Developer Docs v2.2.** Revision 2 — ACH
transaction filtering corrected after independent audit; zero-dollar plan
assumption demoted to unverified. Re-verify before
Phase E. Where this file disagrees with `START_HERE_CLAUDE_MONTHLY_V24.md`, this
file wins and the conflict is called out below.

Sources consulted:

- Subscribers — `https://devdocs.helcim.com/docs/recurring-subscriptions`
- Payment Plans — `https://devdocs.helcim.com/docs/recurring-payment-plans`
- Create subscriptions (OpenAPI) — `https://devdocs.helcim.com/reference/subscription-create.md`
- Create payment plans (OpenAPI) — `https://devdocs.helcim.com/reference/payment-plan-create.md`
- Managing Payment Details — `https://devdocs.helcim.com/docs/managing-payment-details`

---

## 1. CONFLICTS WITH THE HANDOFF — read these first

### 1.1 The subscription payment method is `bank`, not `ach`

`START_HERE_CLAUDE_MONTHLY_V24.md` uses `ach` throughout for the recurring rail.
The Create Subscription OpenAPI schema defines:

```
subscriptionPaymentMethod: enum [ "card", "bank" ]
```

with the description: the customer's default method is used in both cases, and
the chosen method must be allowed by the payment plan's specified payment method.

**Resolution taken in Phase A.** Apex keeps its own native `card` | `ach`
vocabulary in `service_plan_agreements.selected_payment_method` and
`service_subscriptions.payment_method`, because those must agree with the
existing `payments.method` CHECK, which already uses `ach`. The translation
happens exactly once, at the API boundary, in `subscription-activate`:

```ts
// Apex rail -> Helcim subscriptionPaymentMethod
const helcimPaymentMethod = rail === "ach" ? "bank" : "card";
```

Sending `"ach"` to `POST /v2/subscriptions` will fail validation. Do not
"simplify" this mapping away.

### 1.2 One payment plan can serve BOTH rails

The handoff implies separate plan configuration per rail. The plan schema
defines:

```
planPaymentMethod: enum [ "card", "bank", "card_bank" ]
```

`card_bank` = subscriptions to the plan may bill via either credit card or ACH.

**Resolution taken in Phase A.** `app_config` seeds a single
`helcim_recurring_plan_id_expires` intended for a `card_bank` plan, plus two
optional overrides (`..._card`, `..._bank`) in case Apex later wants the rails
on separate plans or separate terminals. `subscription-activate` reads the
rail-specific key first and falls back to the shared key.

### 1.3 `maxCycles` is conditionally required

```
maxCycles: "only applicable and required for expiring subscriptions;
            it will be ignored for non-expiring subscriptions.
            Note expiring status is determined by the payment plan termType field."
```

Because Apex sells a fixed 6-month term, the configured plan MUST be
`termType: "expires"` and every subscription MUST send `maxCycles`. A `forever`
plan cannot carry an expiring subscription — the docs state this explicitly:

> You cannot add an expiring subscription to an infinitely billed payment plan,
> nor an infinite subscription to a payment plan with a set number of billing cycles.

`service_subscriptions.max_cycles` exists for exactly this and is set to
`term_months` for a monthly plan.

---

## 2. Confirmed as the handoff described

| Claim | Status |
|---|---|
| `POST /v2/subscriptions` idempotency-key is `minLength: 25, maxLength: 25`, alphanumeric | **Confirmed.** `subscriptionIdempotencyKey()` in `_shared/helcim-api.ts` is correct; `crypto.randomUUID()` would be rejected. |
| Subscription `recurringAmount` overrides the plan amount | **Confirmed.** "The value can differ from the payment plan if desired." One generic plan therefore serves every customer's individual price. |
| Payment plan controls tax behaviour | **Confirmed.** `planTaxType: [no_tax, customer, merchant]`. `no_tax` is the default when the parameter is omitted. |
| HelcimPay.js `paymentType: "verify"` + `setAsDefaultPaymentMethod: 1` captures a recurring method | **Confirmed.** Docs state the resulting default is "used for other automated Helcim payment tools, such as Recurring Payments." |
| A subscription always charges the customer's **default** card or bank account | **Confirmed.** |
| Method switching via `setcustomercarddefault` / `setcustomerbankaccountdefault` | **Confirmed**, both endpoints exist. |

---

## 3. Create Subscription — exact contract

`POST https://api.helcim.com/v2/subscriptions`

Headers: `api-token` (required), `idempotency-key` (required, exactly 25 alphanumeric).

Body is an array wrapper: `{ "subscriptions": [ { ... } ] }`

**Required fields:** `customerCode`, `dateActivated`, `paymentMethod`,
`paymentPlanId`, `recurringAmount`.

| Field | Type | Apex source |
|---|---|---|
| `customerCode` | string | `customers.helcim_customer_code` (server-verified only) |
| `dateActivated` | `YYYY-MM-DD` | `service_subscriptions.activation_date` |
| `paymentPlanId` | integer | `app_config` plan id, re-verified by GET immediately before use |
| `recurringAmount` | float | `recurring_total_cents / 100`, formatted to 2 dp |
| `paymentMethod` | `card` \| `bank` | mapped from Apex rail — see §1.1 |
| `maxCycles` | integer ≥ 1 | `term_months` (required, plan is `expires`) |
| `useCustomSetupAmount` / `setupAmount` | — | **not used.** Apex charges no setup fee. |
| `withFreeTrialPeriod` | — | **not used.** |
| `addOns` | — | **not used in V1.** |

`dateActivated` also determines when the first recurring billing date occurs.

### Response (201)

Contains the created subscription, its first payment, and active add-ons.

```json
{
  "id": 123456, "dateCreated": "...", "dateActivated": "2024-02-01",
  "dateBilling": "2024-02-07", "status": "active",
  "paymentPlanId": 5878, "customerCode": "CST1200",
  "timesBilled": 1, "recurringAmount": 15.99, "hasFailedPayments": "false",
  "payments": [ { "id": 49978, "amount": 15.99, "taxAmount": 0,
                  "status": "waiting", "dateDue": "...", "dateProcessed": "...",
                  "paymentNumber": 1, "numberOfRetries": 0 } ]
}
```

`id` and `paymentPlanId` are **integers** — hence `bigint`, not `text`, in
`service_subscriptions`. `customerCode` is a string (`"CST1044"`).

---

## 4. The activation preflight the plan must pass

`subscription-activate` GETs the configured plan immediately before creating any
subscription and refuses activation unless **all** of these hold. This survives
somebody editing the plan in the Helcim dashboard six months from now.

| Field | Required value | Why |
|---|---|---|
| `status` | `active` | an inactive plan silently does nothing |
| `currency` | `USD` | plan objects can be CAD; the docs' own example is CAD |
| `taxType` | `no_tax` | **Apex already charged tax.** Any other value double-taxes a signed contract |
| `billingPeriod` | `monthly` | |
| `billingPeriodIncrements` | `1` | `6` would silently bill every six months |
| `termType` | `expires` | required to carry a fixed 6-month subscription (§1.3) |
| `paymentMethod` | must permit the signed rail (`card_bank`, or the matching one) | |
| `type` | `subscription` | bills on the subscription's activation date, which is what Apex sells |

On any mismatch: write a config error to `service_plan_events`, leave the
agreement signed, set the subscription `failed_setup`, and **create nothing at
the provider**.

---

## 5. Reconciliation — the hard part, and what it means for the schema

### 5.1 Cycle identity

The subscription `payments[]` sub-object is the authoritative record of a
billing cycle:

```
id             integer   stable identity of this cycle      <- primary key
paymentNumber  integer   human ordinal 1,2,3...             <- secondary key
status         approved | declined | failed | waiting
amount, taxAmount, dateDue, dateProcessed, numberOfRetries
```

`payments.provider_subscription_payment_id` (bigint) stores `id`, and
`provider_payment_number` stores `paymentNumber`. The unique index
`uq_pay_recurring_cycle` on `(subscription_id, provider_subscription_payment_id)`
is what makes the reconcile worker safe to replay.

`numberOfRetries` means a declined cycle can later become approved **on the same
sub-object id**. Reconciliation must therefore UPDATE the existing Apex row, not
insert a second one. `guard_payment()` already permits `failed -> succeeded` and
forbids reopening a succeeded row, so this is safe.

### 5.2 The payment sub-object carries NO transaction ID

This is the single most awkward fact in the whole integration:

> Once the subscription runs on its billing date and processes a transaction, we
> create a `transaction` object that is independent of the subscription and its
> `payment` sub-object.

To link a cycle to a real transaction:

- **Card:** query Get card transactions by `customerCode` + `dateFrom`/`dateTo`.
- **ACH:** `GET /v2/ach/transactions` **now supports filtering and pagination.**
  The Subscribers guide still says otherwise; the guide is stale and the
  changelog is authoritative. Available parameters, confirmed 2026-09-06:

  | Parameter | Notes |
  |---|---|
  | `page`, `limit` | `limit` max 125, defaults to 125 |
  | `startDate`, `endDate` | `YYYY-MM-DD`; `endDate` must not precede `startDate` |
  | `amountMin`, `amountMax` | floats |
  | `statusAuth` | array. Allowed: `APPROVED`, `DECLINED`, `IN_PROGRESS`, `PENDING`, `CANCELLED` |
  | `statusClearing` | array. Allowed: `OPENED`, `CLEARED`, `REJECTED`, `CONTESTED`, `RETURNED` |
  | `users` | array of user ids |
  | `search` | text across transaction id, bank account last 4, order id, batch id, contact and business name |

  The change is backwards compatible: an unparameterised call still returns
  page 1 with up to 125 objects. **Phase F must use `startDate`/`endDate` plus
  `statusClearing` rather than paging the whole history**, and must page
  explicitly rather than assuming one response contains everything.

Consequences, already reflected in the schema:

1. `payments.provider_transaction_id` is **nullable** for a recurring row until
   a confident match is made. The existing unique index on
   `(provider, provider_transaction_id)` is partial (`where not null`), so this
   works unchanged.
2. Money state is driven by the **subscription payment sub-object status**, not
   by the transaction lookup. The transaction ID is enrichment for receipts and
   refunds, not the settlement gate.
3. If matching is ambiguous, record no transaction id and raise an event. Never
   guess on amount alone — every subscription on the same plan bills the same
   amount on the same day.

### 5.3 ACH is not settled just because the cycle says `approved`

ACH transactions carry `statusAuth` and `statusClearing` separately, and the
full enumerations are confirmed (verified 2026-09-06 against the endpoint
reference). Apex's settlement decision reads the **clearing** status:

| Helcim state | Apex payment | Apex invoice | Subscription |
|---|---|---|---|
| `statusAuth` PENDING or IN_PROGRESS | `pending` | `payment_pending` | unchanged |
| `statusAuth` APPROVED + `statusClearing` OPENED | `pending` | `payment_pending` | unchanged |
| `statusClearing` CLEARED | `succeeded` | `paid` | unchanged |
| `statusAuth` DECLINED / CANCELLED | `failed` | `unpaid` | `past_due` |
| `statusClearing` REJECTED or RETURNED | `failed` | `unpaid` | `past_due` |
| `statusClearing` CONTESTED | leave as-is | leave as-is | **flag for human review** — never auto-resolve a dispute |

APPROVED on its own is **not** settlement. It means the debit was submitted.
Only CLEARED settles an Apex invoice.

**Parse both representations.** These string enums are what the collection
endpoint filters on, but Helcim also documents a numeric status representation
on individual ACH transaction objects. The reconciler must accept either and
refuse to guess when it sees a value it does not recognise. The exact numeric
mapping is **not yet verified** — read it off the single-transaction reference
before Phase F writes the settlement code.

A subscription payment `status: approved` means the recurring engine submitted
the charge. Apex's existing ACH convention (pending until authoritative
clearing) still governs. Map through the ACH transaction state, not the
subscription status:

```
card : approved                      -> payments.succeeded, invoice paid
ACH  : approved + ACH pending        -> payments.pending,   invoice payment_pending
ACH  : ACH cleared/settled           -> payments.succeeded, invoice paid
ACH  : returned/failed               -> payments.failed,    invoice unpaid, subscription past_due
any  : declined | failed             -> payments.failed,    invoice unpaid, subscription past_due
```

### 5.4 `hasFailedPayments` is a string, and an inconsistent one

The docs show `"no"` in one example and `"true"` in another for the same field.
Parse it defensively — treat anything other than a clear negative as failure
present — and store the result in the boolean
`service_subscriptions.has_failed_payments`.

---

## 6. Fee Saver

Recurring Payments are not compatible with Fee Saver, which is why the offer
carries an explicit ACH price and an explicit card price rather than letting
Helcim add a convenience fee at charge time. Nothing in the recurring path sends
`hasConvenienceFee`. Verify the current Helcim Learn article before launch;
regardless of what it says, this integration does not use Fee Saver on recurring.

---

## 7. Still unverified — do not code these from memory

### DECIDED: do not use a zero-dollar plan

**A payment plan with `recurringAmount = 0` is NOT confirmed valid.** The
per-subscription override is documented, but no official statement guarantees
a zero-dollar base plan can be created. Do not build the Phase E activation
around that assumption. **Decision: create one generic expiring monthly plan
with a nominal base amount**, and always send the exact contract amount as the
subscription's `recurringAmount`. The zero-dollar plan can be tested later and
switched to if desired; nothing depends on it.

Two protections come with that decision, both mandatory in Phase E:

1. **During testing, `dateActivated` is always tomorrow or later.** A
   `type=subscription` plan bills on its activation date, so today's date means
   a live charge.
2. **After creating the subscription, GET it back from Helcim and confirm the
   returned `recurringAmount` equals the signed agreement total** before Apex
   sets `provider_verified_at` or moves the status to `active`. A nominal base
   amount is only safe if the override is verified, not assumed.

- Exact HelcimPay.js initialize payload for `paymentType: "verify"`, including
  whether `amount` is required/ignored and the exact `customerRequest` shape for
  creating-and-linking a customer. **Verify at Phase D.**
- Current ACH transaction query parameters. **Verify at Phase F.**
- Recurring Procedures: exact request for retrying a declined subscription
  payment, and whether the Helcim account already performs automatic retries.
  If it does, Apex must not run a second competing retry schedule.
  **Verify at Phase G.**
- Subscription cancellation semantics: `subscription-patch` to inactive vs
  `subscription-delete`. Delete is described as removing the subscription; Apex
  must preserve history, so patching to an inactive status is almost certainly
  correct — but confirm before writing the cancellation path. **Verify at Phase G.**


---

## 8. Endpoint notes recorded during verification

Confirmed present in the v2.2 Recurring API reference. None are used in Phase A;
they matter in Phases E–G.

| Endpoint | Phase | Note |
|---|---|---|
| `POST /v2/subscriptions` | E | create. 25-char idempotency key. |
| `GET` subscription (single / collection) | E, F | the authoritative read. Required after create, and on every reconcile. |
| `PATCH` subscription | G | almost certainly the correct cancellation path, since Apex must preserve history. Confirm against `subscription-delete` before writing it. |
| `DELETE` subscription | — | **do not use.** It removes the subscription; Apex needs the record. |
| `POST` procedure: process a subscription payment | G | the retry path for a declined cycle. **Before using it, confirm whether the Helcim account already retries automatically** — two competing retry schedules is a double-charge risk. |
| `PATCH` subscription payment: "mark payment paid" | — | **never call this.** It marks a cycle paid at the provider without money moving. It would desynchronise Apex's ledger from reality in the one direction that matters. |
| `PATCH` set customer card default / set customer bank account default | G | the payment-method change path. Changing the default is what a subscription bills against. |
| `PATCH` ACH cancel | G | cancels a pending ACH transaction. Relevant to failed-cycle handling. |
