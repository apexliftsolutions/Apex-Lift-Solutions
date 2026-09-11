# APEX BUSINESS OS — PHASE 1 ARCHITECTURE AUDIT & DESIGN

Audit and design only. Derived from the v25.0 repository as it exists. No code,
no migrations, no frontend changes in this document.

---

## 1. CURRENT STATE AUDIT

### 1.1 `customer_equipment` — already the canonical forklift record

The table exists (migration 0006) and is better than a fresh design would be:

```
id uuid pk · customer_id uuid NOT NULL → customers ON DELETE RESTRICT
unit_number · year · make · model · serial_number (all text, nullable)
equipment_type text NOT NULL default 'forklift'
service_location · notes
status NOT NULL check in ('active','inactive','retired')
created_by · created_at · updated_at
```

Already attached to it:

| Protection | Present | Where |
|---|---|---|
| Composite key `(id, customer_id)` | **Yes** — `uq_equipment_id_customer` | 0006:165 |
| Composite FK from offers | **Yes** — `fk_offer_equipment_same_customer` makes cross-customer offers unrepresentable | 0006:245 |
| Serial unique per customer, case/space-normalised, NULL-safe | **Yes** — partial unique index on `(customer_id, upper(trim(serial_number)))` | 0006:173 |
| Lifecycle enum | **Yes** — exactly the `active/inactive/retired` requested | col def |
| `updated_at` touch trigger | Yes | 0006:992 |
| Audit trigger (insert/update/delete → `audit_log`) | Yes | 0006:1002 |
| RLS: admin all, customer SELECT own | Yes | 0006:1021–1022 |
| Grants: `authenticated` SELECT only; **no INSERT/UPDATE** | Yes | 0006:1059 |
| Indexes on `customer_id` and `(customer_id, status)` | Yes | 0006:170–171 |

**Conclusion for §A:** no second table. `customer_equipment` *is* the forklift
record. Everything below extends it.

**Two things it does not have:** (a) database-level identity lock once an
agreement is signed — that lives only in `service-plans-admin` (index.ts:116–119);
(b) any link from quotes, invoices or service requests, which all carry a
free-text `equipment` column instead.

### 1.2 Service-plan chain — fully built, keep as-is

`customer_equipment → service_plan_offers → service_plan_agreements →
service_subscriptions`, each with `equipment_id NOT NULL … ON DELETE RESTRICT`.
Offers carry the six ACH/card cents columns with sum checks
(`subtotal + tax = total`) and a tax-exempt guard. One live chain per unit is
already enforced (`uq_offer_chain`). `subscription-activate` verifies
`recurringAmount` against `recurring_total_cents` on read-back.

Customer access: `service-plans-customer` reads equipment server-side
(index.ts:292); the portal also does a direct RLS-scoped `select('*')`.

### 1.3 Quotes / invoices / service requests — free-text equipment

All three tables have `equipment text`. No FK, no snapshot.

**Invoice creation is quote-only.** Two paths, both copy from a quote:
`quote_to_invoice(p_quote_id)` RPC (0004:94, service_role only) and
`admin-action create-invoice` (index.ts:68–100). Neither copies `equipment` —
the invoice has no equipment column at all. `subscription-reconcile` also
inserts invoices for recurring cycles (index.ts:303). **There is no direct
invoice creation workflow** — §H answered: don't invent one.

Admin quote form: `<select id="q-customer-select">` then a free-text
`<input id="q-equipment">` ("Forklift Make / Model").

### 1.4 `customers.status`

`check in ('pending','active','inactive')`, default `pending`. Signup creates a
pending row; admin activation sets `active`. `service-plans-admin` already gates
send-offer on `customer.status !== "active"` and `service-plans-customer` gates
sign/preview/decline the same way. "Active" is the approval semantic — nothing
else to invent.

### 1.5 `payments` ledger — the revenue source of truth, already correct shape

```
kind in ('payment','refund','reversal')   default 'payment'
status in ('initiated','pending','succeeded','failed','unknown','voided')
amount_cents bigint > 0          -- base applied to the invoice
fee_cents bigint ≥ 0             -- Fee Saver convenience fee (0 for ACH)   [0003]
total_charged_cents              -- amount_cents + fee_cents                 [0003]
refund_of uuid → payments        -- set on refund/reversal rows
provider in ('helcim','manual') · method · invoice_id · customer_id
subscription_id + cycle columns  -- with shape constraints                   [0006]
```

