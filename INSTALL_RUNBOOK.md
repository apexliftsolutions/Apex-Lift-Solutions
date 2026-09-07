# PHASE A — INSTALL RUNBOOK

For whoever is sitting in front of the Supabase dashboard. Follow it in order.
Stop at the first thing that does not match.

**What this installs:** tables, columns, constraints and security rules only.

**What this does NOT do:** it does not charge anyone, does not contact Helcim,
does not enable recurring billing, and does not change the existing one-time
payment system. `recurring_billing_enabled` is installed as `false`.

---

## Before you start

Take a database backup. Supabase → Database → Backups. The migration runs in a
single transaction and rolls back cleanly on failure, but take one anyway.

Two files must **never** be run against production:

- `tests/PHASE_A_ADVERSARIAL_TESTS.sql` — it deliberately creates fake
  customers, offers, contracts, invoices and payments. Local/staging only.
- Anything under `patches/` — those are notes, not runnable SQL.

---

## STEP 1 — Preflight (read-only, safe to run right now)

Supabase → **SQL Editor** → **New query**.

Paste the whole of:

```
SERVICE_PLANS_PREFLIGHT_SUPABASE.sql
```

Run it. You get **one result grid, about 46 rows**, with columns
`seq | section | check_name | observed | expected | verdict`.

> Use the `_SUPABASE` version, not `SERVICE_PLANS_PREFLIGHT.sql`. The plain one
> is written for psql and returns nine separate result sets; the Supabase SQL
> Editor only shows you the last one, so you would see a fraction of the output.

### What you need to see

| Section | What good looks like |
|---|---|
| `STATE` | "NO — this is the PRE-install run" |
| `PREREQ` | 5 rows, all **PASS** |
| `OBJECTS` | 12 rows, all **PASS** (every count is 0 — nothing may pre-exist) |
| `IN-FLIGHT` | **PASS**. If it says `WAIT`, someone is mid-checkout — wait a few minutes and re-run |
| `SECURITY` | both rows `false`, **PASS** |
| `BASELINE` / `MONEY` / `FINGERPRINT` / `FINGERPRINT-RLS` | verdict `RECORD` — these are values to compare later, not pass/fail |

**Any `FAIL` — especially `FAIL — NAME COLLISION` — means stop.** Something in
the database already uses a name this migration creates. Send the grid to the
auditor and do not run the migration.

### Then

Copy the whole grid (or screenshot it) and **send it to the auditor**. Wait for
approval before Step 2.

Keep your copy. You need it in Step 3.

---

## STEP 2 — Run the migration (only after approval)

SQL Editor → **New query**. Paste the whole of:

```
SERVICE_PLANS_UPGRADE.sql
```

Run it. It should take a few seconds.

**What you will see:** the file ends with several small verification queries, and
the editor shows only the last one — a short table of the five new tables with
`relrowsecurity = true`. That is normal and is not the real check; Step 3 is.

**If you see `WARNING: there is already a transaction in progress`** — harmless.
The editor had already opened a transaction around your query. The migration
still applies. Step 3 confirms it.

**If you see an actual `ERROR`** — nothing was applied. The whole file is wrapped
in `BEGIN … COMMIT`, so a failure anywhere rolls the entire thing back and your
database is untouched. Copy the full error text and send it. Do not re-run it or
try to patch it by hand.

---

## STEP 3 — Preflight again, and compare

Same file as Step 1: `SERVICE_PLANS_PREFLIGHT_SUPABASE.sql`.

The script detects that the migration is now installed and flips its own
expectations, so this time:

| Section | What good looks like |
|---|---|
| `STATE` | "YES — this is the POST-install run" |
| `OBJECTS` | 12 rows, all **PASS**. Counts are now 5 tables, 6 payments columns, 4 invoices columns, 3 chain FKs, 3 composite unique keys, 5 triggers, 18 functions, 10 config keys, 1 verify-session table, 1 bucket |
| `GATE` | `recurring_billing_enabled = false` **PASS**, `service_plan_contract_mode = test` **PASS** |
| `INTEGRITY` | both **PASS** — every existing payment and invoice classified `one_time` |
| `SECURITY` | still both `false` |

### The comparison that actually matters

Put the Step 1 grid next to the Step 3 grid. Every `RECORD` row must be
**identical**:

- `BASELINE` — same customer, invoice, payment, payment_events, outbox and
  audit_log counts
- `MONEY` — same invoice totals per status, same payment totals per kind/status
- `FINGERPRINT` — same hash for all eleven payment functions, including
  `recalc_invoice_status`, `notify_on_payment`, `guard_payment`,
  `guard_tax_totals`, `create_checkout_session`, `read_checkout_session`. The
  single `ALL payment functions combined` hash is the quickest way to check —
  if that one matches, all eleven match.
- `FINGERPRINT-RLS` — same policy count and same hash

**If any RECORD value changed, stop and report it.** That would mean the
migration touched something it was supposed to leave alone.

(`audit_log` is the one count that may legitimately grow, but only if someone
used the site between your two runs. If the site was quiet, it should match.)

Send the Step 3 grid to the auditor.

---

## STEP 4 — Only after Step 3 passes

Deploy the `payment-checkout` guard described in
`patches/PAYMENT_CHECKOUT_RECURRING_GUARD.md`.

**Order matters and cannot be reversed.** That function has to read the new
`invoices.invoice_source` column. Deploying it before Step 2 breaks one-time
checkout for every customer, because the column would not exist yet.

The guard is not urgent — no recurring invoice can exist until Phase F — so
there is no cost to leaving it until Steps 1–3 are confirmed good.

---

## If you need to undo it

Don't, unless the auditor says so. Nothing in this schema affects one-time
payments, so leaving it in place costs nothing.

If something must be paused, the correct move is **not** a rollback:

```sql
update app_config set value = 'false' where key = 'recurring_billing_enabled';
```

and stop creating offers. Once a customer has signed an agreement, dropping
these tables destroys a signed contract and its payment history.

---

## Quick reference — what each file is for

| File | Run it? | Where |
|---|---|---|
| `SERVICE_PLANS_PREFLIGHT_SUPABASE.sql` | Yes — twice | Supabase SQL Editor |
| `SERVICE_PLANS_UPGRADE.sql` | Yes — once, after approval | Supabase SQL Editor |
| `SERVICE_PLANS_PREFLIGHT.sql` | Optional | psql only (nine result sets) |
| `tests/PHASE_A_ADVERSARIAL_TESTS.sql` | **Never on production** | local/staging only |
| `supabase/migrations/0005_*.sql`, `0006_*.sql` | Not by hand | for rebuilding from scratch |
| `patches/*.md` | Not SQL | notes for Step 4 |
