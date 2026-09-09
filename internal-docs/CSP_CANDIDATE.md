# CSP CANDIDATE — NOT ENFORCED

**Nothing in this file is deployed.** No CSP meta tag was added to any page. This
is a candidate to be proven in a browser first, then activated separately.

## Why it is not enforced yet

Two reasons, both practical:

1. **GitHub Pages cannot emit a `Content-Security-Policy-Report-Only` header**,
   so there is no safe way to observe violations before enforcing. Getting it
   wrong breaks login, payment, or both, with no warning phase.
2. **The Helcim origin set is not fully knowable from here.** HelcimPay creates
   frames and makes its own calls at runtime. Guessing those origins and shipping
   an enforcing policy is how a payment page goes dark.

## What GitHub Pages can and cannot do

| Protection | Available today? |
|---|---|
| CSP via `<meta http-equiv>` | **Yes**, with limits below |
| CSP via response header | **No** — needs a host/CDN that sets headers |
| `frame-ancestors` | **No** — ignored in a meta tag; header only |
| `report-uri` / `report-to` | **No** — meaningless without header delivery |
| `X-Content-Type-Options: nosniff` | **No** |
| `X-Frame-Options` | **No** |
| `Permissions-Policy` | **No** |
| `Referrer-Policy` | **Partly** — `<meta name="referrer">` works |
| `Strict-Transport-Security` | GitHub Pages sets HSTS for `*.github.io`; for a custom domain it depends on the Enforce HTTPS setting |

**Do not claim any header-only protection is implemented while the site is on
GitHub Pages.** Clickjacking protection in particular (`frame-ancestors` /
`X-Frame-Options`) is **not currently available at all**. Moving to a host that
supports custom headers — Cloudflare Pages, Netlify, or a CDN in front — is the
only way to get them. That is a hosting decision, out of scope here.

## Origins proven locally

Static analysis of canonical `docs/` after Groups 5 and 8:

| Purpose | Origin | Evidence |
|---|---|---|
| Everything first-party | `'self'` | Supabase SDK, fonts, all CSS/JS/images are self-hosted |
| Backend, auth, storage, Edge Functions | `https://cjtezsgfdfijmdxzzbiq.supabase.co` | `fetch()` in three public pages + the SDK client URL |
| Payments | `https://secure.helcim.app` | `<script src>` on the payment pages |
| Optional analytics, after consent only | `https://www.googletagmanager.com` | injected by `consent.js`, never at page load |

Confirmed **absent**: jsDelivr, `fonts.googleapis.com`, `fonts.gstatic.com`.
Confirmed **not runtime origins**: `schema.org`, `w3.org`, `tools.google.com` —
these appear only as link targets or JSON-LD identifiers.


## Google reCAPTCHA — RUNTIME OBSERVED, SOURCE OWNER NOT YET ISOLATED

Manual browser verification recorded reCAPTCHA-style requests
(`api.js?render=…`, `anchor?…`, `webworker.js`, `recaptcha__en.js`).

**What the source audit proves:** Apex code does not load reCAPTCHA. There is no
`grecaptcha`, no `google.com/recaptcha` and no `gstatic.com` reference anywhere
in canonical `docs/`. The only Google string in the tree is
`googletagmanager.com` inside `consent.js`, which is consent-gated, plus a
`drive.google.com` example inside a careers form field placeholder — not a
request at all.

**What it does not prove:** that Helcim is the origin. Helcim is a strong
candidate — it is the only third-party script we hand execution to, it loads on
`portal-customer.html` alone, and Helcim's own documentation describes a
*Require Captcha* option that uses Google reCAPTCHA. But "our code doesn't do it"
and "Helcim does it" are different claims, and only one of them is currently
evidenced.

**Classification: RUNTIME OBSERVED — SOURCE OWNER NOT YET ISOLATED.**

**Do not add `https://www.google.com` or `https://www.gstatic.com` to
`script-src` or `frame-src` as proven origins yet.** Adding them on inference
would either be unnecessary or, worse, mask the real source.

### Isolating it

The discriminator is which page the requests appear on:

1. Fresh private window → load the homepage and one other public page. Filter
   Network to `recaptcha`. **If anything appears here, it is not Helcim** —
   Helcim's script is on no public page — and needs investigating before CSP.
2. Sign in to the customer portal, but do **not** open a payment. Check again.
3. Open a payment or Add Payment Method and let the Helcim window render. If
   reCAPTCHA appears only at this step, Helcim is confirmed and the origins go
   into `script-src` and `frame-src` on that evidence.

