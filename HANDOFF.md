# APEX LIFT SOLUTIONS — HANDOFF

Written 2026-09-09; updated 2026-09-10 for **v25.1 — Equipment Phase 1**. Everything in this
file was re-verified from the repository files, not from the session's own
summaries. Where something could not be verified from files, it says so.

**Nothing in this session was deployed.** The repository is ahead of production.

---

## 1. Read this first

| Fact | State |
|---|---|
| Canonical frontend | `docs/` — the GitHub Pages publishing root |
| Repository root | Migrations, runbooks, reports only. **No frontend files.** |
| Backend | v25.1 adds `migrations/0011_equipment_core.sql`, the new `functions/equipment-customer/`, and changes to `functions/service-plans-admin/`. `functions/public-contact/` carries the earlier P0 fix. **No payment, subscription or provider function has changed.** |
| Tests | `npm run test:all` — 23/23 static and application suites, plus parse and release-version checks. `npm run test:sql` — real-PostgreSQL suite that applies every migration to a throwaway database and asserts the equipment invariants (needs `APEX_PG_PSQL`; exits 3 rather than passing if no database is configured). |
| Release string | `package.json` → version **25.2.0**, `apexRelease` = **`2026-09-11.v25.2`**, `package-lock.json` committed and version-checked |
| CSP | **Not enforced.** Candidate in `internal-docs/CSP_CANDIDATE.md` |
| Recurring billing | Live in production since before this session; untouched |

If you change any frontend file, change it in `docs/`. There is no other copy.

---

## 1b. v25.2 — Equipment Phase 2: forklift → quote → invoice (awaiting deployment)

`0012_equipment_links.sql` gives quotes and invoices `equipment_id` and a frozen
`equipment_snapshot`, both guarded by the composite `(equipment_id, customer_id)`
FK so a document can never name another customer's machine. The admin quote form
now picks from that customer's **active** forklifts; the browser sends only an id
and the server generates the snapshot (`admin-action link-quote-equipment` →
`link_quote_equipment()`). **Both** quote→invoice paths copy the snapshot
verbatim — the invoice names the machine the customer approved, not the live
record. Recurring invoices get the same linkage, with no payment or provider
change. Historical rows stay unlinked; nothing is matched by guessing.

**Quote creation is atomic.** The browser sends `equipment_id` only; a BEFORE
INSERT trigger on `quotes` verifies ownership and active status and generates the
snapshot and label in the same statement, so the AFTER INSERT notification
already carries the right equipment. A rejected unit aborts the INSERT — no
quote row, no outbox row. `link_quote_equipment()` and `quote_to_invoice()` are
**service_role only with no in-function JWT check**: a service-role call carries
no user email, so an `is_admin()` gate there would reject its only caller.
`admin-action` authenticates the human admin before using the service-role
client, and delegates conversion entirely to `quote_to_invoice()` — the one
authoritative implementation, with `FOR UPDATE` serialising double conversion.
The browser's direct-insert invoice fallback is removed; conversion fails closed.

Proven on real PostgreSQL: Phase 1 72/0, Phase 2 54/0.

## 1a. v25.1 — Equipment Phase 1 (implemented, awaiting owner deployment)

`customer_equipment` is now the canonical forklift record. Migration
`0011_equipment_core.sql` adds nickname / power type / capacity / retired_at and
five database-enforced rules: ownership immutable, **identity locked once any
agreement has ever named the unit** (cancelled or superseded included), retire
refused while a plan is live, no hard delete, retired is terminal. A new narrow
function `equipment-customer` is the only customer write path; identity comes
from the session and a body `customer_id` is rejected. Customers get a **My
Forklifts** section. Admin reuses `service-plans-admin` create/update-equipment.

Proven against a real Postgres: 56/0 (`npm run test:sql`). **Nothing deployed** —
0011, `equipment-customer` and the updated `service-plans-admin` await your
Supabase deploy, and `docs/` awaits your push. Run the 0011 preflight in
`internal-docs/DEPLOY_VERIFICATION_CHECKLIST.md` first.

