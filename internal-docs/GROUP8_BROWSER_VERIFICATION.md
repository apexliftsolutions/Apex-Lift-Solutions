# GROUP 8 — BROWSER VERIFICATION CHECKLISTS

The CSP candidate cannot be finalised from static analysis. These three captures
supply the missing origins. **All are read-only observation. No card or bank
credentials should ever be pasted into chat — record origins only.**

Open DevTools → **Network**, tick **Preserve log**, and note the **Domain**
column. Filter chips (JS / XHR / Fetch / Doc / Img / Font / WS) make this quick.

---

## 1. Helcim — the highest-risk capture

Use a **real payment-method setup or a $1 payment you intend to make anyway**.
Do not create test charges for this.

1. Sign in to the customer portal. Clear the Network log.
2. Open an invoice and start payment (or start Add Payment Method).
3. Let the Helcim window fully render. Do not submit anything yet.
4. Record every distinct domain, grouped by type:
   - **Script** origins
   - **Frame / Document** origins (the `frame-src` list — this is the one most
     likely to be missed)
   - **XHR / Fetch** origins (`connect-src`)
   - **Img / Font / CSS** origins
   - **WS** origins, if any appear
5. Complete or cancel the flow and note any *additional* domains that appear
   only at that stage.

Record as: `type | domain`. Nothing else is needed.

---

## 2. Google Analytics — three states

**State A — no consent (use a fresh private window).**
Load the homepage. Filter Network to `google`.
**Expected: zero requests.** If anything appears, stop and report it.

**State B — accept.**
Click **Accept analytics**. Record:
- the **script** origin (expected `www.googletagmanager.com`, confirm)
- the **collection** origin the tag posts to — this is region-dependent and
  **must be observed, not assumed**

**State C — reject after accepting.**
Reopen **Cookie Settings**, untick analytics, save. Then navigate to another page.
**Expected: no new analytics requests.** Also confirm in Application → Cookies
that the `_ga*` cookies on this origin are gone.

---

## 3. Supabase — does it open a WebSocket?

1. Sign in to the customer portal, then the admin portal.
2. Filter Network to **WS**.
3. Record whether any `wss://cjtezsgfdfijmdxzzbiq.supabase.co` connection opens,
   and at what point.

If none appears in either portal, `connect-src` needs the HTTPS origin only. If
one does, capture the exact origin. **Do not add `wss:` speculatively.**

---

## What to send back

A plain list is enough:

```
HELCIM   script  secure.helcim.app
HELCIM   frame   ...
HELCIM   xhr     ...
GA       script  www.googletagmanager.com
GA       xhr     ...
SUPABASE ws      (none observed) | wss://...
```

That completes `script-src`, `connect-src` and `frame-src`, after which the meta
CSP can be assembled and activated in a small Group 8.1 — **without**
`script-src-attr 'none'` initially, since inline handlers are still present.
