-- =============================================================================
-- APEX V24.5 — 0009_recurring_admin_ops.sql
-- Additive. Safe to re-run. Does NOT enable recurring billing.
--
-- Adds only what the unblocked admin work needs:
--   1. a single-row reconciliation health marker
--   2. pause / resume / term-change / retry AUDIT columns
--   3. subscription lifecycle notification triggers
--
-- =============================================================================
-- WHAT THIS DOES NOT DO
-- =============================================================================
--   * no DROP, no TRUNCATE, no DELETE, no UPDATE of any existing business row
--   * no change to any Phase A table, constraint, index or RLS policy
--   * no weakening of the composite-FK contract chain
--   * no CREATE OR REPLACE of any pre-existing function
--     (notify_on_payment / notify_on_invoice are 0008's business, not this file's)
--   * NO ASSUMPTION ABOUT HELCIM PATCH SEMANTICS. The pause/resume/term columns
--     added here are audit fields written by Apex AFTER a provider call is
--     confirmed. Nothing in this migration implies the provider call exists yet
--     or what its request body looks like.
--
-- The only DROPs are `IF EXISTS` on this migration's own triggers/policies.
-- =============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. RECONCILIATION HEALTH
--
-- ONE row, updated in place. Not an append-only log: the reconciler runs every
-- 15 minutes forever, and a row per run would be ~35k rows a year of noise for
-- a question that only ever has one current answer.
--
-- This exists because of a specific, real failure mode. RECURRING_CRON_SETUP.sql
-- ships with a literal `<RECONCILE_WORKER_KEY>` placeholder. If it is run
-- unedited, or the key is rotated without updating the cron job,
-- subscription-reconcile returns 403 and reconciliation silently stops — while
-- Helcim keeps billing customers every month. Apex's ledger would quietly drift
-- from reality with nothing on screen to indicate it.
--
-- `last_forbidden_at` is what makes that visible: a 403 is recorded even though
-- the caller never got past the door.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists recurring_sync_health (
  id                        boolean primary key default true check (id),   -- exactly one row
  last_attempt_at           timestamptz,
  last_success_at           timestamptz,
  last_failure_at           timestamptz,
  last_forbidden_at         timestamptz,   -- a caller failed the worker-key check
  last_error                text,
  last_run_source           text,          -- 'cron' | 'admin' | 'unknown'
  consecutive_failures      integer not null default 0 check (consecutive_failures >= 0),
  subscriptions_scanned     integer not null default 0,
  invoices_created          integer not null default 0,
  payments_created          integer not null default 0,
  payments_updated          integer not null default 0,
  ambiguous_transactions    integer not null default 0,
  provider_errors           integer not null default 0,
  updated_at                timestamptz not null default now()
);

insert into recurring_sync_health (id) values (true) on conflict (id) do nothing;

comment on table recurring_sync_health is
  'Single-row health marker for recurring reconciliation. One row, updated in place. last_forbidden_at catches the worker-key misconfiguration that would otherwise stop reconciliation silently.';

alter table recurring_sync_health enable row level security;

drop policy if exists "sync_health_admin_read" on recurring_sync_health;
create policy "sync_health_admin_read" on recurring_sync_health
  for select using (is_admin());

revoke insert, update, delete, truncate on recurring_sync_health from anon, authenticated;
revoke all on recurring_sync_health from anon;
grant select on recurring_sync_health to authenticated;   -- RLS still admin-only
grant all on recurring_sync_health to service_role;

