# PHASE B + C REPORT

Nothing deployed. No production SQL run. `recurring_billing_enabled` is still
`false`, `service_plan_contract_mode` is still `test`.

Phase A schema was **not modified**. The one new migration,
`0007_service_plan_notifications.sql`, only adds two trigger functions and two
triggers — the notification plumbing Phase A deliberately deferred until the
outbox worker had matching templates.

---

# 1. The recurring-invoice guard (done first, as instructed)

`supabase/functions/payment-checkout/index.ts` → `FN_VERSION = "2026-09-07.v24"`

Two lines changed, 28 added. Nothing else in the file moved:

```
- const FN_VERSION = "2026-09-06.v23";
- .select("id, amount, status, customer_id, tax_cents, subtotal_cents")
+ const FN_VERSION = "2026-09-07.v24";
+ .select("id, amount, status, customer_id, tax_cents, subtotal_cents, invoice_source")
+ [refusal block]
```

The refusal sits immediately after the ownership lookup and **before** the
ledger insert and before Helcim is contacted, so a refused call writes no
payment row, opens no checkout session, and burns no idempotency key:

```ts
if (inv.invoice_source === "recurring") {
  await sb.from("activity_log").insert({ ... });
  return j({ error: "recurring_invoice_not_payable_here", fn_version: FN_VERSION }, 409, cors);
}
```

`invoice_source` is `NOT NULL DEFAULT 'one_time'`, so every existing invoice and
every admin-created invoice takes the untouched V23 path. The retry logic,
net-retained calculation, stale-session voiding and Fee Saver body are byte
identical.

There is also a browser-side guard at the top of `openPay()` in
`portal-customer.js`, so a customer is never offered a button that will fail.
The server guard is the authority; this only avoids a dead end.

---

# 2. Changed files

| File | Change |
|---|---|
| `supabase/functions/payment-checkout/index.ts` | +28 lines. Recurring guard, version bump. |
| `supabase/functions/service-plans-admin/index.ts` | **new.** All admin writes. |
| `supabase/functions/service-plans-customer/index.ts` | **new.** Preview, sign, PDF, signed URL, decline. |
| `supabase/functions/_shared/email.ts` | +124 lines. Three new templates + a cents formatter. No existing template touched. |
| `supabase/migrations/0007_service_plan_notifications.sql` | **new.** Two notification triggers. |
| `portal-admin.html` / `portal-admin.js` | +109 / +307. Service Plans section. |
| `portal-customer.html` / `portal-customer.js` | +45 / +333. Service Plans + agreement signing. |
| `tests/PHASE_BC_TESTS.sql` | **new.** 28 database assertions. |
| `tests/PHASE_C_PDF_TESTS.mjs` | **new.** 22 PDF/contract assertions. |

**Unchanged, verified byte-identical:** `payment-validate`, `payment-refund`,
`payment-events`, `payment-reconcile`, `outbox-worker`, `admin-action`,
`_shared/helcim-api.ts`, `_shared/helcimpay.ts`, `_shared/feesaver.ts`,
`portal-data.js`, `main.js`, migrations `0001`–`0004`, `APEX_REFUND_VOID_V22.sql`.

New CSS is scoped `sp-*` (admin) and `cp-*` (customer). New JS is appended in
one block per file; no existing function was edited except the `openPay()` guard
and three one-line `showView()` hooks.

---

# 3. Phase B — Admin

Nav item **Service Plans** → pick a customer → their equipment, offers,
agreements and subscription state on one screen.

- **Add / edit forklift** — unit, year, make, model, serial, service location, notes.
  Serial, make, model and year become read-only once the unit is named in a
  signed agreement, because the contract identifies that machine.
  `customer_id` is never editable at all.
- **Create offer** — plan name, description, included services, exclusions, ACH
  monthly price, card monthly price, term, activation date, expiry.
- **Send offer**, cancel offer, and the full status list (draft / sent /
  accepted / declined / expired / cancelled).

**The admin never types tax.** They enter the two pre-tax subtotals; the Edge
Function reads `tax_rate_milli_pct`, `tax_exempt`, `tax_jurisdiction` and
`exempt_cert_number` off the customer record, computes both rails, and snapshots
the rate onto the offer so a later rate change cannot alter a price a customer
was already shown. The browser's live preview is advisory only — the server
recomputes and the database re-checks `subtotal + tax = total` on both rails.

**No browser writes.** Reads go direct through PostgREST under the admin RLS
policy; every write goes through `service-plans-admin`, which re-verifies the
caller is the admin. This is not a convention — Phase A revoked
INSERT/UPDATE/DELETE from `authenticated`, and the admin is `authenticated`, so
a direct write is refused by Postgres.

`customer_id` for an offer is read from the **equipment row**, never from the
request. Taking it from the browser is exactly the cross-customer mistake the
composite FK exists to stop.

---

# 4. Phase C — Customer

Nav item **Service Plans** → open offers and signed agreements. Drafts are
invisible (RLS), other customers' rows are invisible (RLS).

Each offer shows the unit, make/model, serial, service location, included
services, exclusions, term, activation date, and **both rails priced in full**
with the ACH saving called out.

Flow: choose rail → server builds the contract → review → four consent
checkboxes → type name → sign.

**The browser never supplies contract content.** It sends `offer_id`, rail,
signer name, signer title, typed signature and four booleans. That is the
complete list. Prices, customer, equipment, term, activation date and every word
of the contract are read from the database in `service-plans-customer`, and the
money is read *again* inside `accept_offer_and_sign_agreement`, which is where
the authoritative amount actually comes from.

