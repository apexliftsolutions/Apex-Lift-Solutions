-- =============================================================================
-- SERVICE PLANS — PREFLIGHT (SUPABASE SQL EDITOR EDITION)
--
-- READ ONLY. One statement, one result grid. No writes of any kind.
--
-- The Supabase SQL Editor displays only the LAST result set when you run
-- several statements, so this returns everything as a single table you can
-- screenshot or copy in one go.
--
-- Run it TWICE: once before SERVICE_PLANS_UPGRADE.sql and once after. It
-- detects for itself which side of the install you are on and sets each
-- verdict accordingly.
--
--   PASS   = as expected
--   FAIL   = stop and report before going further
--   RECORD = not pass/fail; copy the value and compare before vs after
-- =============================================================================

with state as (
  select exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'service_plan_offers'
  ) as installed
),

-- ── object inventory: what this migration creates ───────────────────────────
inv as (
  select 'new tables' as item, 5 as expect_after, count(*)::int as found
    from information_schema.tables
   where table_schema='public'
     and table_name in ('customer_equipment','service_plan_offers',
                        'service_plan_agreements','service_subscriptions','service_plan_events')
  union all
  select 'payments new columns', 6, count(*)::int from information_schema.columns
   where table_schema='public' and table_name='payments'
     and column_name in ('payment_source','subscription_id','billing_period_start',
                         'billing_period_end','provider_subscription_payment_id','provider_payment_number')
  union all
  select 'invoices new columns', 4, count(*)::int from information_schema.columns
   where table_schema='public' and table_name='invoices'
     and column_name in ('invoice_source','subscription_id','billing_period_start','billing_period_end')
  union all
  select 'customers.helcim_customer_code', 1, count(*)::int from information_schema.columns
   where table_schema='public' and table_name='customers' and column_name='helcim_customer_code'
  union all
  select 'chain-integrity FKs', 3, count(*)::int from pg_constraint
   where conname in ('fk_offer_equipment_same_customer','fk_agreement_matches_offer_chain',
                     'fk_sub_matches_agreement_chain')
  union all
  select 'composite unique keys', 3, count(*)::int from pg_constraint
   where conname in ('uq_equipment_id_customer','uq_offer_chain','uq_agreement_chain')
  union all
  select 'validation + durability triggers', 5, count(*)::int from pg_trigger
   where tgname in ('trg_validate_agreement','trg_validate_subscription','trg_no_delete_agreement',
                    'trg_events_append_only','trg_no_delete_billed_sub')
  union all
  select 'new functions', 18, count(*)::int
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('touch_updated_at','cfg_bool','assert_transition',
                       'guard_service_plan_offer','guard_service_plan_agreement','guard_service_subscription',
                       'validate_agreement_against_offer','validate_subscription_against_agreement',
                       'forbid_agreement_delete','forbid_event_mutation','forbid_billed_subscription_delete',
                       'create_verify_session','read_verify_session','consume_verify_session',
                       'purge_expired_verify_sessions','set_subscription_reminder',
                       'accept_offer_and_sign_agreement','create_subscription_from_agreement')
  union all
  select 'app_config service-plan keys', 10, count(*)::int from app_config
   where key in ('recurring_billing_enabled','service_plan_contract_mode','service_plan_agreement_version',
                 'service_plan_default_term_months','service_plan_offer_expiry_days',
                 'service_plan_verify_session_minutes','helcim_recurring_plan_id_expires',
                 'helcim_recurring_plan_id_expires_card','helcim_recurring_plan_id_expires_bank',
                 'helcim_recurring_plan_id_forever')
  union all
  select 'private.helcim_verify_session', 1, count(*)::int from information_schema.tables
   where table_schema='private' and table_name='helcim_verify_session'
  union all
  select 'apex-agreements bucket', 1, count(*)::int from storage.buckets where id='apex-agreements'
),

-- ── the payment stack that must not move ────────────────────────────────────
fn as (
  select p.proname, md5(pg_get_functiondef(p.oid)) as h
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('recalc_invoice_status','notify_on_payment','notify_on_invoice',
                       'guard_payment','guard_tax_totals','enqueue_notification','write_audit',
                       'is_admin','create_checkout_session','read_checkout_session','quote_to_invoice')
),
pol as (
  select tablename, policyname, cmd, coalesce(qual,'-') q, coalesce(with_check,'-') w
    from pg_policies
   where schemaname='public'
     and tablename in ('customers','quotes','invoices','payments','payment_events',
                       'service_requests','service_history','notification_outbox','app_config',
                       'audit_log','activity_log','payment_webhook_events','contact_submissions','rate_limits')
)

