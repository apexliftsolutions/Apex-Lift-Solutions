# Deploy verification checklist

Run after every push to the `/docs` publishing root. Everything here is
read-only against production. Record results in the table at the bottom.

## 1. Exposure boundary — must be 404

```
https://apexliftsolutionsusa.com/supabase/migrations/0001_fresh_test_only.sql
https://apexliftsolutionsusa.com/supabase/functions/service-plans-admin/index.ts
https://apexliftsolutionsusa.com/tests/PHASE_G8_SECURITY_TESTS.mjs
https://apexliftsolutionsusa.com/internal-docs/GROUP7_OWNER_POLICY_DECISIONS.md
https://apexliftsolutionsusa.com/internal-docs/CSP_CANDIDATE.md
https://apexliftsolutionsusa.com/PAYMENT_DIAGNOSTIC.sql
https://apexliftsolutionsusa.com/SUPABASE_FRESH_TEST_ONLY.sql
https://apexliftsolutionsusa.com/package.json
https://apexliftsolutionsusa.com/.github/workflows/verify.yml
```

Any 200 here is a publishing-root regression — stop and check the Pages
setting before anything else.

## 2. Public pages — must be 200

All 11 sitemap URLs plus `/404.html` (which should itself return 404 status
with the branded page body). The five `portal-*.html` pages return 200 but
carry `noindex,nofollow,noarchive` — confirm in view-source.

## 3. Cache-busting

DevTools → Network, second load of `/portal-login.html`:
- `portal-login.js?v=2026-09-11.v25.2` — the parameter is present.
- Response headers show GitHub's default `Cache-Control`; note the `max-age`
  value in the table below. There is no `immutable` and there cannot be.

## 4. Structured data

`https://search.google.com/test/rich-results` against the homepage. Expect valid
**Organization** markup with **no** price range, **no** address, **no** hours and **no**
ratings — none of those are owner-confirmed. If any reappears, someone re-added
a claim the site does not make.

## 5. Social preview

Paste the homepage into a link-preview tool (Slack, LinkedIn post composer, or
`https://www.opengraph.xyz`). The image must render — `og:image` is absolute
and points at `/og-image.jpg` (36 KB). A blank preview means the URL went
relative again.

## 6. Robots and indexing

- `https://apexliftsolutionsusa.com/robots.txt` — no `Disallow` for portal
  pages; sitemap line present.
- `https://apexliftsolutionsusa.com/sitemap.xml` — 11 URLs, all `https://`,
  none ending in `portal-*`.
- Google Search Console → URL inspection on `/portal-login.html` → expect
  "Excluded by noindex", not "Blocked by robots.txt".

## 7. Consent

Fresh private window on the homepage → Network filter `google` → **zero
requests** before the banner is answered. Accept → one `gtag/js` request.
Reject → none, and no `_ga*` cookies in Application → Cookies.

## 8. Contact form (the P0 fix)

Submit the contact form with all four required fields. Expect the success
panel, not "Could not send". Check `contact_submissions` for the row.

## 9a. Migration 0011 preflight — READ ONLY, run BEFORE deploying 0011

0011 adds CHECK constraints on `customer_equipment.serial_number`. A fresh
database proves they work; production may hold an old blank or placeholder
serial that would make the migration **fail closed**. Run this in the Supabase
SQL editor. It changes nothing.

```sql
select id, customer_id, make, model, serial_number,
       case
         when serial_number is not null and length(trim(serial_number)) = 0 then 'BLANK'
         when upper(trim(serial_number)) in ('N/A','NA','UNKNOWN','NONE','TBD','NULL','-') then 'PLACEHOLDER'
       end as problem
from customer_equipment
where (serial_number is not null and length(trim(serial_number)) = 0)
   or upper(trim(serial_number)) in ('N/A','NA','UNKNOWN','NONE','TBD','NULL','-')
order by customer_id;
```

**Zero rows → deploy 0011.** Any rows → stop; review each with the customer or
set `serial_number = null` **manually and deliberately** per unit. Do not script
a blanket rewrite — a placeholder may be masking a real serial someone typed
elsewhere. The migration is designed to refuse rather than guess.

## 9. Payment session

Sign in, open an invoice, then sign out in another tab, return and press Pay.
Expect the "Your session has expired … Nothing was charged" state with a
**Sign in again** button — not a generic error.

## Record

| Check | Date | Result | Notes |
|---|---|---|---|
| 1 boundary | | | |
| 2 pages | | | |
| 3 cache max-age | | | value: |
| 4 rich results | | | |
| 5 og preview | | | |
| 6 indexing | | | |
| 7 consent | | | |
| 8 contact form | | | |
| 9 payment session | | | |
