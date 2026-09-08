# Production Integration Audit
Performed against the repository **before** any change in this pass.
Nothing here is called safe because the UI hides it.

## CRITICAL

**C-1 · Browser could mark an invoice paid via URL parameter.**
`portal-customer.js` `boot()` read `?paid=INV-XXXX` and issued
`invoices.update({status:'paid', paid_at:now})`. Any signed-in customer could
type that URL. A redirect is not proof of payment.
→ Removed. No policy now permits a customer to write `invoices` at all.

**C-2 · Customers had unrestricted UPDATE on their own quote.**
`using (auth.uid() = customer_id)` is a *row* filter. Postgres RLS has no column
scope, so `PATCH /quotes?id=eq.Q-x {"status":"approved","amount":0.01}` succeeded.
→ Policy removed. `respond_to_quote()` RPC allows one transition, under a row
lock, only from `pending`, and rewrites nothing else.

**C-3 · Customers had unrestricted UPDATE on their own invoice.**
Same defect: `status`, `paid_at`, `amount`, `items` were all writable.
→ Policy removed. Customers are SELECT-only on `invoices`.

**C-4 · Registration could bypass admin approval.**
The insert policy validated *who* the row belonged to, not *what was in it*. A
signup could post `status:'active'`.
→ `force_pending_on_signup()` trigger overwrites `status` to `pending` for any
non-admin insert.

**C-5 · Customers had general UPDATE on their own profile row — including `status`.**
→ Policy removed. `update_my_profile()` touches exactly `name`, `company`, `phone`.

## HIGH

**H-1 · Customer repair photos in a public bucket.** `apex-uploads` was
`public: true` with a blanket read policy, and the portal minted permanent
`getPublicUrl()` links. Anyone with a URL could open a customer's warehouse
interior, serial plate, or damage photo without logging in.
→ Bucket is now private, 10 MB cap, MIME allow-list. Reads use 10-minute signed
URLs. Storage policies scope customers to `service-requests/<own uuid>/` and to
quote attachments on their own quotes.

**H-2 · Storage writes were unscoped.** `auth.role() = 'authenticated'` with no
path check, and the client used `upsert:true` — Customer A could overwrite a
file under `quotes/` or in B's folder.
→ Path-scoped insert/update policies.

**H-3 · ID space of 9,000 values as a primary key.** `floor(random()*9000+1000)`
→ ~50% collision odds by 112 rows (insert failures), and trivially enumerable.
→ `new_id()` with 10 hex chars from `gen_random_bytes(6)`.

**H-4 · Wildcard CORS on `admin-action`.** `Access-Control-Allow-Origin: '*'`
lets any site on the internet invoke it with a victim's session.
→ Locked to `PUBLIC_SITE_URL`.

**H-5 · Payment state had no ledger.** Truth lived in `invoice.status`, a single
mutable field. No attempt history, no idempotency, no refund representation.
→ `payments` ledger + `payment_events` history + derived invoice status.

## MEDIUM

**M-1 · EmailJS ran in the browser** in `portal-admin.js`, `portal-customer.js`
and `portal-login.js`, with hard-coded service/template/public IDs. Anyone could
read them from View Source and send mail through the Apex account. Delivery also
depended on the tab staying open — close the browser mid-payment and the receipt
never sends.
→ Removed entirely. Server-side outbox + Resend.

**M-2 · Business recipients hard-coded across frontend JS**
(`admin@…` and `apexliftsolutions1@gmail.com` repeated in several files).
→ `app_config` table, read server-side via `cfg()`.

**M-3 · No audit trail** on quotes, invoices, payments or customer status.
→ Append-only `audit_log` via triggers; no update/delete policy for anyone.

**M-4 · No email idempotency.** A duplicate webhook would have sent duplicate
receipts.
→ `notification_outbox.event_key` UNIQUE; `enqueue_notification` uses
`ON CONFLICT DO NOTHING`.

**M-5 · Public forms posted to Formspree** — a third party, no validation, no
rate limit, no honeypot enforcement server-side.
→ `public-contact` Edge Function: length caps, email format check, honeypot,
5/hour per hashed IP, stored in `contact_submissions`, emailed via the outbox.

## LOW

**L-1 · Stripe remnants.** A "processed securely via Stripe" label, a demo-mode
notice, and two commented lines. No SDK, no keys, no endpoints ever existed —
nothing to migrate, but `privacy.html` named Stripe as the processor, which was
untrue on a live site.
→ All removed; privacy names Helcim.

**L-2 · `.Rhistory` committed** (empty R console history, accidental).
→ Deleted, and `.gitignore` added.

**L-3 · Money handled as JS floats** in line-item math.
→ Ledger stores `bigint` cents; an immutability trigger guards `amount_cents`.

## INFORMATIONAL

- **Admin identity** is `auth.jwt()->>'email' = 'admin@…'`, now centralised in
  one `is_admin()` function that 21 policies call. Safe today: Supabase enforces
  email uniqueness and an email change requires confirmation at the new address,
  so no customer can claim it. A `role` claim in `app_metadata` would be more
  maintainable for multiple admins; not migrated because it risks locking out the
  live admin account for no security gain at one operator.
- **Supabase anon key** is in `portal-data.js` and that is correct — it is the
  publishable key. Its safety rests entirely on RLS, which is why C-1…C-5 mattered.
- **No CSV export exists** in the codebase, so spreadsheet formula injection is
  not currently reachable. If you add one, prefix any user string starting with
  `= + - @` with a single quote.
- **Password reset** uses Supabase's own OTP + `updateUser()`. Sound.
- **Every place invoice status could change, before:** browser `?paid=`; customer
  direct PATCH; admin `mark-paid`. **After:** `recalc_invoice_status()` only,
  called from `payment-validate`, `payment-events`, `payment-reconcile`,
  `payment-refund`, and `admin-action` (manual). All server-side.
