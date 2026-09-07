-- =============================================================================
-- SERVICE PLANS — PREFLIGHT   (READ ONLY. Contains no writes of any kind.)
--
-- Run this against PRODUCTION *before* SERVICE_PLANS_UPGRADE.sql and compare
-- against the expected output in the right-hand column of each result.
-- If any check disagrees, STOP and report it — do not run the upgrade.
-- =============================================================================

-- ── 1. Prerequisite migrations are actually applied ─────────────────────────
-- Expect: all four rows report present = t
select 'PREREQ' as section, check_name, present from (
  select 'FEESAVER_UPGRADE (payments.fee_cents)' as check_name,
         exists (select 1 from information_schema.columns
                  where table_name='payments' and column_name='fee_cents') as present
  union all
  select 'TAX_UPGRADE (invoices.tax_rate_milli_pct)',
         exists (select 1 from information_schema.columns
                  where table_name='invoices' and column_name='tax_rate_milli_pct')
  union all
  select 'REFUND_VOID_V22 (recalc handles reversals)',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='recalc_invoice_status'
                    and pg_get_functiondef(p.oid) ilike '%reversal_c%')
  union all
  select 'REFUND_VOID_V22 (payment_voided event)',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='notify_on_payment'
                    and pg_get_functiondef(p.oid) ilike '%payment_voided%')
) t order by check_name;

-- ── 2. Nothing this migration creates already exists ────────────────────────
-- Expect: 0 rows. Any row means a name collision that must be resolved first.
select 'COLLISION' as section, 'table' as kind, table_name as name
  from information_schema.tables
 where table_schema='public'
   and table_name in ('customer_equipment','service_plan_offers',
                      'service_plan_agreements','service_subscriptions','service_plan_events')
union all
select 'COLLISION','column', table_name||'.'||column_name
  from information_schema.columns
 where (table_name='payments'  and column_name in ('payment_source','subscription_id',
        'billing_period_start','billing_period_end','provider_subscription_payment_id',
        'provider_payment_number'))
    or (table_name='invoices'  and column_name in ('invoice_source','subscription_id',
        'billing_period_start','billing_period_end'))
    or (table_name='customers' and column_name = 'helcim_customer_code')
union all
select 'COLLISION','function', p.proname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('touch_updated_at','cfg_bool','guard_service_plan_offer',
                     'guard_service_plan_agreement','guard_service_subscription',
                     'create_verify_session','read_verify_session','set_subscription_reminder')
union all
select 'COLLISION','app_config key', key
  from app_config
 where key in ('recurring_billing_enabled','service_plan_contract_mode',
               'service_plan_agreement_version','helcim_recurring_plan_id_expires')
union all
select 'COLLISION','storage bucket', id from storage.buckets where id='apex-agreements'
order by 1,2,3;

-- ── 3. Baseline counts — record these, they must not change ─────────────────
select 'BASELINE' as section, t as table_name, c as row_count from (
  select 'customers' t, count(*) c from customers
  union all select 'invoices',            count(*) from invoices
  union all select 'payments',            count(*) from payments
  union all select 'payment_events',      count(*) from payment_events
  union all select 'notification_outbox', count(*) from notification_outbox
  union all select 'audit_log',           count(*) from audit_log
) s order by table_name;

-- ── 4. Baseline financial state — must be byte-identical afterwards ─────────
select 'BASELINE-MONEY' as section, status, count(*) as invoices,
       sum(amount)::numeric(12,2) as total
  from invoices group by status order by status;

select 'BASELINE-MONEY' as section, kind, status, count(*) as rows,
       sum(amount_cents) as cents
  from payments group by kind, status order by kind, status;

-- ── 5. Fingerprint of the functions the migration must NOT touch ────────────
-- Record these hashes. Re-run section 5 after the migration: identical hashes
-- prove the one-time payment stack was not modified.
select 'FINGERPRINT' as section, p.proname,
       md5(pg_get_functiondef(p.oid)) as definition_md5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('recalc_invoice_status','notify_on_payment','notify_on_invoice',
                     'guard_payment','guard_tax_totals','enqueue_notification',
                     'write_audit','is_admin','create_checkout_session',
                     'read_checkout_session','quote_to_invoice')
 order by p.proname;

-- ── 6. Existing policies on money tables — must be unchanged afterwards ─────
select 'FINGERPRINT-RLS' as section, tablename, policyname, cmd
  from pg_policies
 where tablename in ('invoices','payments','payment_events','customers')
 order by tablename, policyname;

-- ── 7. Safety: is any invoice currently mid-flight? ─────────────────────────
-- Not a blocker, but do not run schema changes while a customer is inside the
-- Helcim modal. Expect 0 for the calmest possible migration window.
select 'IN-FLIGHT' as section, count(*) as live_checkout_attempts
  from payments
 where provider='helcim' and kind='payment'
   and status in ('initiated','pending','unknown')
   and initiated_at > now() - interval '1 hour';

-- ── 8. Confirm the private schema is still invisible to the API ─────────────
-- Expect: has_usage = f for both anon and authenticated.
select 'SECURITY' as section, r.rolname,
       has_schema_privilege(r.rolname,'private','usage') as has_usage
  from pg_roles r where r.rolname in ('anon','authenticated') order by r.rolname;


-- ── 9. Revision 2 additions — confirm none of these names are already taken ──
-- Expect: 0 rows.
select 'COLLISION-R2' as section, 'constraint' as kind, conname as name
  from pg_constraint
 where conname in ('uq_equipment_id_customer','uq_offer_chain','uq_agreement_chain',
                   'fk_offer_equipment_same_customer','fk_agreement_matches_offer_chain',
                   'fk_sub_matches_agreement_chain')
union all
select 'COLLISION-R2','trigger', tgname
  from pg_trigger
 where tgname in ('trg_validate_agreement','trg_validate_subscription',
                  'trg_no_delete_agreement','trg_events_append_only','trg_no_delete_billed_sub')
union all
select 'COLLISION-R2','function', p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname='public'
   and p.proname in ('assert_transition','validate_agreement_against_offer',
                     'validate_subscription_against_agreement','forbid_agreement_delete',
                     'forbid_event_mutation','forbid_billed_subscription_delete',
                     'consume_verify_session','purge_expired_verify_sessions',
                     'accept_offer_and_sign_agreement','create_subscription_from_agreement')
order by 1,2,3;