`recalc_invoice_status()` (0001:548) already defines the per-invoice net:
succeeded payments − succeeded refunds/reversals, with pending excluded. The
system-wide formula in §10 is the same identity summed across the ledger.

**Provider fee:** `fee_cents` is the *customer-facing* Fee Saver convenience
fee, not Apex's cost. `payment-validate` records `implied_fee_cents` from the
webhook. **Nothing in the repository stores what Helcim actually charged Apex
per transaction.** §S below treats actual cost as unavailable.

### 1.6 Recurring card pricing today

`service_plan_offers` stores ACH and card prices as six independent NOT NULL
columns. Admin enters both. The card figure is whatever admin typed. There is no
policy, no computation, no `app_config` key. `subscription-activate` sends the
chosen method's `*_monthly_total_cents` as `recurringAmount`. Fee Saver is
**not** involved in recurring — the checkout function's own comments confirm it
is a one-time-invoice mechanism.

### 1.7 Admin identity lock — exists, but only in one function

`service-plans-admin update-equipment` refuses `serial_number/make/model/year`
changes when a `signed` agreement references the unit (409
`equipment_under_signed_agreement`). It is application code. A write through any
other path — a future `equipment-customer`, a direct service_role update, a
migration — bypasses it. §D moves it into the database.

---

## 2. EXISTING COMPONENTS TO REUSE (do not rebuild)

| Requested | Already exists | Action |
|---|---|---|
| Forklift table with lifecycle | `customer_equipment` | reuse |
| Cross-customer prevention | `(id, customer_id)` composite key + FK pattern | replicate FK on quotes/service_requests |
| Serial uniqueness | partial unique index | reuse |
| Audit trail | `write_audit()` → `audit_log` | attach to new tables |
| Admin/customer RLS pattern | `is_admin()` + `auth.uid() = customer_id` | reuse verbatim |
| Active-customer gate | `customers.status = 'active'` checks in both service-plan functions | reuse in `equipment-customer` |
| Signed-agreement identity lock | app-level in `service-plans-admin` | promote to trigger (§D) |
| Net revenue per invoice | `recalc_invoice_status()` formula | generalise (§10) |
| Offline payment → ledger | `admin-action mark-paid` writes `provider='manual'` | already counts; do not re-enter |
| Cents-only money | every `_cents` column is `bigint` with checks | continue |
| Integer basis points | `feesaver_max_fee_bps` in `app_config` | same pattern for card adjustment |
| Private storage + signed URLs | `apex-uploads`, `apex-agreements`, `safeStorageUrl()` | new `apex-receipts` bucket, same pattern |
| Admin-only tables | `service_plan_events` (RLS admin, SELECT granted but policy denies) | same for finance |

---

## 3. PROPOSED DATA MODEL

### 3.1 `customer_equipment` — additive changes only

| Change | Justification |
|---|---|
| `nickname text` | The unit_number is the operator's asset tag; a nickname ("Dock 3 truck") is what customers actually say. Cheap, optional, distinct. |
| `power_type text check in ('electric','lp','diesel','gas','other')` nullable | Materially affects service scope and parts. Justified. |
| `capacity_lbs integer check (> 0)` nullable | Same — determines tyre, mast and part class. Justified. |
| `retired_at timestamptz` | Lifecycle already has `retired`; recording *when* costs nothing and matters for history. |

**Not added:** hour-meter, location coordinates, photos, purchase date. No
current consumer.

Serial stays nullable. **No placeholder serials** — enforce
`check (serial_number is null or trim(serial_number) <> '')` and reject
`N/A|UNKNOWN|NONE|TBD` (case-insensitive) with a check constraint, so a fake
serial cannot collide with a real one under the unique index.

### 3.2 Snapshot shape (shared by quotes, invoices, service_requests)

```json
{ "id": "…", "unit_number": "…", "nickname": "…", "year": "…", "make": "…",
  "model": "…", "serial_number": "…", "captured_at": "2026-…" }
```

