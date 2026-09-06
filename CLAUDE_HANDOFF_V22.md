# Apex Lift Solutions — Payment/Refund Handoff v22

## What was confirmed in production

- Helcim Admin API connectivity is working (`connection-test` and provider read green).
- One-time card flow uses Fee Saver: Apex invoice base amount stays separate from the processor fee.
- Current test payment on `INV-1A10E21B68` had original Helcim transaction `54434319`, amount base 141c, fee 4c, total charged 145c.
- The payment was later successfully reversed through Apex/Helcim. Correction transaction `54437389` was recorded as a reversal. The invoice correctly returned to `unpaid`.
- The remaining "confirming" display after that reversal was a frontend stale in-memory `LOCKED_INVOICES` issue, not a Helcim/provider issue.

## v22 changes in this patch

### portal-customer.js
- Client diagnostic version bumped to `2026-09-06.v22`.
- Loads authoritative successful refund/reversal ledger rows for visible invoices.
- Only a successful provider reversal may release a stale checkout lock on an `unpaid` invoice.
- A reversed payment now renders:
  - `Previous payment was voided / reversed`
  - amount
  - reason
  - provider reference
  - a new Pay Securely button because the invoice is legitimately unpaid again.
- Real refunds remain non-payable and display refund details.
- Payment History labels by BOTH `kind` and `status`.
- Refund/reversal reason is shown in Payment History.
- A correction row never gets a normal "Print Payment Receipt" button.
- Invoice lookup respects the confirming lock and authoritative reversal state.

### portal-admin.js
- Admin invoice action distinguishes a successful reversal from a stuck succeeded payment.
- After a full reversal, admin sees `Previous payment reversed` instead of `Confirming`.
- Full refund vs full reversal labels are distinct.
- Manual/offline payment safety now calculates NET retained Helcim money. A fully reversed payment no longer permanently blocks a legitimate new/offline payment.
- Refund/void reason is REQUIRED in the admin UI.

### payment-refund/index.ts
- Refund/void reason is REQUIRED server-side (max 500 chars).
- Reason is stored in `payments.notes`.
- Reason is added to `payment_events` and `activity_log`.
- Reason is returned to the admin UI.

### outbox-worker/index.ts
- Ordinary email events still use `_shared/email.ts` unchanged.
- Refund/void events are rendered with authoritative database data directly in the worker.
- Customer and admin emails include:
  - invoice
  - refund/void amount
  - reason
  - original payment amount/reference
  - refund/void provider reference
  - resulting invoice status
  - processed time
- Handles legacy rows where a reversal was previously queued under `payment_refunded` by inspecting `payments.kind`.

### APEX_REFUND_VOID_V22.sql
- Keeps a true `refund` distinct from a provider `reversal`.
- Full reversal of a still-valid invoice returns it to `unpaid` and clears paid linkage.
- Refunds derive `partially_refunded` / `refunded`.
- Notification payload now contains amount/reason/original payment id.
- Reversals queue `payment_voided` / `payment_voided_admin` rather than pretending to be refunds.

## Important accounting rules to preserve

- Never delete the original succeeded payment.
- Refund/reversal is a separate ledger row with `refund_of` pointing to the original.
- Frontend never marks financial state.
- Helcim provider success happens first; then Apex persists/recalculates.
- Card APPROVED is paid immediately; bank settlement later is not the card payment gate.
- ACH remains pending until clearing.
- Never double-charge. `unknown`/confirming/in-flight states suppress retry until authority resolves them.

## Deploy after SQL

```bash
npx supabase link --project-ref cjtezsgfdfijmdxzzbiq
npx supabase functions deploy payment-refund
npx supabase functions deploy outbox-worker --no-verify-jwt
```

Push/deploy:
- `portal-admin.js`
- `portal-customer.js`

No HTML changes are required for v22.

## Verify

1. Refresh customer portal after an authoritative reversal: no permanent Confirming state; invoice is unpaid with reversal notice and Pay button.
2. Admin invoice page: no false Confirming after full reversal.
3. New refund/void requires a reason.
4. Query `notification_outbox`: customer + admin correction events should be queued exactly once.
5. Outbox worker sends emails with amount + reason + references.
6. Do not make another card charge just to test UI/email plumbing.

## Recurring monthly service plans

Recurring implementation is still the next major phase after one-time/refund/void/ACH acceptance is stable. Preserve the previously approved model:
- one forklift = one offer = one immutable signed agreement = one subscription initially;
- tables: `customer_equipment`, `service_plan_offers`, `service_plan_agreements`, `service_subscriptions`;
- recurring charges reuse `payments` with `payment_source='recurring'`, `subscription_id`, billing period fields;
- no Fee Saver on recurring; explicit ACH and card monthly prices;
- customer reviews/signs/chooses method/verifies payment method before activation;
- optional 24-hour precharge reminder default ON; transactional notices cannot be disabled;
- Helcim owns provider schedule/payment method; Apex owns equipment/contract/tax/invoice/ledger/email/reconciliation.
