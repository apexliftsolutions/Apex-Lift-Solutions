# Status colours — follow-up (re-audited v25.0)

Two colours remain as raw hex with no token. **Real inventory across
`docs/*.html`, `docs/*.js`, `docs/*.css`:**

| Hex | Total | HTML | JS (generated markup / style literals) | CSS | Role |
|---|---|---|---|---|---|
| `#4caf50` | 39 | 2 | 11 | 26 | success / paid / active |
| `#f0a500` | 10 | 2 | 8 | 0 | warning / pending |

An earlier version of this file said "two inline uses each in
portal-customer.html". That counted static HTML only and missed the JS-generated
markup and the stylesheets. This table is the corrected count.

They are **deliberately deferred**, not tokenised in this release: naming a
colour invites reuse, and neither has been contrast-checked on every surface it
lands on. Before tokenising, measure each against `--black`, `--dark`, `--dark-2`
at the sizes actually used, and confirm neither state relies on colour alone.

Not blocking. The danger red (`#ff4444`) **is** tokenised as `--red-danger`;
raw occurrences outside the four token definitions are 0 and enforced by test.