Produced by one SQL function `equipment_snapshot(p_equipment_id uuid) returns
jsonb`, so every document freezes identity the same way. A label function
`equipment_label(jsonb) returns text` renders "2019 Toyota 8FGCU25 · #TRK-7 ·
SN 12345" for display, print and email.

### 3.3 `quotes` / `invoices` / `service_requests` — additive

Each gets:

```
equipment_id       uuid null
equipment_snapshot jsonb null
constraint fk_<t>_equipment_same_customer
  foreign key (equipment_id, customer_id)
  references customer_equipment (id, customer_id) on delete restrict
```

The composite FK is the cross-customer guarantee — identical to the pattern
offers already use. `equipment text` stays for history and as the display
fallback; new rows populate it from `equipment_label(snapshot)` so nothing
downstream (email templates, print, search) changes.

`invoices` gains no new user-entered field: `equipment_id` and snapshot are
**copied from the quote** by both creation paths (§8).

### 3.4 Finance tables (all admin-only)

**`business_expenses`** — as specified, plus `status in ('recorded','void')`
(no hard delete; void keeps the audit trail), `currency default 'USD'`, and
`check (subtotal_cents + sales_tax_cents = total_cents)`. `category` is a check
constraint on the listed enum. `receipt_path text` references the private
bucket object path, never a URL.

**`expense_allocations`**

```
id · expense_id → business_expenses ON DELETE CASCADE
amount_cents bigint > 0
customer_id uuid null · equipment_id uuid null
service_request_id · quote_id · invoice_id text null
subscription_id uuid null
job_id uuid null            -- column present, no FK, no consumer yet (§P)
note · created_at
constraint fk_alloc_equipment_same_customer (equipment_id, customer_id)
  references customer_equipment (id, customer_id)
```

**Total ≤ expense total** cannot be a check constraint (it spans rows). Enforce
with a **deferrable constraint trigger** on `expense_allocations` that sums
allocations for the expense `FOR UPDATE` on the parent row and raises if the sum
exceeds `business_expenses.total_cents`. Serialises per expense, so concurrent
inserts cannot race past the limit.

**`business_income`** — `id · income_date · source · category check in
('rebate','misc','interest','asset_sale','other') · description · amount_cents
> 0 · payment_method · receipt_path · notes · created_by · created_at ·
updated_at · status`. **Rule:** rows here must not correspond to an invoice —
enforced socially (form copy) and structurally by having no `invoice_id` column
at all. Offline invoice payments already go through `mark-paid` into `payments`.

### 3.5 Card-price policy (§K) — one `app_config` row

```
key   'recurring_card_price_adjustment_bps'
value integer bps, e.g. 350 = +3.50%     ← OWNER DECISION, not set here
```

Plus a SQL function `card_price_from_ach(p_ach_subtotal_cents bigint) returns
bigint`:

```
adjustment := (p_ach_subtotal_cents * bps + 5000) / 10000   -- half-up, integer
return p_ach_subtotal_cents + adjustment
```

Tax is then applied to the card subtotal by the existing offer tax logic. The
offer table's existing sum checks already prove `subtotal + tax = total`.

---

## 4. PROPOSED MIGRATIONS (forward only, after 0010)

| File | Contents | Reversible? |
|---|---|---|
| `0011_equipment_core.sql` | New columns on `customer_equipment`; serial-placeholder check; `retired_at`; `equipment_snapshot()`, `equipment_label()`; **identity-lock trigger**; **retire-guard trigger**; **customer_id immutability trigger** | Yes — drop triggers/functions/columns; no data destroyed |
| `0012_equipment_links.sql` | `equipment_id` + `equipment_snapshot` + composite FK on `quotes`, `invoices`, `service_requests`; indexes on `equipment_id`; replace `quote_to_invoice()` to copy equipment; **no backfill** | Yes — columns nullable, old rows untouched |
| `0013_pricing_policy.sql` | `app_config` key (inserted as NULL/absent until owner decides); `card_price_from_ach()` | Yes |
| `0014_finance_core.sql` | `business_expenses`, `expense_allocations` + allocation trigger, `business_income`; RLS admin-only; grants; audit triggers; `apex-receipts` private bucket + admin-only storage policies | Yes — drop tables |
| `0015_finance_views.sql` | `finance_settled_revenue(from,to)`, `finance_summary(from,to)`, `finance_by_equipment/invoice/subscription(from,to)` as `security definer` functions callable by admin only | Yes |