## 2. What is NOT live yet — deploy these

The repository contains fixes that production does not have. In order:

0. **v25.2 order:** `0012` → `admin-action` → `subscription-reconcile` → push `docs/`.
   `0012` replaces `quote_to_invoice()`; deploy it and `admin-action` together.

1. **`supabase functions deploy public-contact`** — the contact form on
   `contact.html` was **100% broken** in production: it posted `Phone Number`
   and no ZIP, the server required `phone` and `zip`, every submission returned
   `missing_fields`. Both sides are fixed in the repo. **Until this function is
   redeployed, every contact-form enquiry is still being lost.**
2. **Push `docs/`** — carries the frontend half of that fix plus everything
   else in section 4.
3. Run `internal-docs/DEPLOY_VERIFICATION_CHECKLIST.md` — nine read-only checks,
   step 8 confirms the contact form works end to end.

`outbox-worker` must also be redeployed at some point: it inlines
`_shared/email.ts` at deploy time and that file gained templates in Group 4.
A stale bundle sends customers a raw JSON dump. See `DEPLOY_V24_5_RECURRING_COMPLETE.md` (the outbox-worker section).

---

## 3. Architecture boundaries — do not cross without reason

- **Money never moves from the browser.** Every payment, refund, activation and
  provider action goes through an Edge Function that re-reads the truth
  server-side. The frontend caches (`INVOICE_CACHE`) are render aids only.
- **Provider actions are read-verified.** Pause / resume / cancel / term change
  PATCH Helcim, read the subscription back, and persist to Apex **only if the
  provider agrees**. A failed call returns `apex_unchanged: true`. Never call
  `DELETE /v2/subscriptions` — Helcim documents it as permanent removal.
- **Retries are idempotent by database constraint.** `subscription_retry_attempts`
  allows one in-flight attempt per (subscription, cycle). The key is reused on
  ambiguity, never re-minted.
- **The ledger is append-only.** Refunds and reversals are new rows linked to
  the original; the original is never edited.
- **`docs/` must contain only what is intentionally public.** No `.sql`, `.md`,
  `.ts`, tests, or build output. `PHASE_TEST_SOURCE_GUARD` enforces it.
- **No inline event handlers, no inline scripts, no `eval`.** Every interaction
  routes through a delegated listener and a fixed `switch` on `data-action`.
  Data attributes carry ids, enums and numbers — never customer text, never
  JavaScript source.

---

## 4. What this session changed, by area

**Security**
- Stored XSS: customer names were HTML-escaped into `onclick` attributes, where
  the parser decodes them before the JS compiles. Removed by taking customer
  text out of executable context entirely.
- 21 unescaped fields in the admin print windows.
- Signed storage URLs validated (`safeStorageUrl`) before use as `href`/`src`.
- Referrer policy on every page. Auth-provider wording corrected.

**Data loss**
- Contact form field contract (above).
- Service requests reported success after a failed insert and cleared the form.
  Now throws first; partial attachment failures are named.

**Accessibility**
- Every form control has an accessible name (79 fixed, visible labels bound via
  `for`/`id`, not overwritten with `aria-label`).
- Modals: dialog semantics, focus trap, Escape (blocked while `data-busy`),
  focus return.
- Brand red split by text size: `--red #cc0000` for large text/fills/borders,
  `--red-text #ff2b2b` for small text, `--red-dark` for hover fills only. All
  measured; the retired `#cc6464` read as salmon.

**Privacy / legal**
- GA4 is opt-in only; nothing loads before consent. Portals never load it.
- Five policy pages, all draft, all with visible owner-decision markers moved
  into source comments. 31 open decisions in
  `internal-docs/GROUP7_OWNER_POLICY_DECISIONS.md`.
- NY GBL §527-a and GOB §5-903 issue-spotted from the official statute text.
  **Not legal advice.**

