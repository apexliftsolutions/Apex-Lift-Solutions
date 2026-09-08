-- =============================================================================
--  PREFLIGHT — migration 0008 function-replacement safety check
--
--  READ ONLY. Contains no writes, no DDL, no CREATE OR REPLACE.
--  Run in the Supabase SQL Editor. Returns ONE result grid.
--
--  0008_recurring_operations.sql uses CREATE OR REPLACE on two pre-existing
--  V22 functions:
--      notify_on_payment()
--      notify_on_invoice()
--
--  This prints what is deployed RIGHT NOW so you can compare it against the
--  0008 replacement before running anything, and so you can tell whether 0008
--  has already been applied.
-- =============================================================================

with target as (
  select p.oid, p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('notify_on_payment','notify_on_invoice')
)

select * from (

  -- ── 1. Has 0008 already been applied? ────────────────────────────────────
  -- These markers exist ONLY in the 0008 versions. If both say PRESENT, 0008
  -- is already live and must not be run again "just to be sure".
  select 1 as seq,
         'ALREADY-APPLIED' as section,
         t.proname as check_name,
         case when t.def like '%payment_source%' or t.def like '%invoice_source%'
              then 'PRESENT — 0008 markers found, this function is the 0008 version'
              else 'ABSENT — this is the pre-0008 version' end as observed
    from target t

  -- ── 2. Fingerprints. Record these BEFORE and compare AFTER. ──────────────
  union all
  select 2, 'FINGERPRINT', t.proname, md5(t.def) from target t

  union all
  select 3, 'FINGERPRINT', 'source line count',
         t.proname || ' = ' || (length(t.def) - length(replace(t.def, E'\n','')) + 1)::text
    from target t

  -- ── 3. Behaviour markers that MUST survive the replacement ───────────────
  -- 0008 is only safe if it preserves every V22 behaviour. Each row below is
  -- one behaviour; all must read PRESENT in the deployed version, and all must
  -- still be present in the 0008 file you are about to run.
  union all
  select 4, 'V22-BEHAVIOUR', m.label,
         case when (select def from target where proname = m.fn) like m.needle
              then 'PRESENT' else 'MISSING — investigate before deploying' end
    from (values
      ('notify_on_payment', 'no-op when status unchanged',        '%old.status is not distinct from new.status%'),
      ('notify_on_payment', 'succeeded payment -> payment_received', '%payment_received%'),
      ('notify_on_payment', 'pending ACH -> ach_submitted',       '%ach_submitted%'),
      ('notify_on_payment', 'failed payment -> payment_declined', '%payment_declined%'),
      ('notify_on_payment', 'refund -> payment_refunded',         '%payment_refunded%'),
      ('notify_on_payment', 'reversal -> payment_voided',         '%payment_voided%'),
      ('notify_on_payment', 'declines are NOT copied to admin',   '%ev <> ''payment_declined''%'),
      ('notify_on_payment', 'correction reason carried',          '%new.notes%'),
      ('notify_on_payment', 'original payment linkage carried',   '%refund_of%'),
      ('notify_on_payment', 'fee / total_charged carried',        '%total_charged%'),
      ('notify_on_invoice', 'fires on INSERT only',               '%tg_op=''INSERT''%'),
      ('notify_on_invoice', 'tax fields carried',                 '%tax_rate_milli_pct%')
    ) m(fn, label, needle)

  -- ── 4. The full deployed source, for a literal diff ──────────────────────
  -- Copy each into a file and diff against 0008_recurring_operations.sql.
  union all
  select 5, 'DEPLOYED-SOURCE', t.proname, t.def from target t

  -- ── 5. Everything that DEPENDS on these two functions ────────────────────
  -- If a trigger is missing here, replacing the function silently stops those
  -- emails. Expect the payment and invoice notification triggers.
  union all
  select 6, 'DEPENDENT-TRIGGERS',
         c.relname || ' . ' || tg.tgname,
         pg_get_triggerdef(tg.oid)
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
   where not tg.tgisinternal
     and tg.tgfoid in (select oid from target)

) r order by seq, section, check_name;

-- =============================================================================
--  HOW TO READ THIS
-- =============================================================================
--  ALREADY-APPLIED   both ABSENT  -> 0008 has not run. Safe to proceed.
--                    both PRESENT -> 0008 is already live. DO NOT rerun blindly;
--                                    confirm against your migration history.
--                    mixed        -> STOP. A partial application. Report it.
--
--  V22-BEHAVIOUR     any MISSING in the CURRENTLY DEPLOYED version means the
--                    live function already differs from what we believe V22 to
--                    be. Resolve that before layering 0008 on top.
--
--  DEPLOYED-SOURCE   diff against the 0008 file. The ONLY differences should be
--                    additive payload keys: payment_source, subscription_id,
--                    invoice_source. Any change to the event-mapping if/elsif
--                    chain, to the enqueue_notification event_key format, or to
--                    the admin-copy suppression is NOT additive — stop.
--
--  Re-run this file after deploying 0008 and confirm the FINGERPRINT hashes
--  changed to exactly the values you expect, and that no DEPENDENT-TRIGGERS row
--  disappeared.
-- =============================================================================