**Backfill decision:** none. Historical quotes/invoices/requests keep
`equipment_id NULL` and their free-text label. Attempting to match free text to
units would fabricate relationships. Admin can link a historical quote manually
from the UI later if wanted (an `update-equipment-link` action, not in Phase 1).

**Deployment order:** 0011 → 0012 → 0013 → 0014 → 0015, then Edge Functions,
then frontend. 0011 must land before any function that calls
`equipment_snapshot()`.

**Rollback constraint:** once 0012 is live and new quotes carry `equipment_id`,
rolling back to free-text only loses the *link*, not the label — `equipment
text` is still populated. Safe.

---

## 5. PROPOSED EDGE FUNCTIONS / RPCs

| Function | Status | Actions |
|---|---|---|
| **`equipment-customer`** (new, narrow) | create | `list`, `create`, `update`, `retire`. Identity from `auth.getUser()` → `customers` row → require `status='active'` → `customer_id` set **server-side from that row**. Body `customer_id` is ignored if present. Updates restricted to descriptive fields (`nickname, unit_number, service_location, notes, power_type, capacity_lbs`); identity fields (`serial, make, model, year`) editable **only while no signed agreement references the unit** — the DB trigger is the backstop, the function gives the friendly error. |
| `service-plans-admin` | extend | `create-equipment` / `update-equipment` already exist. Add `retire-equipment`. Existing offer flow unchanged; add optional `compute-card-price` (read-only preview via `card_price_from_ach`). |
| `admin-action` | extend | `create-quote` (currently frontend writes quotes? — verify; if so, move here) accepts `equipment_id`, calls `equipment_snapshot()`. `create-invoice` copies `equipment_id` + snapshot from the quote. |
| `quote_to_invoice()` RPC | replace in 0012 | Copies `equipment_id, equipment_snapshot, equipment` verbatim. |
| **`finance-admin`** (new, narrow) | create | `record-expense`, `void-expense`, `allocate`, `record-income`, `summary(from,to)`, `by-equipment`, `by-invoice`, `by-subscription`, `receipt-upload-url`, `receipt-view-url`. Admin JWT required (`is_admin()` via a `select` probe, same as `subscription-reconcile`). |
| `service-plans-customer` | **unchanged** | Already reads equipment correctly. |
| Payment / provider functions | **unchanged** | No new requirement touches them. |

**Why `finance-admin` is separate from `admin-action`:** `admin-action` handles
customer-facing money (invoices, mark-paid, refunds). Finance is internal
cost/profit data that must never leak toward a customer path. Separate function,
separate tables, separate RLS — a bug in one cannot expose the other.

---

## 6. CUSTOMER "MY FORKLIFTS" FLOW

```
Portal nav: My Forklifts (visible only when customers.status = 'active';
            pending customers see "Your account is awaiting approval")

List   → equipment-customer list → cards: label, status pill,
         plan status (from service_subscriptions via existing RLS read)
Add    → form: unit_number, nickname, year, make, model, serial (optional),
         power_type, capacity_lbs, service_location, notes
       → POST equipment-customer create → 201 → list refreshes, new unit selected
Edit   → same form; identity fields disabled with reason when a signed
         agreement exists (server returns lock state in list payload)
Retire → confirm → equipment-customer retire → 409 if live subscription (§D)
```

Request Service picks from the same list; "Add Forklift" is an inline sub-form
that returns to the request with the new unit selected. Snapshot taken
server-side at request insert.

Customer **never** sends `customer_id`. The function resolves it from the JWT.
The portal's existing `select('*')` on `customer_equipment` stays (RLS-scoped);
the new function is the only write path.

---

## 7. ADMIN CUSTOMER → FORKLIFT → QUOTE FLOW