Record the page and the step alongside each origin.

### Resolved by browser verification

- **No WebSocket traffic observed in the customer portal.** `connect-src` needs
  the Supabase HTTPS origin only — **no `wss:`**.
- **Helcim popup works.** The earlier payment failure was session/auth state,
  addressed as frontend messaging in Group 8.1, not a Helcim integration bug.

## Origins that still require browser verification

- **Helcim.** Frame origins, XHR targets, and any asset/font origins the SDK
  pulls in. Highest risk directive by far.
- **Google Analytics collection endpoint.** Modern GA4 usually posts to
  `https://*.google-analytics.com` or a region-specific host. **Do not assume a
  hostname** — observe it.
- **Supabase realtime — RESOLVED.** Browser verification observed no WebSocket
  traffic in the customer portal. `wss:` must NOT be added to `connect-src`.

## Candidate policy — do not ship unverified

```
default-src 'self';
base-uri 'self';
object-src 'none';
script-src 'self' https://secure.helcim.app https://www.googletagmanager.com;
script-src-attr 'none';
style-src 'self' 'unsafe-inline';
font-src 'self';
img-src 'self' data:;
connect-src 'self' https://cjtezsgfdfijmdxzzbiq.supabase.co <GA collection origin> <wss if proven>;
frame-src <Helcim frame origins>;
form-action 'self';
upgrade-insecure-requests;
```

Notes on specific directives:

- **`script-src-attr 'none'` cannot ship yet.** The portals still use inline
  `onclick=` handlers extensively, including on generated markup. Removing them
  is a separate, carefully tested piece of work — see below.
- **`style-src 'unsafe-inline'` is retained deliberately.** There are hundreds of
  harmless inline `style` attributes. This weakens *style* restrictions only and
  does **not** weaken script execution. Converting them was explicitly out of
  scope, and `'unsafe-inline'` must never be added to `script-src` because inline
  *styles* exist.
- **`'unsafe-eval'` is not required.** Verified: zero `eval()`, zero
  `new Function()`, zero string-argument `setTimeout` across all frontend files,
  and the vendored Supabase 2.116.0 UMD build evaluates without it.
- **JSON-LD.** `index.html` carries a `LocalBusiness` block as
  `<script type="application/ld+json">`. It is data, not executable code, but
  `script-src` still governs it. The intended approach is a **SHA-256 hash for
  that exact static block**, added to `script-src`. It must not be moved to a
  runtime injection — that would harm search discoverability for no security
  gain, since JSON-LD cannot execute.
- **No wildcards.** No `https:`, no `*`, no `*.com`. If a directive cannot be
  filled with an exact origin, it stays blocked until observed.


## Update — stored XSS found and removed during Group 8 follow-up

The customers table rendered customer-controlled `name`, `company` and `email`
inside `onclick="…"` attributes, HTML-escaped with `esc()`. That gave no
protection: the HTML parser decodes `&#39;` back to `'` **before** the inline
JavaScript is compiled, so a stored name of `');alert(1);//` broke out of the
string. Customers can edit those fields themselves through `update_my_profile()`,
so this was a stored-XSS path from a customer into an admin session.

Fixed by removing customer text from executable attributes entirely: the buttons
now carry `data-customer-action` and `data-customer-id`, a single delegated
listener resolves the row from an in-memory map, and a fixed `switch` selects the
handler. The action string is never executed.

**This does not clear the way for `script-src-attr 'none'`.** Legacy inline
handlers remain elsewhere in both portals — currently carrying only
server-generated ids, integers and internally-built strings, which the security
suite classifies and asserts on. Removing them is the Group 8.1 migration.

## Inline executable scripts still present

`careers.html`, `contact.html`, `index.html` (form handlers) and
`portal-reset.html` (redirect shim). Each would need either extraction to a
first-party file or a hash. **Not done in this group** — the form handlers are
duplicated across three pages and consolidating them safely is its own task.

## Order of work for a future Group 8.1

1. Capture the real network inventory from a browser (checklists supplied separately).
2. Extract the four inline scripts, or hash them.
3. Remove inline event handlers and adopt a fixed handler map — never
   `window[el.dataset.action]()`.
4. Add the JSON-LD hash.
5. Ship the meta CSP **without** `script-src-attr 'none'` first, verify, then
   tighten.
6. Revisit header-only protections only if hosting changes.
