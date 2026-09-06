# Resolving the $1.19 invoice (INV-C33C21BF8…)

That invoice currently holds **two** payment rows:

| provider | status | amount | note |
|---|---|---|---|
| helcim | `unknown` | 119 | the real attempt; parsing failed |
| manual | `succeeded` | 119 | entered at 20:28 to compensate |

The invoice is paid once, which is correct. The problem is only that the
Helcim attempt is still open and carries no transaction id.

## Step 1 — did Helcim actually charge?

Helcim dashboard → Payments → 2026-09-05 around **20:24 UTC**, amount **$1.19**.

## Step 2 — resolve it either way

Admin portal → **Review** on that invoice, or from the admin console:

```js
const { data: { session } } = await _sb.auth.getSession();
const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-action`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'resolve-orphan-attempt',
    paymentId: '3a1e9f10-c3cf-491d-a3ef-c3281db7f78e',   // the helcim row
    helcimTransactionId: 'PASTE-IF-HELCIM-CHARGED'        // omit if it did not
  })
});
console.log(await r.json());
```

## Why the manual row is kept rather than replaced

Two constraints make replacement the wrong move:

1. `guard_payment()` raises *"a succeeded payment cannot be reopened"*. The
   manual row cannot be voided by an UPDATE, by design.
2. Netting it out with a `reversal` row would give
   `paid_c = 238, refund_c = 119`, and `recalc_invoice_status` would land on
   **`partially_refunded`** — visibly wrong on a fully paid invoice.

So the manual row stays as the single settled payment, and the Helcim attempt is
closed as `voided` with the real transaction id recorded in `payment_events`.
Money counted once, nothing deleted, the Helcim reference preserved.

## No duplicate email

`unknown → voided` is not a transition into `succeeded`, so `notify_on_payment`
returns without enqueuing. The receipt the manual payment already produced stays
the only one.

## Do not reuse this invoice

It now has two payment rows and a resolved history. Create a **fresh** invoice
for the next real test.
