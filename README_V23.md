# Apex Payment v23 — repay after provider reversal

## Bug fixed
A successful card payment remains in the append-only `payments` ledger after a provider reverse/void. v22 correctly returned the invoice to `unpaid` and showed the Pay button again, but `payment-checkout` still rejected every retry because it saw the historical `kind='payment', status='succeeded'` row and returned `already_paid`.

The browser also kept `PAY_BUSY=true` after the original SUCCESS. v22 cleared `LOCKED_INVOICES` after an authoritative reversal, but did not clear the second in-memory guard.

## v23 behavior
- `payment-checkout` no longer treats any historical succeeded payment row as permanently blocking.
- It computes net retained money from the append-only ledger:
  `succeeded payments - succeeded refunds - succeeded reversals`.
- A retry is allowed only when:
  - invoice status is `unpaid`,
  - net retained amount is exactly 0,
  - there is no live `pending`, `unknown`, or fresh `initiated` Helcim attempt.
- If an invoice says `unpaid` but Apex still retains money, checkout refuses with `payment_under_review` rather than risk a duplicate charge.
- Customer portal now clears both `LOCKED_INVOICES` and `PAY_BUSY` only after a succeeded provider `reversal` row proves the old payment is over.

## No SQL required
The v22 accounting SQL remains correct. This patch changes only:
- `portal-customer.js`
- `supabase/functions/payment-checkout/index.ts`

## Deploy
```bash
npx supabase functions deploy payment-checkout
```
Then deploy/push `portal-customer.js`.

## Acceptance test
Use the already-reversed test invoice. Do not create a new invoice just for this test.
1. Customer sees `UNPAID` + previous payment reversed.
2. Click Pay Securely.
3. Helcim modal must open.
4. Before actually submitting a second charge, this proves the retry blocker is gone.
5. If you want the final end-to-end test, submit exactly one small card payment and verify it becomes succeeded/paid immediately.