```
Create Quote
  Select Customer (existing #q-customer-select)
    → fetch that customer's ACTIVE equipment (admin RLS, filter customer_id + status)
    → #q-equipment becomes a <select> of units + "[+ Add Forklift]"
  [+ Add Forklift] → inline form → service-plans-admin create-equipment
    (customer_id from the selected customer, server validates it exists)
    → new unit inserted into the select and selected
  Save Quote → equipment_id + customer_id → composite FK proves ownership
             → equipment_snapshot() freezes identity
             → equipment text = equipment_label(snapshot) for display
```

The free-text input is retired for new quotes. A quote with no unit (e.g. a
general site visit) is allowed — `equipment_id NULL` — but the UI should require
an explicit "No specific forklift" choice rather than defaulting to null.

---

## 8. QUOTE → INVOICE FLOW

Both creation paths copy three fields from the quote, unchanged:

```
invoices.equipment_id       := quotes.equipment_id
invoices.equipment_snapshot := quotes.equipment_snapshot   -- NOT re-snapshotted
invoices.equipment          := quotes.equipment
```

Re-snapshotting at invoice time would let an edit between quote and invoice
change what the invoice names. Copying the quote's snapshot guarantees the
invoice describes the machine the customer approved. Admin selects nothing.

`subscription-reconcile`'s recurring invoices copy `equipment_id` and snapshot
from the **agreement** (it already carries `equipment_id`), so plan invoices are
linked too.

---

## 9. SERVICE PLAN / CONTRACT FLOW

No architectural change. The admin service-plan UI already loads
`customer_equipment` for the selected customer; it consumes the same rows My
Forklifts manages. One forklift → one offer → one agreement → one subscription
stays enforced by `uq_offer_chain`.

Additions: the offer form gains a "Compute card price" button calling the
preview action; the server recomputes on save and rejects a card subtotal that
doesn't equal `card_price_from_ach(ach_subtotal)` unless admin sets an explicit
`card_price_override: true` (audited). Retiring a unit with a live subscription
is refused by the DB (§D).

---

## 10. FINANCE FORMULAS (all bigint cents, all from `payments`)

Let `P` = rows with `kind='payment' AND status='succeeded'`
Let `R` = rows with `kind IN ('refund','reversal') AND status='succeeded'`

```
gross_settled_payments   = Σ P.amount_cents          -- base, excludes fee_cents
refunds                  = Σ R.amount_cents
net_revenue              = gross_settled_payments − refunds
other_income             = Σ business_income.amount_cents  (status='recorded')
expenses                 = Σ business_expenses.total_cents (status='recorded')
operating_profit         = net_revenue + other_income − expenses
```

Date attribution: `coalesce(settled_at, completed_at, approved_at, created_at)`
for payments — settlement date, not initiation. Refunds by their own settlement
date, so a January payment refunded in March reduces March, matching cash
reality.

**Excluded by construction:** `initiated`, `pending` (unsettled ACH), `failed`,
`unknown`, `voided`. Invoice `status` and `amount` are never consulted.

**Convenience fees:** `fee_cents` is money the customer paid that Apex passed
through as a Fee Saver surcharge. It is reported as a separate line
(`convenience_fees_collected`), **not** folded into revenue, and **not** treated
as the processing cost. Whether the owner counts it as income is an owner
decision (§15).

**Naming:** the top line is **Operating Profit (recorded)**, defined on-screen as
"settled payments minus refunds, plus recorded other income, minus recorded
expenses. Not a tax figure." No card says "Taxes Owed".

---

## 11. EXPENSE / RECEIPT MODEL

Expense → optional allocations (§3.4) → optional receipt.

**Receipts:** new private bucket `apex-receipts`, `file_size_limit 10485760`,
`allowed_mime_types` = `image/jpeg, image/png, image/webp, image/heic,
application/pdf` (identical to `apex-uploads`). Storage policies: **admin
only** for select/insert/update/delete — no customer policy at all. Access via
`finance-admin receipt-view-url` returning a 600-second signed URL, validated by
the same `safeStorageUrl` pattern (bucket added to its allow-list). Object path
stored on the expense; never a URL.

---

## 12. CARD-PRICE AUTOMATION DESIGN