**Dependencies**
- Supabase JS 2.116.0 vendored and pinned (`docs/vendor/`), no CDN.
- Fonts self-hosted from the official OFL source, seven files, no Google Fonts.

**Delivery**
- Every first-party JS/CSS reference versioned; fonts/images bare by decision
  (`internal-docs/CACHE_STRATEGY.md`). GitHub Pages cannot set headers.
- JSON-LD stripped of a price range and a locality the site never states.

---

## 5. Open items — owner decisions, in priority order

1. **Deploy** section 2. Every day it waits, contact enquiries are lost.
2. **Helcim browser capture** — `internal-docs/GROUP8_BROWSER_VERIFICATION.md`.
   Needed to finish the CSP. Also isolates the reCAPTCHA source, which is
   **observed at runtime but not yet attributed** (Helcim is the likely owner).
3. **F1 in the decisions register** — what happens when a fixed-term plan is
   cancelled early. The code is silent; the policy is deliberately silent; a
   customer will eventually ask.
4. **Retention periods** — none exist in code; the policy says "as long as
   reasonably necessary" and nothing more.
5. **Business identity** — legal entity name, whether to publish an address,
   hours. The site states 7am–6pm; that is unconfirmed.
6. **Warranty and liability** — the Terms contain nothing. Counsel first.
7. **Service Requests 2.0** — uploads precede the insert, so a failed insert can
   orphan storage objects. `internal-docs/SERVICE_REQUESTS_2_FOLLOWUP.md`.
   **Do not fix by widening Storage delete policy.**

---

## 6. What cannot be verified from files

Be honest with the next person about these:

- That GitHub Pages actually publishes from `/docs` (owner-stated).
- That internal URLs return 404 on the live domain.
- The reCAPTCHA request origin.
- Helcim frame and XHR origins.
- GitHub's real `max-age`.
- Rendered focus rings, font metric parity, LCP/CLS, Lighthouse.
- Whether the live PostgREST accepts the keyset cursor filter
  (`POSTGREST_CURSOR_RUNTIME_CHECK.md` — a paste-in browser check).
- **Whether deployed Edge Functions match these files.**

---

## 7. Test discipline — lessons paid for

The session produced roughly 2,000 assertions. It also produced, repeatedly,
tests that passed while the code was wrong. The patterns, so you don't repeat
them:

- **A regex that matches your own comment.** `eval` in a comment about not
  using eval. `onclick` in a comment about removing onclick. Strip comments
  before asserting on code.
- **Enumerating a list instead of matching a pattern.** Eight hardcoded event
  names missed `onmouseover`. A hardcoded list of "large text" selectors missed
  25 small-text uses of the brand red.
- **Testing the unit, not the wiring.** `loadPage()` passed in isolation while
  every Load More click fetched two pages.
- **Stubbing every global.** Hid a handler calling a function that was never
  defined.
- **Encoding a temporary state.** An assertion that constrained interpolations
  "remain" failed the moment the migration finished.
- **`node --check` is not execution.** It passed `varoriginalLabel` (strict-mode
  ReferenceError) and a duplicate top-level `const`. `PHASE_G61_EXECUTION_TESTS`
  exists because of this.

**The discipline that caught most of it:** after every fix, reintroduce the bug
and confirm the test fails by name. Every suite here was proven that way at
least once.

---

## 8. Where things live

```
docs/                          public site — the ONLY frontend
  vendor/supabase-js-2.116.0.umd.js
  assets/fonts/*.woff2
supabase/functions/            15 Edge Functions
supabase/migrations/           0001–0010, all applied in production
tests/                         22 suites; run with `npm run test:all`
tools/run-tests.mjs            unified runner; non-zero exit on any failure
tools/check-version.mjs        release-string consistency
internal-docs/                 owner decisions, CSP candidate, checklists, follow-ups
*.sql / *.md at root           runbooks, diagnostics, historical reports
```

Historical `PHASE_*` and `*_REPORT.md` files at root describe past states.
Where they conflict with this file, this file is current.
