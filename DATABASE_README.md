# Which SQL file do I run?

| File | Use on | Destructive? |
|---|---|---|
| **`PRODUCTION_UPGRADE.sql`** | **The live Apex database.** Upgrades in place. | **No.** No DROP TABLE, no TRUNCATE, no DELETE. |
| `SUPABASE_FRESH_TEST_ONLY.sql` | A brand-new empty project, or a throwaway staging copy. | **Yes — drops every table.** Never run on production. |

## Before running the upgrade
1. Supabase → Database → **Backups** → take a manual backup.
2. Better: use **Branching** or restore the backup into a scratch project and run
   the upgrade there first. Reading a migration is not the same as testing it.
3. Then run `PRODUCTION_UPGRADE.sql` in the SQL Editor. It is wrapped in
   `begin; … commit;` so a failure part-way rolls everything back.
4. Run the five verification queries at the bottom of the file.

## What the upgrade does to existing data
- **Adds** columns to `customers`, `quotes`, `invoices`, `service_history`. Existing values untouched.
- **Widens** the invoice status constraint to include `payment_pending`, `refunded`, `partially_refunded`, `void`. Existing `unpaid`/`paid`/`hidden` values stay valid.
- **Backfills** a `payments` row for every invoice already marked paid. Without this, the new derived-status function would see zero payments and flip your paid invoices back to unpaid. This runs *before* the notification triggers are installed, so it emails nobody.
- **Rewrites** stored attachment URLs into storage paths, so existing photos still open after the bucket goes private.
- **Changes ID defaults** for new rows only. Existing IDs are never rewritten — foreign keys stay intact.
- **Drops and rebuilds policies.** This removes access rules, not rows, and is the point of the migration.
- **Flips the storage bucket to private.** The files themselves are not moved or deleted.

## Order of operations
```
1. backup
2. PRODUCTION_UPGRADE.sql
3. verification queries        ← stop here if anything looks wrong
4. supabase secrets set …      ← see docs/SECRETS_SETUP.md
5. supabase functions deploy … ← see docs/HELCIM_PRODUCTION_SETUP.md §F
6. upload the site files
7. cron block (needs pg_cron + pg_net enabled first)
```

Deploy the SQL **before** the site files. The new frontend calls
`respond_to_quote()` and `recalc_invoice_status()`; if those don't exist yet,
quote approval breaks.
