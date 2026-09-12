-- =============================================================================
--  READ-ONLY deployment diagnostic for the "conversion_failed" symptom.
--  Run in the Supabase SQL editor. Changes nothing.
--
--  "conversion_failed" is generic. It has THREE distinct causes and this script
--  tells them apart:
--    1. the conversion RPC is genuinely absent (0014 not applied);
--    2. 0014 partially applied (function present, unique index missing);
--    3. the RPC RUNS but an internal dependency fails — the confirmed production
--       case, where new_id() called pgcrypto unqualified and the RPC's
--       restricted search_path could not resolve it.
--
--  If the server log names a function OTHER than quote_to_invoice_v2 as missing,
--  0014 IS applied and cause 3 is what you are looking at.
-- =============================================================================

-- ── 1. IS 0014 ACTUALLY APPLIED? ────────────────────────────────────────────
-- Which schema holds pgcrypto, and is new_id qualified against it?
select 'gen_random_bytes schema' as check,
       coalesce((select n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where p.proname='gen_random_bytes'
                    and pg_get_function_identity_arguments(p.oid)='integer' limit 1),
                'NOT INSTALLED') as result
union all
select 'new_id qualifies gen_random_bytes',
       case when pg_get_functiondef('public.new_id(text)'::regprocedure) like '%.gen_random_bytes%'
            then 'YES' else 'NO  <-- invoice conversion WILL fail; apply migration 0015' end
union all
select 'quote_to_invoice_v2 present',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='quote_to_invoice_v2')
            then 'YES' else 'NO  <-- migration 0014 has NOT been applied' end as result
union all
select 'uq_invoice_quote_id index present',
       case when exists (select 1 from pg_indexes where indexname='uq_invoice_quote_id')
            then 'YES' else 'NO  <-- migration 0014 has NOT been applied' end
union all
select 'quote_to_invoice (0012 wrapper) present',
       case when exists (select 1 from pg_proc where proname='quote_to_invoice') then 'YES' else 'NO' end
union all
select 'service_role can execute quote_to_invoice_v2',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='quote_to_invoice_v2')
            then case when has_function_privilege('service_role','public.quote_to_invoice_v2(text)','EXECUTE')
                      then 'YES' else 'NO  <-- grant missing' end
            else 'n/a (function absent)' end
union all
select 'supabase_migrations rows (if tracked)',
       coalesce((select string_agg(version, ', ' order by version desc)
                   from (select version from supabase_migrations.schema_migrations
                         order by version desc limit 5) t), 'table not readable / not tracked');

-- ── 2. THE MOST RECENT APPROVED QUOTE AND ITS INVOICE ──────────────────────
select q.id                as quote_id,
       q.status,
       q.invoiced,
       q.customer_id,
       q.customer_email,
       q.equipment_id,
       (q.equipment_snapshot is not null) as has_equipment_snapshot,
       q.equipment          as equipment_label,
       q.amount,
       q.responded_at,
       i.id                 as linked_invoice_id,
       i.customer_id        as invoice_customer_id,
       i.status             as invoice_status,
       i.created_at         as invoice_created_at,
       case when i.id is null then 'no invoice yet'
            when i.customer_id is distinct from q.customer_id then 'OWNER MISMATCH — customer cannot see it'
            else 'ok' end   as assessment
  from quotes q
  left join invoices i on i.quote_id = q.id
 where q.status = 'approved'
 order by q.responded_at desc nulls last, q.created_at desc
 limit 10;

-- ── 3. VERDICT ──────────────────────────────────────────────────────────────
select case
  when not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname='quote_to_invoice_v2')
    then 'CAUSE 1 — the conversion RPC is absent, so 0014 is not applied. Run the 0014 preflight, then supabase db push. Do NOT add a new migration to work around this.'
  when pg_get_functiondef('public.new_id(text)'::regprocedure) not like '%.gen_random_bytes%'
    then 'CAUSE 3 — new_id() calls gen_random_bytes UNQUALIFIED. quote_to_invoice_v2 runs with search_path = public, pg_temp and cannot resolve it, so the invoice INSERT fails. Apply migration 0015.'
  when not exists (select 1 from pg_indexes where indexname='uq_invoice_quote_id')
    then 'PARTIAL — the function exists but the unique index does not. 0014 may have aborted on a guard; re-run it and read the error.'
  else '0014 looks applied. Capture the admin-action server log for the failing quote: it now records the quote id, PostgreSQL error code and a sanitized message.'
  end as verdict;