-- Health is written by the reconciler (service_role) through this function so
-- the counters and the failure streak stay consistent in one place.
create or replace function public.record_sync_health(
  p_source text,
  p_ok boolean,
  p_error text default null,
  p_scanned integer default 0,
  p_invoices integer default 0,
  p_payments_created integer default 0,
  p_payments_updated integer default 0,
  p_ambiguous integer default 0,
  p_provider_errors integer default 0)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into recurring_sync_health (id) values (true) on conflict (id) do nothing;

  update recurring_sync_health set
    last_attempt_at        = now(),
    last_run_source        = coalesce(nullif(trim(p_source), ''), 'unknown'),
    last_success_at        = case when p_ok then now() else last_success_at end,
    last_failure_at        = case when p_ok then last_failure_at else now() end,
    last_error             = case when p_ok then null else left(coalesce(p_error, 'unspecified'), 500) end,
    consecutive_failures   = case when p_ok then 0 else consecutive_failures + 1 end,
    subscriptions_scanned  = case when p_ok then p_scanned          else subscriptions_scanned end,
    invoices_created       = case when p_ok then p_invoices         else invoices_created end,
    payments_created       = case when p_ok then p_payments_created else payments_created end,
    payments_updated       = case when p_ok then p_payments_updated else payments_updated end,
    ambiguous_transactions = case when p_ok then p_ambiguous        else ambiguous_transactions end,
    provider_errors        = case when p_ok then p_provider_errors  else provider_errors end,
    updated_at             = now()
  where id;
end $$;
revoke all on function public.record_sync_health(text,boolean,text,integer,integer,integer,integer,integer,integer)
  from public, anon, authenticated;
grant execute on function public.record_sync_health(text,boolean,text,integer,integer,integer,integer,integer,integer)
  to service_role;

-- Recorded separately because a rejected caller never reaches the main path.
create or replace function public.record_sync_forbidden()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into recurring_sync_health (id) values (true) on conflict (id) do nothing;
  update recurring_sync_health
     set last_forbidden_at = now(),
         last_error = 'A caller was rejected by the worker-key check. If this is the cron job, RECURRING_CRON_SETUP.sql still contains the <RECONCILE_WORKER_KEY> placeholder or the key was rotated.',
         updated_at = now()
   where id;
end $$;
revoke all on function public.record_sync_forbidden() from public, anon, authenticated;
grant execute on function public.record_sync_forbidden() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. LIFECYCLE AUDIT COLUMNS
--
-- All nullable, all additive. These record what Apex did AFTER a provider
-- action was confirmed. Adding the column does not imply the action is
-- implemented — pause, resume and term change are still blocked on the
-- verified Helcim PATCH schema.
-- ─────────────────────────────────────────────────────────────────────────────
alter table service_subscriptions
  add column if not exists paused_at            timestamptz,
  add column if not exists paused_by            uuid,
  add column if not exists pause_reason         text,
  add column if not exists resumed_at           timestamptz,
  add column if not exists resumed_by           uuid,
  -- Term changes. original_term_months is stamped once, the first time a term
  -- change happens, so the signed term is still legible afterwards.
  add column if not exists original_term_months integer,
  add column if not exists term_changed_at      timestamptz,
  add column if not exists term_changed_by      uuid,
  add column if not exists term_change_reason   text,
  -- Retry of a declined provider payment.
  add column if not exists last_retry_at        timestamptz,
  add column if not exists last_retry_by        uuid,
  add column if not exists last_retry_payment_number integer,
  add column if not exists last_retry_result    text;

comment on column service_subscriptions.original_term_months is
  'The term the customer actually signed, stamped the first time the term is changed. Never overwritten after that.';
comment on column service_subscriptions.paused_at is
  'Set only after Helcim confirms the pause. Apex must never claim paused before the provider agrees.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RETRY AUDIT ON THE LEDGER
--
-- A retried cycle keeps its original payment row — the ledger stays append-only
-- and the amount never changes. These columns record that a retry happened
-- against it and what the provider said.
-- ─────────────────────────────────────────────────────────────────────────────
alter table payments
  add column if not exists retry_attempted_at timestamptz,
  add column if not exists retry_attempt_count integer not null default 0;

do $$
begin
  alter table payments drop constraint if exists ck_pay_retry_count;
  alter table payments add  constraint ck_pay_retry_count check (retry_attempt_count >= 0);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SUBSCRIPTION LIFECYCLE NOTIFICATIONS
