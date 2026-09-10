# Admin dashboard KPI — follow-up

## What the card shows now

**"Invoiced & Paid"** — the summed face value of invoices whose status is `paid`,
with the qualifier *"gross · refunds not deducted"*.

## Why it was relabelled rather than recomputed

It read **"Revenue Collected"**, which is a net claim. The figure never consulted
the payments ledger, so a refunded or reversed payment still counted in full. On
a $500 invoice refunded to $0 the card kept showing $500.

Relabelling was chosen over silently changing the number: an owner who has been
reading that card for months should not find it quietly means something new.
The number is unchanged and now says what it is.

## If a true net figure is wanted

Derive it from the ledger, not from invoices:

```
net retained = Σ(payments where kind='payment' and status='succeeded')
             − Σ(payments where kind in ('refund','reversal') and status='succeeded')
```

That is the same definition the customer portal already uses per invoice, and
the same one `payment-refund` enforces when capping a refund — so there would be
one definition of net across the system rather than two.

**Owner decision:** keep the gross card, replace it with net, or show both. Note
that net and gross legitimately differ, and a dashboard showing only net will
raise questions about missing money that gross answers, and vice versa.