| Layer | Responsibility |
|---|---|
| `app_config.recurring_card_price_adjustment_bps` | The policy. Absent until the owner sets it; the preview action returns `policy_not_configured` and the offer form shows the card field as required manual input. |
| `card_price_from_ach()` (SQL) | Authoritative arithmetic. Integer half-up rounding. Never floats. |
| `service-plans-admin compute-card-price` | Preview for the form. |
| `service-plans-admin create-offer` / `update-offer` | Recomputes server-side; rejects mismatch unless `card_price_override` is explicitly set, in which case the override is written to `service_plan_events` with the computed value it replaced. |
| Browser | Displays the preview. Cannot make the value authoritative. |

**This is a customer price adjustment, not a cost.** The document and the UI
label it "Card price adjustment" — never "Fee Saver", never "processing fee".
Actual processing cost is §S and is unrelated.

---

## 13. SECURITY / RLS DESIGN

| Object | Owner | RLS | Grants | Customer sees | Admin sees | Write path | Audit |
|---|---|---|---|---|---|---|---|
| `customer_equipment` (+cols) | postgres | admin all; customer SELECT own | auth SELECT; service_role ALL | own rows | all | `equipment-customer`, `service-plans-admin` | existing trigger |
| `quotes/invoices/service_requests` new cols | — | unchanged | unchanged | own | all | existing functions | existing |
| `business_expenses` | postgres | `is_admin()` for ALL; **no customer policy** | service_role ALL; **authenticated: none** | nothing | all | `finance-admin` | new trigger |
| `expense_allocations` | postgres | same | same | nothing | all | `finance-admin` | new trigger |
| `business_income` | postgres | same | same | nothing | all | `finance-admin` | new trigger |
| `apex-receipts` bucket | — | admin-only storage policies | — | nothing | signed 600 s | `finance-admin` | — |
| `finance_*()` functions | postgres | `security definer`, first statement `if not is_admin() then raise` | EXECUTE to authenticated (guarded inside) | error | results | direct RPC | — |

**Database triggers (0011):**

1. `trg_equipment_customer_immutable` — `BEFORE UPDATE`, raise if
   `new.customer_id <> old.customer_id`. Ownership never moves.
2. `trg_equipment_identity_lock` — `BEFORE UPDATE`, if any of
   `serial_number, make, model, year` changes and
   `exists (select 1 from service_plan_agreements where equipment_id = old.id
   and status = 'signed')` → raise `equipment_under_signed_agreement`. Same
   error string the admin function uses today, so the frontend needs no change.
3. `trg_equipment_retire_guard` — `BEFORE UPDATE`, if `new.status = 'retired'`
   and `exists (… service_subscriptions where equipment_id = old.id and status
   in ('active','paused','past_due','setup_pending'))` → raise
   `equipment_has_live_subscription`. Retire the plan first.
4. `trg_equipment_no_delete` — `BEFORE DELETE`, always raise. The FKs already
   restrict deletes where references exist; this closes the gap for units with
   no references yet, so "delete" is never a path. Status is the lifecycle.
5. `trg_alloc_total_guard` — deferrable constraint trigger described in §3.4.

**Customer identity:** every customer write goes through `equipment-customer`,
which derives `customer_id` from `auth.getUser()`. There is no INSERT/UPDATE
grant for `authenticated` on the table, so PostgREST cannot be used to bypass the
function even with a forged body.

---

## 14. TEST PLAN

Database (against a fresh migrated DB, service_role + impersonated JWTs):