select * from (

  select 0 as seq, 'STATE' as section, 'migration already installed' as check_name,
         (select case when installed then 'YES — this is the POST-install run'
                      else 'NO — this is the PRE-install run' end from state) as observed,
         '' as expected, 'RECORD' as verdict

  -- ── 1. prerequisites ──────────────────────────────────────────────────────
  union all
  select 10, 'PREREQ', v.item, case when v.ok then 'present' else 'MISSING' end, 'present',
         case when v.ok then 'PASS' else 'FAIL' end
  from (values
    ('FEESAVER_UPGRADE (payments.fee_cents)',
      exists (select 1 from information_schema.columns
               where table_name='payments' and column_name='fee_cents')),
    ('TAX_UPGRADE (invoices.tax_rate_milli_pct)',
      exists (select 1 from information_schema.columns
               where table_name='invoices' and column_name='tax_rate_milli_pct')),
    ('REFUND_VOID_V22 (recalc handles reversals)',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname='recalc_invoice_status'
                 and pg_get_functiondef(p.oid) ilike '%reversal_c%')),
    ('REFUND_VOID_V22 (payment_voided event)',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname='notify_on_payment'
                 and pg_get_functiondef(p.oid) ilike '%payment_voided%')),
    ('private schema exists',
      exists (select 1 from information_schema.schemata where schema_name='private'))
  ) v(item, ok)

  -- ── 2. object inventory (verdict flips with install state) ────────────────
  union all
  select 20, 'OBJECTS', inv.item,
         inv.found || ' found',
         case when (select installed from state) then inv.expect_after || ' expected'
              else '0 expected (nothing may pre-exist)' end,
         case when (select installed from state)
                then case when inv.found = inv.expect_after then 'PASS' else 'FAIL' end
                else case when inv.found = 0 then 'PASS' else 'FAIL — NAME COLLISION' end
         end
  from inv

  -- ── 3. baseline row counts — must be identical before and after ───────────
  union all
  select 30, 'BASELINE', b.t, b.c::text, 'unchanged by the migration', 'RECORD'
  from (
    select 'customers' t, count(*) c from customers
    union all select 'invoices',            count(*) from invoices
    union all select 'payments',            count(*) from payments
    union all select 'payment_events',      count(*) from payment_events
    union all select 'notification_outbox', count(*) from notification_outbox
    union all select 'audit_log',           count(*) from audit_log
  ) b

  -- ── 4. baseline money — must be identical before and after ────────────────
  union all
  select 40, 'MONEY', 'invoices: ' || status,
         count(*) || ' invoices, $' || coalesce(sum(amount),0)::numeric(12,2),
         'unchanged by the migration', 'RECORD'
    from invoices group by status
  union all
  select 41, 'MONEY', 'payments: ' || kind || ' / ' || status,
         count(*) || ' rows, ' || coalesce(sum(amount_cents),0) || ' cents',
         'unchanged by the migration', 'RECORD'
    from payments group by kind, status

  -- ── 5. payment-stack fingerprints — must be identical before and after ────
  union all
  select 50, 'FINGERPRINT', 'ALL payment functions combined',
         (select md5(string_agg(h, '|' order by proname)) from fn),
         'IDENTICAL before vs after', 'RECORD'
  union all
  select 51, 'FINGERPRINT', fn.proname, fn.h, 'IDENTICAL before vs after', 'RECORD' from fn

  -- ── 6. existing RLS — must be identical before and after ──────────────────
  union all
  select 60, 'FINGERPRINT-RLS', 'existing money-table policies',
         (select count(*) || ' policies, hash ' ||
                 md5(string_agg(tablename||'|'||policyname||'|'||cmd||'|'||q||'|'||w,
                                E'\n' order by tablename, policyname)) from pol),
         'IDENTICAL before vs after', 'RECORD'

  -- ── 7. quiet window ───────────────────────────────────────────────────────
  union all
  select 70, 'IN-FLIGHT', 'live Helcim checkout attempts (last hour)',
         count(*)::text, 'ideally 0 — do not migrate mid-checkout',
         case when count(*) = 0 then 'PASS' else 'WAIT' end
    from payments
   where provider='helcim' and kind='payment'
     and status in ('initiated','pending','unknown')
     and initiated_at > now() - interval '1 hour'

  -- ── 8. the private schema stays invisible to the API ──────────────────────
  union all
  select 80, 'SECURITY', 'private schema usage: ' || r.rolname,
         has_schema_privilege(r.rolname,'private','usage')::text, 'false',
         case when has_schema_privilege(r.rolname,'private','usage') then 'FAIL' else 'PASS' end
    from pg_roles r where r.rolname in ('anon','authenticated')

  -- ── 9. the gate + post-install data integrity ─────────────────────────────
  union all
  select 90, 'GATE', 'recurring_billing_enabled',
         coalesce((select value from app_config where key='recurring_billing_enabled'),'(not set yet)'),
         'false',
         case when (select installed from state) = false then 'RECORD'
              when coalesce((select value from app_config where key='recurring_billing_enabled'),'') = 'false'
                then 'PASS' else 'FAIL — RECURRING BILLING IS ON' end
  union all
  select 91, 'GATE', 'service_plan_contract_mode',
         coalesce((select value from app_config where key='service_plan_contract_mode'),'(not set yet)'),
         'test',
         case when (select installed from state) = false then 'RECORD'
              when coalesce((select value from app_config where key='service_plan_contract_mode'),'') = 'test'
                then 'PASS' else 'FAIL' end
  -- to_jsonb(row) is used deliberately: it reads a column that may not exist
  -- yet, so this same file parses and runs on BOTH sides of the install.
  union all
  select 92, 'INTEGRITY', 'payments not classified one_time',
         (select count(*)::text from payments p
           where coalesce(to_jsonb(p) ->> 'payment_source','one_time') <> 'one_time'),
         '0',
         case when (select count(*) from payments p
                     where coalesce(to_jsonb(p) ->> 'payment_source','one_time') <> 'one_time') = 0
              then 'PASS' else 'FAIL' end
  union all
  select 93, 'INTEGRITY', 'invoices not classified one_time',
         (select count(*)::text from invoices i
           where coalesce(to_jsonb(i) ->> 'invoice_source','one_time') <> 'one_time'),
         '0',
         case when (select count(*) from invoices i
                     where coalesce(to_jsonb(i) ->> 'invoice_source','one_time') <> 'one_time') = 0
              then 'PASS' else 'FAIL' end

) results
order by seq, section, check_name;
