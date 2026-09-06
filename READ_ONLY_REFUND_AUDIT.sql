-- APEX PAYMENT / REFUND READ-ONLY AUDIT
-- Safe to run in Supabase SQL Editor. It makes NO changes.

-- 1) Confirm the payments ledger has the columns the refund/void implementation uses.
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'payments'
  and column_name in (
    'id','invoice_id','customer_id','provider','kind','method','status',
    'amount_cents','fee_cents','total_charged_cents','provider_transaction_id',
    'idempotency_key','refund_of','recorded_by','notes',
    'approved_at','settled_at','completed_at','failure_category'
  )
order by column_name;

-- 2) Show payments-table constraints so we can verify allowed kinds/statuses and refund linkage.
select
  c.conname,
  pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_class t on t.oid = c.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname = 'payments'
order by c.conname;

-- 3) Show the authoritative invoice recalculation / payment notification functions.
-- Send the output back for review before the first live refund/void test.
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('recalc_invoice_status','notify_on_payment','guard_payment')
order by p.proname;

-- 4) Show triggers on payments/invoices, including the functions they call.
select
  event_object_table as table_name,
  trigger_name,
  action_timing,
  event_manipulation,
  action_statement
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table in ('payments','invoices')
order by event_object_table, trigger_name, event_manipulation;