--
-- Fires on status transitions only. Templates for all five states ship with
-- this release, but paused/resumed cannot occur until the provider PATCH work
-- is unblocked — so those branches are inert today rather than speculative.
--
-- Exactly-once comes from the unique event_key plus enqueue_notification's
-- `on conflict do nothing`. The key includes the target status, so a
-- subscription that legitimately goes active -> past_due -> active queues one
-- notice per distinct transition and never duplicates within one.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.notify_on_subscription_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c   record;
  e   record;
  ev  text;
  pl  jsonb;
begin
  if old.status is not distinct from new.status then return new; end if;

  ev := case new.status
          when 'active'    then case when old.status in ('setup_pending','method_verified','failed_setup')
                                     then 'subscription_activated' else null end
          when 'paused'    then 'subscription_paused'
          when 'cancelled' then 'subscription_cancelled'
          when 'completed' then 'subscription_term_ended'
          else null
        end;

  -- active <- paused is a resume, which is a different message from activation.
  if new.status = 'active' and old.status = 'paused' then ev := 'subscription_resumed'; end if;
  if ev is null then return new; end if;

  select id, email, name, company into c from customers where id = new.customer_id;
  select unit_number, year, make, model, serial_number, service_location
    into e from customer_equipment where id = new.equipment_id;

  pl := jsonb_build_object(
    'subscription_id',   new.id,
    'agreement_id',      new.agreement_id,
    'customer_name',     c.name,
    'company',           c.company,
    'customer_email',    c.email,
    'unit_number',       e.unit_number,
    'equipment',         trim(both ' ' from concat_ws(' ', e.year, e.make, e.model)),
    'serial_number',     e.serial_number,
    'service_location',  e.service_location,
    'payment_method',    new.payment_method,
    'monthly_total_cents', new.recurring_total_cents,
    'term_months',       new.term_months,
    'times_billed',      new.times_billed,
    'max_cycles',        new.max_cycles,
    'activation_date',   new.activation_date,
    'next_billing_date', new.next_billing_date,
    'previous_status',   old.status,
    'new_status',        new.status,
    'reason',            case new.status
                           when 'paused'    then new.pause_reason
                           when 'cancelled' then new.cancel_reason
                           else null end
  );

  if c.email is not null then
    perform enqueue_notification(ev || ':cust:' || new.id || ':' || new.status,
      ev, c.email, 'service_subscription', new.id::text, pl);
  end if;
  perform enqueue_notification(ev || ':admin:' || new.id || ':' || new.status,
    ev || '_admin', cfg('admin_notification_email'), 'service_subscription', new.id::text, pl);

  return new;
end $$;
revoke all on function public.notify_on_subscription_status() from public, anon, authenticated;

drop trigger if exists trg_notify_subscription_status on service_subscriptions;
create trigger trg_notify_subscription_status
  after update on service_subscriptions
  for each row execute function public.notify_on_subscription_status();

commit;

-- =============================================================================
-- READ-ONLY VERIFY
-- =============================================================================
select 'recurring_sync_health row' as check, count(*) as found, 1 as expected from recurring_sync_health;

select 'lifecycle audit columns' as check, count(*) as found, 13 as expected
  from information_schema.columns
 where table_name = 'service_subscriptions'
   and column_name in ('paused_at','paused_by','pause_reason','resumed_at','resumed_by',
                       'original_term_months','term_changed_at','term_changed_by','term_change_reason',
                       'last_retry_at','last_retry_by','last_retry_payment_number','last_retry_result');

select 'payments retry columns' as check, count(*) as found, 2 as expected
  from information_schema.columns
 where table_name = 'payments' and column_name in ('retry_attempted_at','retry_attempt_count');

select 'lifecycle trigger' as check, count(*) as found, 1 as expected
  from pg_trigger where tgname = 'trg_notify_subscription_status';

-- Still off. Nothing in 0009 enables recurring billing.
select key, value from app_config
 where key in ('recurring_billing_enabled','service_plan_contract_mode') order by key;
