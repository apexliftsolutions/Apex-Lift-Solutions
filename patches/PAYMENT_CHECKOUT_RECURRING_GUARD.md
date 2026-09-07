# PREPARED PATCH — recurring invoices must not be payable through Fee Saver checkout

**Status: NOT APPLIED.** `supabase/functions/payment-checkout/index.ts` is
unchanged in this ZIP. This file records the exact change, why it is deliberately
being held, and the order it must be applied in.

---

## Why it is held back

There is a deployment-ordering hazard that would take one-time checkout down.

`payment-checkout` reads the invoice with an **explicit column list**:

```ts
const { data: inv } = await sb.from("invoices")
  .select("id, amount, status, customer_id, tax_cents, subtotal_cents")
  .eq("id", invoice_id).eq("customer_id", user.id).maybeSingle();
```

The guard has to add `invoice_source` to that list. PostgREST resolves the
column list server-side, so if this function is deployed **before**
`SERVICE_PLANS_UPGRADE.sql` has run, every single one-time checkout returns a
PostgREST error and the customer cannot pay anything.

There is also no urgency. `invoice_source` defaults to `'one_time'` and the
first recurring invoice cannot exist until Phase F, which is gated behind
`recurring_billing_enabled`. Today the guard protects against nothing.

**Correct order:**

1. Run `SERVICE_PLANS_UPGRADE.sql` on production.
2. Verify `invoices.invoice_source` exists and every existing row reads `one_time`.
3. Only then deploy the patched `payment-checkout`.
4. Recurring invoices may only start being created after that.

## The change

Two edits to `supabase/functions/payment-checkout/index.ts`.

**1 — add the column to the select (line ~48):**

```diff
   const { data: inv } = await sb.from("invoices")
-    .select("id, amount, status, customer_id, tax_cents, subtotal_cents")
+    .select("id, amount, status, customer_id, tax_cents, subtotal_cents, invoice_source")
     .eq("id", invoice_id).eq("customer_id", user.id).maybeSingle();
   if (!inv) return j({ error: "not_found" }, 404, cors);
```

**2 — refuse immediately after the ownership check, before any ledger row or
Helcim call (insert directly below the `if (!inv)` line):**

```ts
  // ── Recurring invoices are NOT payable here ────────────────────────────────
  // A monthly service-plan cycle is charged by Helcim against the customer's
  // stored default payment method under a signed recurring authorization. This
  // endpoint opens a Fee Saver purchase session, which would be a SECOND,
  // separately-authorized charge for the same billing period.
  //
  // Recurring Payments are also incompatible with Fee Saver, so the amounts
  // would not even agree: the signed agreement authorizes an exact monthly
  // total, and Fee Saver would add a convenience fee on top of it.
  //
  // A future past-due self-service payment flow, if we build one, gets its own
  // endpoint with its own authorization — not this one.
  if (inv.invoice_source === "recurring") {
    await sb.from("activity_log").insert({
      actor_id: user.id, action: "payment_checkout_refused_recurring",
      detail: `${inv.id} is a recurring service-plan invoice`,
    });
    return j({ error: "recurring_invoice_not_payable_here" }, 409, cors);
  }
```

Bump `FN_VERSION` when this ships.

## Why this cannot affect existing one-time behaviour

- `invoice_source` is `NOT NULL DEFAULT 'one_time'`, so every pre-existing
  invoice — and every invoice the admin creates by hand — takes the `one_time`
  branch and is untouched.
- The check sits **after** ownership resolution and **before** the `payments`
  insert, so a refused call creates no ledger row, opens no Helcim session, and
  consumes no idempotency key.
- Nothing in the net-retained retry logic, the stale-session voiding, or the
  Fee Saver body construction is modified.

## Frontend companion (Phase C/E, also not applied)

`portal-customer.js` must not render a **Pay Securely** button on an invoice
whose `invoice_source` is `recurring`. The server guard above is the authority;
the frontend change only stops the customer being offered a button that will
fail. Recurring invoices still appear in invoice history and still print
receipts — they simply are not payable through the one-time modal.
