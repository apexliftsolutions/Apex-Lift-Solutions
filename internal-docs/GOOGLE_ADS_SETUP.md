# Google Ads — current guidance (v25.0)

**There is no production Google Ads (`AW-`) id configured.** Nothing in the
codebase references one, and none should be invented.

## The rule

**No Google tag — Ads or Analytics — may load outside the consent architecture.**
`docs/consent.js` is the only place a Google script is injected, and only after
the visitor accepts analytics. Pasting a `gtag` snippet into a page bypasses
consent and contradicts the published Cookie Policy. Do not do it.

## The analytics path

`window.ApexConsent.track(name, meta)` is the single consent-aware API. It is a
no-op until consent is given and filters identifying fields before sending.
Every call site guards with `typeof window.ApexConsent.track === 'function'`.

## What the events mean

| Event | Meaning | Emitted by |
|---|---|---|
| `request_submit_attempt` | A service-request form was submitted | `public-forms.js`, before fetch |
| `request_submit` | **The server confirmed** the service request was stored | `public-forms.js`, only after `r.ok` |
| `job_application_submit_attempt` | A careers form was submitted | `public-forms.js`, before fetch |
| `job_application_submit` | **The server confirmed** the application was stored | `public-forms.js`, only after `r.ok` |

**A failed submission is not a conversion.** The `_attempt` events exist so
funnel drop-off is visible; they must never be wired to an Ads conversion.

## If Ads is added later

1. The `AW-` id goes into `consent.js` alongside the GA id, loaded on the same
   consent gate.
2. The conversion action maps to `request_submit` (service leads) and, if
   wanted, `job_application_submit` — never to the `_attempt` events, and never
   to a click-level `data-track` event.
3. Verify in a fresh private window that **zero** Google requests occur before
   the banner is answered.