- active customer JWT → `equipment-customer create` → row has that customer's id regardless of body
- pending / inactive customer → 403 `account_not_active`
- body `customer_id` of another customer → ignored, row still owned by caller
- customer A SELECT → sees only A's rows (existing RLS, regression)
- direct PostgREST INSERT as `authenticated` → permission denied
- admin `create-equipment` for customer X → row owned by X
- duplicate serial same customer → unique violation; same serial different customer → allowed; `"UNKNOWN"` → check violation
- signed agreement present → UPDATE serial via service_role SQL → trigger raises (proves it's not just app code)
- retire with live subscription → raises; retire after cancel → succeeds, `retired_at` set
- DELETE → always raises
- quote with `(equipment_id of B, customer_id A)` → FK violation
- `quote_to_invoice()` → invoice `equipment_id`, snapshot, label all equal the quote's; editing the unit afterward changes neither
- existing offer→agreement→subscription integration suite (`PHASE_V247`) unchanged and green
- customer JWT SELECT on `business_expenses` → zero rows (RLS), and `finance_summary()` → raises
- finance formula fixture: succeeded $100, pending $50, failed $75, succeeded refund $30 → gross 10000, refunds 3000, net 7000
- offline `mark-paid` → appears in gross automatically; recording the same amount in `business_income` is not prevented by schema, so the test asserts the **UI never offers it** and the docs say so
- allocation sum > expense total → trigger raises; equal → allowed; concurrent two inserts each under the limit but over together → second raises
- every money column: attempt `1.5` → rejected (bigint); all functions use integer arithmetic (`card_price_from_ach(10000)` with 350 bps = 10350; 333 bps on 1 cent → 1, not 1.0333)
- card price: client sends mismatched card subtotal → 422 unless override flag; override flag → event row written

Frontend (jsdom, existing harness pattern): My Forklifts list/add/edit/retire wiring; quote form unit select + add-forklift inline; Finance section never renders in the customer bundle (assert `finance` strings absent from `portal-customer.js`).

---

## 15. OWNER DECISIONS REQUIRED

| # | Decision |
|---|---|
| 1 | **Card price adjustment bps** for recurring plans — the number, and whether it applies to subtotal (proposed) or to total |
| 2 | Whether Fee Saver convenience fees collected on one-time invoices count as **income** in reports, or are shown as a pass-through line only |
| 3 | Expense categories — accept the proposed list or amend |
| 4 | Whether `power_type` / `capacity_lbs` should be **required** for new units or optional (proposed: optional) |
| 5 | Can a *customer* retire a unit, or is retirement admin-only? (proposed: customer may retire when no live plan) |
| 6 | Name of the profit line: "Operating Profit (recorded)" proposed |
| 7 | Receipt retention — ties to `GROUP7_OWNER_POLICY_DECISIONS.md` D7 |

---

## 16. IMPLEMENTATION ORDER

1. 0011 — equipment core + triggers. Deploy. Existing UI keeps working (additive).
2. `equipment-customer` function + My Forklifts UI. Customer value first; no other subsystem depends on it.
3. 0012 — links + `quote_to_invoice()` replacement. Deploy. Old rows unaffected.
4. Admin quote form unit selector; `admin-action create-invoice` copy; `subscription-reconcile` link. Deploy together.
5. Service-request equipment selector (customer portal).
6. 0013 + card-price preview/validation in `service-plans-admin`. Blocked on owner decision #1 for the value, but the mechanism can ship with the key absent.
7. 0014 — finance tables, bucket, `finance-admin`. Admin-only; zero customer surface.
8. 0015 + Finance UI section.

Each step is independently deployable and testable. Steps 1–2 can ship before
anything else is approved.

---

## 17. RISKS / BACKWARD-COMPATIBILITY

- **`quote_to_invoice()` replacement** changes a live RPC. It is `service_role`
  only and additive in behaviour (copies three more columns); existing callers
  are unaffected. Still: deploy 0012 and the updated `admin-action` in the same
  window.
- **Identity-lock trigger vs the existing app check:** both return the same
  error string, so the frontend sees no change. Keep the app check — it gives a
  friendlier 409 before the DB raise.
- **`equipment text` remains** on all three tables and is still populated.
  Email templates, print windows and search continue to read it. No template
  change required in Phase 1.
- **Historical rows** have `equipment_id NULL`. Reports "by forklift" will show
  an "Unlinked" bucket for them. This is honest; do not backfill by guessing.
- **Finance is a new attack surface.** It has no customer path at all — no
  grant, no policy, separate function. The customer bundle must contain no
  finance code; a test asserts it.
- **Processing cost is unknown.** Any "merchant fees" card must be labelled
  *estimated* until a reconciliation import exists. Do not present an estimate
  as a fact.
- **Float money anywhere in the new code is a defect.** Every column is bigint;
  every function does integer math; the test plan checks rounding explicitly.
- **Nothing here touches payment, refund, activation, reconciliation or Helcim
  request shapes.** The provider boundary from v25 is preserved.
