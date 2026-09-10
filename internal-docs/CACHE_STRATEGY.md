# Cache and asset delivery strategy

## The platform constraint that shapes everything

**GitHub Pages does not allow custom response headers.** No `Cache-Control`,
no `ETag` policy, no `Vary`, no `immutable`. Every asset is served with the
platform default — documented by GitHub as a short `max-age` (approximately
ten minutes). That default cannot be changed from this repository.

Consequently the cache strategy is not a header strategy. It is a **URL
strategy**: change the URL when the bytes change, and let the short platform
TTL handle everything else.

This is the same class of limitation as the CSP and clickjacking headers
recorded in `CSP_CANDIDATE.md`. A host that supports custom headers (Cloudflare
Pages, Netlify, a CDN in front) would allow long-lived immutable caching of
versioned assets; that is a hosting decision, not a code change.

## Two tiers, one rule each

### Tier 1 — code assets: always versioned

Every first-party `.js` and `.css` reference carries `?v=<apexRelease>`, the
literal string held in `package.json` and enforced by `npm run verify:version`.

**Why it matters:** `portal-login.js` and `portal-forgot.js` had no version
parameter at all. After the inline-handler migration, a returning visitor whose
browser had cached the pre-migration file got JavaScript that no longer matched
the page — buttons wired to functions that were never attached. The stale
`v24.5` cache-buster on the admin bundle in Group 1 was the same failure. A
version string is what makes a deploy *visible* to browsers that already have
the old file.

The vendored Supabase artefact is versioned in its **filename**
(`supabase-js-2.116.0.umd.js`) as well as by parameter, since its bytes are
tied to the pinned release.

### Tier 2 — content-stable assets: bare by decision

Fonts (`assets/fonts/*.woff2`), the logo, favicons and the Open Graph image are
referenced without a version parameter. This is deliberate, not an omission:

- They change rarely, and when they do the change is usually a *replacement*
  with a new name (a rebrand, a new logo file), not a same-name edit.
- The platform TTL is short anyway, so a same-name edit propagates within
  minutes, not months.
- Font URLs live in `@font-face` inside `style.css`, which *is* versioned, so a
  font swap that requires a CSS change already busts the CSS.

If a same-name font or image edit ever must propagate instantly, add the
version parameter to that reference in the same commit. Do not pre-emptively
version them: it adds churn to every release for assets that do not change.

## What was cleaned up

`og-image.png` (181,820 bytes) was still in `docs/` but referenced by nothing —
every `og:image` and `twitter:image` tag points at `og-image.jpg`. Removed. It
was being served to no one and would only ever have been fetched by a crawler
with a stale link.

## Runtime verification (browser)

Cannot be proven from static analysis. In DevTools → Network, on a **second**
load of any page:

1. Versioned JS/CSS: served from cache (or 304), with the request URL carrying
   the current `?v=`.
2. After a deploy that changes the release string: the same assets show a fresh
   200 with the new URL, no hard refresh needed.
3. Response headers on any asset: confirm there is **no** `Cache-Control:
   immutable` and note the actual `max-age` GitHub serves. Record it here.

## Owner decision

None required for this pass. Long-lived immutable caching is only available by
changing hosts, which is out of scope and not recommended on the strength of
cache behaviour alone.