After signing: PDF rendered server-side, SHA-256 over the PDF bytes and over the
canonicalized snapshot, stored at
`agreements/<customer_id>/<agreement_id>.pdf` in the private bucket, written
into the write-once columns. Customers reach it only through
`agreement-url`, which mints a 5-minute signed URL after checking ownership
(admin also allowed). No durable link exists anywhere, including in email.

**Recovery.** If signing succeeds but the PDF upload fails, retrying does not
re-sign — the offer is already accepted and the database would refuse. The
function detects the existing agreement and finishes the PDF instead.

**Nothing is charged and no card or bank details are collected.** Both the UI
and both emails say so explicitly.

---

# 5. Notifications

`0007` adds two triggers. Enqueue happens in the **same transaction** as the
business write, so a sent offer always has its email queued and a rolled-back
signature never leaves one behind. Exactly-once comes from the unique
`event_key` plus `on conflict do nothing`.

| Event | To | Contains |
|---|---|---|
| `service_plan_offer_sent` | customer | both rails side by side, unit, serial, included/excluded, term, activation, expiry |
| `service_plan_agreement_signed` | customer | signed terms + an explicit "nothing has been charged" |
| `service_plan_agreement_signed_admin` | admin | full detail + "next step: payment method verification" |

The signed-agreement emails deliberately carry **no PDF path and no bucket
link** — there is a test asserting this. They say "sign in".

---

# 6. Tests

## Database — 28 assertions, 0 failures

Full chain `0001 → 0007` applied to a fresh PostgreSQL 16, then:

- **Offer emails (5/5)** — a draft queues nothing; draft→sent queues exactly
  one, addressed to the owning customer, carrying both rail totals; touching the
  offer again does not duplicate it.
- **Signing (9/9)** — choosing card is signed at the **card** price; the
  database's own numbers are stamped into the snapshot alongside the rendered
  body; the offer is accepted atomically; exactly two emails queue; the email
  leaks no PDF path; the same offer cannot be signed twice; a customer cannot
  sign another's offer; a missing contract body is refused.
- **PDF artefacts (4/4)** — path and both hashes write once, then frozen.
- **Checkout guard (3/3)** — the recurring invoice reports `recurring`, the V23
  invoice still reports `one_time`, and a recurring invoice cannot be relabelled
  to bypass the guard.
- **Gate (4/4)** — recurring still off, mode still `test`, no payment method
  verified, no recurring money row exists.
- **RLS (4/4 + 3 refusals)** — no drafts visible, own rows visible, other
  customers invisible, and all three browser write attempts returned
  `permission denied for table`.
- **V23 intact** — `INV-1A10E21B68` still `unpaid` / `one_time`, net retained
  still exactly 0 cents, both original payments untouched.

## PDF / contract — 22 assertions, 0 failures

The real `buildAgreement` and `renderPdf` executed under Node against pdf-lib.

Pricing correctness, DRAFT banner present in `test` and absent in `live`, the
price section stating both the selected total and the alternative rail, four
sections flagged for legal review, valid multi-page US-Letter PDF output,
over-wide words hard-split rather than looping, and `canonical()` proven
key-order independent so the snapshot hash is reproducible.

### A real bug this caught

The first version drew the signature, signer name, company and agreement version
with `page.drawText()` **directly**, bypassing the WinAnsi sanitizer. pdf-lib's
standard fonts throw on any character outside WinAnsi — and phone keyboards
autocorrect a plain apostrophe to U+2019. A customer named **O'Brien signing on
an iPhone would have crashed PDF generation at the moment of signature.**

Fixed: every string now goes through a `put()` helper that sanitizes, plus a
`fit()` helper that truncates to the column so a long company name cannot run
off the page. There is now a regression test named for the case
(`P22 a signer named O'Brien (curly apostrophe) does not crash signing`).

`SAMPLE_AGREEMENT.pdf` is a real render from this code path.

## Syntax

All 14 Edge Functions parse clean (esbuild, TS). All 4 frontend files parse
clean (`node --check`).

---

# 7. Before this goes in front of a customer

1. **Read `SAMPLE_AGREEMENT.pdf`.** The business terms are right; the wording is
   a neutral draft. Sections 6–10 are flagged in the document itself. Until
   `service_plan_contract_mode` is set to `live`, every page is stamped
   **DRAFT — PENDING LEGAL REVIEW** and the portal shows a matching banner.
   Do not flip that flag before an attorney has read it.
2. **Set `SIGNATURE_IP_SALT`** in Edge Function secrets before deploying
   `service-plans-customer`. Signing now fails closed with `server_config_error`
   if the secret is absent; there is no constant fallback.
3. **Redeploy `outbox-worker`** even though its `index.ts` did not change. The
   deployed bundle imports `_shared/email.ts`, and the new Service Plan templates
   will not be present in production until that function is rebuilt/redeployed.
4. **Deploy order:** `0007` first, then `outbox-worker`, `payment-checkout`,
   `service-plans-admin`, `service-plans-customer`. `payment-checkout` reads
   `invoice_source`, which already exists in production, so it is safe now.
5. **First run-through on staging**, or on a real customer record with a $1
   plan, before anyone sees this.

# 8. Open question

The offer email and the agreement email both go out through the existing outbox
worker, which I did not modify — it dispatches on `event_type` and my templates
slot into the existing `render()` switch. Worth confirming the worker's retry
and dead-letter behaviour treats these the same as invoice emails, since I had
no way to exercise Resend from here.
