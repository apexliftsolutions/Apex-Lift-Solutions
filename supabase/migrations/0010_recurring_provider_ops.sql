-- =============================================================================
-- APEX V24.7 — 0010_recurring_provider_ops.sql
-- Additive. Safe to re-run. Does NOT enable recurring billing.
--
-- One thing only: a durable record of manual retry attempts, so a 25-character
-- idempotency key can be persisted BEFORE the provider is called and reused
-- afterwards.
--
-- WHY A TABLE AND NOT A COLUMN
-- ---------------------------------------------------------------------------
-- The key has to be scoped to (subscription, payment cycle, ATTEMPT). A column
-- on payments would hold only the latest key and would lose the distinction
-- between "this attempt is still unresolved" and "this attempt finished and the
-- admin has deliberately started another". That distinction is the entire point:
-- it is what stops a double-click, a page reload, a lost HTTP response or an
-- Edge Function retry from turning one Retry press into two charges.
--
-- 0009 is UNCHANGED by this file.
--
-- NO DROP / TRUNCATE / DELETE / payment-history rewrite / weakened FK.
-- =============================================================================

begin;

create table if not exists subscription_retry_attempts (
  id               uuid primary key default gen_random_uuid(),
  subscription_id  uuid not null references service_subscriptions(id) on delete restrict,
  payment_number   integer not null check (payment_number >= 1),

  -- Helcim requires exactly 25 alphanumeric characters on subscription
  -- endpoints. Enforced here so a malformed key can never reach the provider.
  idempotency_key  text not null unique check (idempotency_key ~ '^[A-Za-z0-9]{25}$'),

  -- in_flight : sent, or attempted with an unresolved outcome. The key is
  --             REUSED on the next press; a new one is never minted.
  -- submitted : provider definitively accepted the request.
  -- rejected  : provider definitively refused (auth/permission/invalid). Safe
  --             to start a fresh attempt.
  -- superseded: provider state moved on its own; this attempt is closed out.
  status           text not null default 'in_flight'
                   check (status in ('in_flight','submitted','rejected','superseded')),

  attempt_no       integer not null default 1 check (attempt_no >= 1),
  requested_by     uuid,
  provider_http    integer,
  provider_category text,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index if not exists ix_retry_subscription
  on subscription_retry_attempts (subscription_id, payment_number, created_at desc);

-- AT MOST ONE unresolved attempt per cycle, ever. This is the constraint that
-- makes the double-charge impossible rather than merely unlikely: a second
-- concurrent Retry cannot insert a second in-flight row, so it cannot mint a
-- second idempotency key.
create unique index if not exists uq_retry_one_in_flight
  on subscription_retry_attempts (subscription_id, payment_number)
  where status = 'in_flight';

comment on table subscription_retry_attempts is
  'Idempotency keys for manual retries of declined recurring payments. The key is written BEFORE the provider call and reused until the attempt has a definitive outcome.';
comment on column subscription_retry_attempts.status is
  'in_flight = key must be REUSED, never regenerated. Only a definitive outcome permits a new attempt.';

alter table subscription_retry_attempts enable row level security;

drop policy if exists "retry_admin_read" on subscription_retry_attempts;
create policy "retry_admin_read" on subscription_retry_attempts
  for select using (is_admin());

revoke insert, update, delete, truncate on subscription_retry_attempts from anon, authenticated;
revoke all on subscription_retry_attempts from anon;
grant select on subscription_retry_attempts to authenticated;   -- RLS admin-only
grant all on subscription_retry_attempts to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Term-change provenance.
--
-- 0009 already added term_changed_at / _by / term_change_reason and
-- original_term_months. These two record the actual numbers so an audit can
-- read the change without reconstructing it from event JSON.
-- ─────────────────────────────────────────────────────────────────────────────
alter table service_subscriptions
  add column if not exists previous_max_cycles integer,
  add column if not exists term_change_count integer not null default 0;

do $$
begin
  alter table service_subscriptions drop constraint if exists ck_sub_term_change_count;
  alter table service_subscriptions add  constraint ck_sub_term_change_count
    check (term_change_count >= 0);
end $$;

commit;

-- =============================================================================
-- READ-ONLY VERIFY
-- =============================================================================
select 'retry attempts table' as check, count(*) as found, 1 as expected
  from information_schema.tables
 where table_schema='public' and table_name='subscription_retry_attempts';

select 'one-in-flight guard' as check, count(*) as found, 1 as expected
  from pg_indexes where indexname='uq_retry_one_in_flight';

select 'term provenance columns' as check, count(*) as found, 2 as expected
  from information_schema.columns
 where table_name='service_subscriptions'
   and column_name in ('previous_max_cycles','term_change_count');

select key, value from app_config
 where key in ('recurring_billing_enabled','service_plan_contract_mode') order by key;
