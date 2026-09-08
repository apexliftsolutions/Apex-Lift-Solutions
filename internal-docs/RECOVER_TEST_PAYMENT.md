# Recovering the $0.11 test payment — without recharging

Your evidence: `payments.status = 'initiated'`, no transaction id, only a
`checkout_created` event. Helcim may or may not have taken the money.

**Do not pay that invoice again.** Find out first.

## Step 1 — did Helcim actually charge it?

Helcim dashboard → **Payments** → filter to the date/time of the test, look for
`$0.11`. Three outcomes:

- **No transaction** → nothing was charged. Nothing to recover. The next
  reconcile run will void the stale attempt and the invoice returns to unpaid.
- **APPROVED transaction** → money moved. Recover it, Step 2.
- **DECLINED transaction** → nothing to recover; the attempt correctly failed.

## Step 2 — recover an approved one

Copy the **Transaction ID** from Helcim, and the Apex `payments.id` from:

```sql
select id, invoice_id, status, amount_cents
from payments where invoice_id = 'INV-XXXXX' order by created_at desc;
```

Then, signed in as admin, from the browser console on the admin portal:

```js
const { data: { session } } = await _sb.auth.getSession();
const r = await fetch(`${SUPABASE_URL}/functions/v1/admin-action`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'reconcile-payment',
    paymentId: 'PASTE-APEX-PAYMENT-UUID',
    helcimTransactionId: 'PASTE-HELCIM-TRANSACTION-ID'
  })
});
console.log(await r.json());
```

The server does not take your word for it. It fetches the transaction from
Helcim and refuses unless: the transaction exists, is APPROVED, charged **at
least** the invoice amount, and any excess is small enough to be a convenience
fee. Otherwise it returns an explanation and changes nothing.

On success the payment becomes `succeeded`, `recalc_invoice_status` runs, the
invoice goes `paid`, and the normal payment emails queue exactly once.

## Why this cannot double-charge

It never calls a payment endpoint. It only **reads** a transaction and records
what Helcim already did.

## Going forward this is automatic

`payment-checkout` now sends `invoiceNumber`, so `payment-reconcile` can find a
lost transaction on its own via
`GET /v2/card-transactions?invoiceNumber=INV-XXXXX`. This manual path exists
because your test payment was made *before* that change.
