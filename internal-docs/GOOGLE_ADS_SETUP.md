# Google Ads & Conversion Tracking — Setup

The homepage already fires `window.APEX_TRACK(event, href)` on every tracked
element. No account IDs are in the code. You wire them in one place.

## Events already instrumented
| Event | Fires when |
|---|---|
| `call_click` | any `tel:` link with `data-track="call_click"` (hero, form, sticky bar) |
| `request_submit` | the homepage service-request form submits |
| `email_click` | the service@ mailto link |

## 1. Install the tag
Create a Google Ads account → **Tools → Conversions → New → Website** → get your
`AW-XXXXXXXXXX` tag. Add to `<head>` of every public page:
```html
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-XXXXXXXXXX"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','AW-XXXXXXXXXX');</script>
```

## 2. Connect the events
Create three conversion actions in Ads (Phone call, Submit lead form, Contact),
note each label, then define `APEX_TRACK` once in `main.js`:
```js
window.APEX_TRACK = function(ev){
  var labels = { call_click:'AW-XXXXXXXXXX/CALL_LABEL', request_submit:'AW-XXXXXXXXXX/FORM_LABEL', email_click:'AW-XXXXXXXXXX/EMAIL_LABEL' };
  if (window.gtag && labels[ev]) gtag('event','conversion',{ send_to: labels[ev] });
};
```
Also turn on **call reporting** in Ads so calls placed directly from the ad's
call extension are counted without touching the website.

## 3. First campaign
**Geo:** Nassau County + Suffolk County only. Expand later, on data.
**Budget:** $30–50/day to start.
**Bidding:** Maximize conversions once you have ~15 conversions; manual CPC before.

| Ad group | Keywords (phrase match) |
|---|---|
| Forklift Repair | "forklift repair", "forklift repair near me", "forklift mechanic", "forklift service" |
| Emergency | "emergency forklift repair", "forklift won't start", "mobile forklift repair" |
| Maintenance | "forklift maintenance", "forklift preventive maintenance", "forklift service contract" |

**Negative keywords (campaign level):** jobs, salary, hiring, training, school,
certification, certified, license, operator, manual, pdf, toy, rental, rent,
for sale, used, buy, parts (unless you sell parts), diy, how to.

## 4. Don't launch until
- The homepage form and call buttons are live (they are, in this build).
- `APEX_TRACK` is wired and you've watched a test conversion land in Ads.
- Google Business Profile exists — it drives more calls than the website.
