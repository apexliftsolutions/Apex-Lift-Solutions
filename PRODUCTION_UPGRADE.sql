-- =============================================================================
-- APEX LIFT SOLUTIONS — PRODUCTION UPGRADE  (NON-DESTRUCTIVE)
--
-- Run this on the LIVE database. It contains no DROP TABLE, no TRUNCATE, and
-- no DELETE. Existing customers, quotes, invoices, service history, service
-- requests, uploads and the admin account are all preserved.
--
-- It DOES drop POLICIES and recreate them. That removes access rules, not data,
-- and is the whole point: several current policies are unsafe.
--
-- Safe to re-run. Wrapped so a failure rolls the whole thing back.
--
--   BEFORE RUNNING:  Supabase Dashboard → Database → Backups → take a manual
--                    backup. Do not skip this.
-- =============================================================================

begin;

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. HELPERS  (create-or-replace only — nothing dropped)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'admin@apexliftsolutionsusa.com'
$$;
grant execute on function is_admin() to anon, authenticated;

create or replace function new_id(prefix text) returns text
language sql volatile as $$
  select prefix || '-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10))
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ADD MISSING COLUMNS  (existing rows keep their values)
-- ─────────────────────────────────────────────────────────────────────────────
alter table customers        add column if not exists phone      text;
alter table customers        add column if not exists since      text;

alter table quotes           add column if not exists attachments        jsonb;
alter table quotes           add column if not exists invoiced           boolean not null default false;
alter table quotes           add column if not exists hidden_by_customer boolean not null default false;
alter table quotes           add column if not exists company            text;
alter table quotes           add column if not exists equipment          text;
alter table quotes           add column if not exists items              jsonb;
alter table quotes           add column if not exists notes              text;
alter table quotes           add column if not exists responded_at       timestamptz;

alter table invoices         add column if not exists items       jsonb;
alter table invoices         add column if not exists company     text;
alter table invoices         add column if not exists quote_id    text;
alter table invoices         add column if not exists due         timestamptz;
alter table invoices         add column if not exists paid_at     timestamptz;
alter table invoices         add column if not exists paid_via    text;
alter table invoices         add column if not exists payment_id  uuid;

alter table service_history  add column if not exists customer_name text;
alter table service_history  add column if not exists company       text;
alter table service_history  add column if not exists amount        numeric(10,2);
alter table service_history  add column if not exists paid          boolean not null default false;
alter table service_history  add column if not exists paid_at       timestamptz;
alter table service_history  add column if not exists invoice_id    text;

-- service_requests may not exist on older installs
create table if not exists service_requests (
  id              text primary key default new_id('REQ'),
  customer_id     uuid not null references customers(id) on delete cascade,
  customer_email  text not null,
  customer_name   text,
  company         text,
  equipment       text,
  issue_type      text,
  description     text not null,
  urgency         text not null default 'normal',
  attachments     jsonb,
  status          text not null default 'open',
  created_at      timestamptz not null default now()
);
alter table service_requests add column if not exists attachments jsonb;

-- Wider IDs for NEW rows only. Existing primary keys are untouched.
alter table quotes           alter column id set default new_id('Q');
alter table invoices         alter column id set default new_id('INV');
alter table service_history  alter column id set default new_id('SVC');
alter table service_requests alter column id set default new_id('REQ');


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. INVOICE STATUS VOCABULARY  (widen the constraint, keep existing values)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare c text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'invoices'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%status%'
  loop execute format('alter table invoices drop constraint %I', c); end loop;
end $$;

update invoices set status = 'unpaid' where status is null or status = '';

alter table invoices add constraint invoices_status_check check (status in
  ('unpaid','payment_pending','paid','partially_refunded','refunded','void','hidden'));


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. NEW TABLES  (create if absent — never replaced)
-- ─────────────────────────────────────────────────────────────────────────────
create schema if not exists private;
revoke all on schema private from anon, authenticated, public;

create table if not exists private.helcim_checkout_session (
  checkout_token text primary key,
  secret_token   text not null,
  attempt_id     uuid not null,
  created_at     timestamptz not null default now()
);

create table if not exists payments (
  id                      uuid primary key default gen_random_uuid(),
  invoice_id              text not null references invoices(id) on delete restrict,
  customer_id             uuid not null references customers(id) on delete restrict,
  provider                text not null check (provider in ('helcim','manual')),
  kind                    text not null default 'payment' check (kind in ('payment','refund','reversal')),
  method                  text check (method in ('card','ach','check','cash','bank_transfer','terminal','other')),
  amount_cents            bigint not null check (amount_cents > 0),
  currency                text not null default 'USD',
  status                  text not null check (status in ('initiated','pending','succeeded','failed','unknown','voided')),
  idempotency_key         text,
  provider_transaction_id text,
  provider_invoice_number text,
  checkout_token          text,
  method_display          text,
  failure_category        text,
  reference               text,
  notes                   text,
  recorded_by             uuid,
  refund_of               uuid references payments(id),
  initiated_at            timestamptz not null default now(),
  approved_at             timestamptz,
  settled_at              timestamptz,
  declined_at             timestamptz,
  created_at              timestamptz not null default now(),
  completed_at            timestamptz
);
create unique index if not exists uq_pay_provider_txn on payments (provider, provider_transaction_id) where provider_transaction_id is not null;
create unique index if not exists uq_pay_idem        on payments (customer_id, idempotency_key)        where idempotency_key is not null;
create unique index if not exists uq_pay_inflight    on payments (invoice_id)                          where provider = 'helcim' and status in ('initiated','pending','unknown') and kind = 'payment';
create index if not exists idx_pay_customer on payments(customer_id);
create index if not exists idx_pay_invoice  on payments(invoice_id);

create table if not exists payment_events (
  id bigserial primary key, payment_id uuid references payments(id) on delete cascade,
  invoice_id text, event text not null, source text not null, detail jsonb,
  created_at timestamptz not null default now());
create index if not exists idx_pev_payment on payment_events(payment_id);

create table if not exists payment_webhook_events (
  webhook_id text primary key, event_type text, payload jsonb,
  received_at timestamptz not null default now(), processed_at timestamptz, result text);

create table if not exists notification_outbox (
  id bigserial primary key, event_key text not null unique, event_type text not null,
  recipient text not null, entity_type text, entity_id text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempt_count int not null default 0, last_error text, provider_msg_id text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(), sent_at timestamptz);
create index if not exists idx_outbox_due on notification_outbox(status, next_attempt_at);

create table if not exists contact_submissions (
  id uuid primary key default gen_random_uuid(), form text not null, payload jsonb not null,
  ip_hash text, created_at timestamptz not null default now());

create table if not exists rate_limits (
  bucket text primary key, hits int not null default 0,
  window_start timestamptz not null default now());

create table if not exists audit_log (
  id bigserial primary key, actor_email text, actor_id uuid, action text not null,
  table_name text, record_id text, detail jsonb, created_at timestamptz not null default now());

create table if not exists activity_log (
  id bigserial primary key, actor_id uuid, action text not null, detail text,
  created_at timestamptz not null default now());

create table if not exists app_config (key text primary key, value text not null);
insert into app_config values
  ('admin_notification_email',   'admin@apexliftsolutionsusa.com'),
  ('service_notification_email', 'apexliftsolutions1@gmail.com')
on conflict (key) do nothing;

create or replace function cfg(k text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select value from app_config where key = k $$;

do $$ begin
  alter table invoices add constraint fk_invoice_payment
    foreign key (payment_id) references payments(id) on delete set null;
exception when duplicate_object then null; end $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. BACKFILL EXISTING PAID INVOICES INTO THE LEDGER
--
--    Critical ordering: this runs BEFORE recalc_invoice_status() and BEFORE the
--    notification triggers exist. Without it, recalc would see zero payments and
--    flip every historical paid invoice back to 'unpaid'. Because the triggers
--    aren't installed yet, this backfill also sends no email.
-- ─────────────────────────────────────────────────────────────────────────────
insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents,
                      currency, status, notes, approved_at, settled_at, completed_at, created_at)
select i.id, i.customer_id, 'manual', 'payment', 'other',
       greatest(round(i.amount * 100)::bigint, 1), 'USD', 'succeeded',
       'Backfilled during upgrade — invoice was already marked paid before the payment ledger existed.',
       coalesce(i.paid_at, i.created_at), coalesce(i.paid_at, i.created_at),
       coalesce(i.paid_at, i.created_at), coalesce(i.paid_at, i.created_at)
from invoices i
where i.status = 'paid'
  and i.amount > 0
  and not exists (select 1 from payments p where p.invoice_id = i.id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. NORMALISE ATTACHMENT URLS → STORAGE PATHS
--
--    The old code stored full public URLs. The new code stores paths and mints
--    signed URLs. Convert in place so existing photos keep working after the
--    bucket goes private. Idempotent: rows already holding paths are untouched.
-- ─────────────────────────────────────────────────────────────────────────────
update quotes set attachments = (
  select jsonb_agg(
    case when v like 'http%' then regexp_replace(v, '^.*/apex-uploads/', '') else v end)
  from jsonb_array_elements_text(attachments) v)
where attachments is not null
  and jsonb_typeof(attachments) = 'array'
  and attachments::text like '%http%';

update service_requests set attachments = (
  select jsonb_agg(
    case when v like 'http%' then regexp_replace(v, '^.*/apex-uploads/', '') else v end)
  from jsonb_array_elements_text(attachments) v)
where attachments is not null
  and jsonb_typeof(attachments) = 'array'
  and attachments::text like '%http%';


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. REPLACE UNSAFE POLICIES  (drops rules, not rows)
-- ─────────────────────────────────────────────────────────────────────────────
alter table customers        enable row level security;
alter table quotes           enable row level security;
alter table invoices         enable row level security;
alter table service_requests enable row level security;
alter table service_history  enable row level security;
alter table payments         enable row level security;
alter table payment_events   enable row level security;
alter table payment_webhook_events enable row level security;
alter table notification_outbox    enable row level security;
alter table contact_submissions    enable row level security;
alter table rate_limits            enable row level security;
alter table audit_log              enable row level security;
alter table activity_log           enable row level security;
alter table app_config             enable row level security;

-- Remove EVERY existing policy on the business tables, then rebuild known-good
-- ones. This is what closes the customer-can-update holes.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('customers','quotes','invoices','service_requests',
                               'service_history','payments','payment_events',
                               'payment_webhook_events','notification_outbox',
                               'contact_submissions','rate_limits','audit_log',
                               'activity_log','app_config')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;

create policy "cust_admin_all"  on customers for all    using (is_admin()) with check (is_admin());
create policy "cust_read_own"   on customers for select using (auth.uid() = id);
create policy "cust_insert_own" on customers for insert with check (auth.uid() = id);

create policy "quote_admin_all" on quotes for all    using (is_admin()) with check (is_admin());
create policy "quote_read_own"  on quotes for select using (auth.uid() = customer_id);

create policy "inv_admin_all"   on invoices for all    using (is_admin()) with check (is_admin());
create policy "inv_read_own"    on invoices for select using (auth.uid() = customer_id);

create policy "req_admin_all"   on service_requests for all    using (is_admin()) with check (is_admin());
create policy "req_read_own"    on service_requests for select using (auth.uid() = customer_id);
create policy "req_insert_own"  on service_requests for insert with check (auth.uid() = customer_id and status = 'open');

create policy "hist_admin_all"  on service_history for all    using (is_admin()) with check (is_admin());
create policy "hist_read_own"   on service_history for select using (auth.uid() = customer_id);

create policy "pay_admin_read"  on payments for select using (is_admin());
create policy "pay_read_own"    on payments for select using (auth.uid() = customer_id);

create policy "pev_admin_read"  on payment_events for select using (is_admin());
create policy "pev_read_own"    on payment_events for select
  using (exists (select 1 from payments p where p.id = payment_id and p.customer_id = auth.uid()));

create policy "wh_admin_read"      on payment_webhook_events for select using (is_admin());
create policy "outbox_admin_read"  on notification_outbox    for select using (is_admin());
create policy "contact_admin_read" on contact_submissions    for select using (is_admin());
create policy "audit_admin_read"   on audit_log              for select using (is_admin());
create policy "activity_admin_read"on activity_log           for select using (is_admin());
create policy "cfg_admin_all"      on app_config for all using (is_admin()) with check (is_admin());
-- rate_limits: no policies at all — service role only.


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. CONTROLLED WRITE PATHS (replace the removed UPDATE policies)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function update_my_profile(p_name text, p_company text, p_phone text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  update customers
     set name    = coalesce(nullif(trim(p_name),''),    name),
         company = coalesce(nullif(trim(p_company),''), company),
         phone   = coalesce(nullif(trim(p_phone),''),   phone)
   where id = auth.uid();
end $$;
revoke all on function update_my_profile(text,text,text) from public;
grant execute on function update_my_profile(text,text,text) to authenticated;

create or replace function respond_to_quote(p_quote_id text, p_response text)
returns quotes language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_response not in ('approved','declined') then raise exception 'Invalid response'; end if;
  select * into q from quotes where id = p_quote_id for update;
  if not found or q.customer_id <> auth.uid() then raise exception 'Quote not found'; end if;
  if q.status <> 'pending' then raise exception 'This quote has already been responded to'; end if;
  update quotes set status = p_response, responded_at = now() where id = p_quote_id returning * into q;
  return q;
end $$;
revoke all on function respond_to_quote(text,text) from public;
grant execute on function respond_to_quote(text,text) to authenticated;

create or replace function hide_declined_quote(p_quote_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update quotes set hidden_by_customer = true
   where id = p_quote_id and customer_id = auth.uid() and status = 'declined';
end $$;
revoke all on function hide_declined_quote(text) from public;
grant execute on function hide_declined_quote(text) to authenticated;

-- Self-registration identity is derived server-side. A browser may not choose
-- who it claims to be: id comes from auth.uid(), email from the verified JWT
-- claim, and status is always 'pending'. Admin inserts are exempt.
create or replace function force_signup_identity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if is_admin() then return new; end if;
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  new.id     := auth.uid();
  new.email  := lower(coalesce(auth.jwt() ->> 'email', new.email));
  new.status := 'pending';
  return new;
end $$;
drop trigger if exists trg_force_pending on customers;
drop trigger if exists trg_signup_identity on customers;
create trigger trg_signup_identity before insert on customers
  for each row execute function force_signup_identity();

-- A service request carries the submitter's identity, and that identity is read
-- from their own customers row -- never from the request body. Customer A cannot
-- construct a request that appears to come from Customer B.
create or replace function force_request_identity() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare c customers;
begin
  if is_admin() then return new; end if;
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into c from customers where id = auth.uid();
  if not found then raise exception 'No customer profile'; end if;
  new.customer_id    := c.id;
  new.customer_email := c.email;
  new.customer_name  := c.name;
  new.company        := c.company;
  new.status         := 'open';          -- customers cannot open a request as 'quoted'/'closed'
  return new;
end $$;

drop trigger if exists trg_request_identity on service_requests;
create trigger trg_request_identity before insert on service_requests
  for each row execute function force_request_identity();


create or replace function guard_payment() returns trigger language plpgsql as $$
begin
  if old.amount_cents is distinct from new.amount_cents then
    raise exception 'payment amount is immutable'; end if;
  if old.status = 'succeeded' and new.status is distinct from 'succeeded' then
    raise exception 'a succeeded payment cannot be reopened — record a refund row instead'; end if;
  return new;
end $$;
drop trigger if exists trg_guard_payment on payments;
create trigger trg_guard_payment before update on payments
  for each row execute function guard_payment();


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. DERIVED INVOICE STATE
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function recalc_invoice_status(p_invoice_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; paid_c bigint; refund_c bigint; pending_c bigint; total_c bigint;
begin
  select * into inv from invoices where id = p_invoice_id for update;
  if not found or inv.status in ('void','hidden') then return; end if;
  total_c := round(inv.amount * 100);
  select coalesce(sum(amount_cents),0) into paid_c    from payments where invoice_id = p_invoice_id and kind = 'payment' and status = 'succeeded';
  select coalesce(sum(amount_cents),0) into refund_c  from payments where invoice_id = p_invoice_id and kind in ('refund','reversal') and status = 'succeeded';
  select coalesce(sum(amount_cents),0) into pending_c from payments where invoice_id = p_invoice_id and kind = 'payment' and status in ('initiated','pending');
  if    paid_c - refund_c >= total_c and refund_c = 0 then
    update invoices set status='paid', paid_at=coalesce(paid_at, now()) where id=p_invoice_id;
  elsif paid_c >= total_c and refund_c >= paid_c then
    update invoices set status='refunded' where id=p_invoice_id;
  elsif paid_c >= total_c and refund_c > 0 then
    update invoices set status='partially_refunded' where id=p_invoice_id;
  elsif pending_c > 0 then
    update invoices set status='payment_pending', paid_at=null where id=p_invoice_id;
  else
    update invoices set status='unpaid', paid_at=null where id=p_invoice_id;
  end if;
end $$;
revoke all on function recalc_invoice_status(text) from public;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. AUDIT + NOTIFICATIONS
--     Installed AFTER the backfill so historical rows generate no email.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function write_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_log (actor_email, actor_id, action, table_name, record_id, detail)
  values (auth.jwt() ->> 'email', auth.uid(), tg_op, tg_table_name,
    coalesce(to_jsonb(coalesce(new, old)) ->> 'id', '(unknown)'),
    case when tg_op='DELETE' then jsonb_build_object('old', to_jsonb(old))
         when tg_op='INSERT' then jsonb_build_object('new', to_jsonb(new))
         else jsonb_build_object('old_status', to_jsonb(old)->>'status',
                                 'new_status', to_jsonb(new)->>'status') end);
  return coalesce(new, old);
end $$;
drop trigger if exists trg_audit_customers on customers;
drop trigger if exists trg_audit_quotes    on quotes;
drop trigger if exists trg_audit_invoices  on invoices;
drop trigger if exists trg_audit_payments  on payments;
create trigger trg_audit_customers after insert or update or delete on customers for each row execute function write_audit();
create trigger trg_audit_quotes    after insert or update or delete on quotes    for each row execute function write_audit();
create trigger trg_audit_invoices  after insert or update or delete on invoices  for each row execute function write_audit();
create trigger trg_audit_payments  after insert or update or delete on payments  for each row execute function write_audit();

create or replace function enqueue_notification(
  p_event_key text, p_event_type text, p_recipient text,
  p_entity_type text, p_entity_id text, p_payload jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into notification_outbox (event_key, event_type, recipient, entity_type, entity_id, payload)
  values (p_event_key, p_event_type, lower(p_recipient), p_entity_type, p_entity_id, coalesce(p_payload,'{}'::jsonb))
  on conflict (event_key) do nothing; $$;

create or replace function notify_on_quote() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare pl jsonb;
begin
  pl := jsonb_build_object('quote_id',new.id,'customer_name',new.customer_name,'company',new.company,
        'equipment',new.equipment,'description',new.description,'items',new.items,
        'amount',new.amount,'created_at',new.created_at,'responded_at',new.responded_at);
  if tg_op='INSERT' then
    perform enqueue_notification('quote_created:'||new.id,'quote_created',new.customer_email,'quote',new.id,pl);
  elsif tg_op='UPDATE' and old.status='pending' and new.status in ('approved','declined') then
    perform enqueue_notification('quote_'||new.status||':cust:'||new.id,'quote_'||new.status,new.customer_email,'quote',new.id,pl);
    perform enqueue_notification('quote_'||new.status||':admin:'||new.id,'quote_'||new.status||'_admin',cfg('admin_notification_email'),'quote',new.id,pl);
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_quote on quotes;
create trigger trg_notify_quote after insert or update on quotes for each row execute function notify_on_quote();

create or replace function notify_on_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op='INSERT' then
    perform enqueue_notification('invoice_created:'||new.id,'invoice_created',new.customer_email,'invoice',new.id,
      jsonb_build_object('invoice_id',new.id,'customer_name',new.customer_name,'company',new.company,
        'description',new.description,'items',new.items,'amount',new.amount,'due',new.due,
        'quote_id',new.quote_id,'created_at',new.created_at));
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_invoice on invoices;
create trigger trg_notify_invoice after insert on invoices for each row execute function notify_on_invoice();

create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; pl jsonb; ev text;
begin
  if tg_op='UPDATE' and old.status is not distinct from new.status then return new; end if;
  select * into inv from invoices where id = new.invoice_id;
  pl := jsonb_build_object('invoice_id',new.invoice_id,'customer_name',inv.customer_name,'company',inv.company,
        'amount',round(new.amount_cents/100.0,2),'method',new.method,'method_display',new.method_display,
        'reference',coalesce(new.provider_transaction_id,new.reference),'kind',new.kind,'provider',new.provider,
        'paid_at',coalesce(new.settled_at,new.approved_at,new.completed_at,now()));
  if    new.kind='payment' and new.status='succeeded' then ev := 'payment_received';
  elsif new.kind='payment' and new.status='pending' and new.method='ach' then ev := 'ach_submitted';
  elsif new.kind='payment' and new.status='failed' then ev := 'payment_declined';
  elsif new.kind in ('refund','reversal') and new.status='succeeded' then ev := 'payment_refunded';
  else return new; end if;
  perform enqueue_notification(ev||':cust:'||new.id,ev,inv.customer_email,'payment',new.id::text,pl);
  if ev <> 'payment_declined' then
    perform enqueue_notification(ev||':admin:'||new.id,ev||'_admin',cfg('admin_notification_email'),'payment',new.id::text,pl);
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_payment on payments;
create trigger trg_notify_payment after insert or update on payments for each row execute function notify_on_payment();

create or replace function notify_on_service_request() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform enqueue_notification('service_request:'||new.id,'service_request_admin',cfg('service_notification_email'),
    'service_request',new.id, jsonb_build_object('request_id',new.id,'customer_name',new.customer_name,
      'company',new.company,'customer_email',new.customer_email,'equipment',new.equipment,
      'issue_type',new.issue_type,'description',new.description,'urgency',new.urgency,
      'attachment_count',coalesce(jsonb_array_length(new.attachments),0)));
  return new;
end $$;
drop trigger if exists trg_notify_request on service_requests;
create trigger trg_notify_request after insert on service_requests for each row execute function notify_on_service_request();

create or replace function notify_on_registration() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform enqueue_notification('registration:'||new.id::text,'registration_admin',cfg('admin_notification_email'),
    'customer',new.id::text, jsonb_build_object('name',new.name,'email',new.email,'company',new.company,'phone',new.phone));
  return new;
end $$;
drop trigger if exists trg_notify_registration on customers;
create trigger trg_notify_registration after insert on customers for each row execute function notify_on_registration();

create or replace function notify_on_activation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status <> 'active' and new.status = 'active' then
    perform enqueue_notification('activated:'||new.id::text,'account_activated',new.email,
      'customer',new.id::text, jsonb_build_object('customer_name',new.name,'company',new.company));
  end if;
  return new;
end $$;
drop trigger if exists trg_notify_activation on customers;
create trigger trg_notify_activation after update on customers for each row execute function notify_on_activation();


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. STORAGE → PRIVATE  (files themselves are NOT touched)
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('apex-uploads','apex-uploads',false,10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','application/pdf'];

-- Remove ONLY Apex policies. A blanket loop over storage.objects would also
-- delete policies belonging to any other bucket in this project.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (
        -- known Apex policy names, current and from earlier iterations
        policyname in (
          'st_admin_all','st_cust_read_own','st_cust_write_own','st_cust_read_quote_att',
          'customer_upload','customer_upload_own_folder','customer_modify_own_folder',
          'public_storage_select','admin_upload','public_read','admin_delete',
          'Admin can upload','Public can read files','Admin can delete files',
          'Customers can upload service requests'
        )
        -- or any policy whose own definition scopes it to our bucket
        or coalesce(qual, '')       like '%apex-uploads%'
        or coalesce(with_check, '') like '%apex-uploads%'
      )
  loop
    execute format('drop policy if exists %I on storage.objects', p.policyname);
  end loop;
end $$;

create policy "st_admin_all" on storage.objects for all
  using (bucket_id='apex-uploads' and is_admin()) with check (bucket_id='apex-uploads' and is_admin());
create policy "st_cust_read_own" on storage.objects for select
  using (bucket_id='apex-uploads' and (storage.foldername(name))[1]='service-requests'
     and (storage.foldername(name))[2]=auth.uid()::text);
create policy "st_cust_write_own" on storage.objects for insert
  with check (bucket_id='apex-uploads' and (storage.foldername(name))[1]='service-requests'
     and (storage.foldername(name))[2]=auth.uid()::text);
create policy "st_cust_read_quote_att" on storage.objects for select
  using (bucket_id='apex-uploads' and (storage.foldername(name))[1]='quotes'
     and exists (select 1 from quotes q where q.id=(storage.foldername(name))[2] and q.customer_id=auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────────
-- CHECKOUT SESSION ACCESS
-- The table lives in `private`, which is never added to the Data API's exposed
-- schemas, so PostgREST cannot reach it at all. Edge Functions go through these
-- two functions instead, which are granted to service_role ONLY. secret_token
-- therefore never travels over PostgREST as a table row.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function create_checkout_session(
  p_checkout_token text, p_secret_token text, p_attempt_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into private.helcim_checkout_session (checkout_token, secret_token, attempt_id)
  values (p_checkout_token, p_secret_token, p_attempt_id)
  on conflict (checkout_token) do nothing;
end $$;

create or replace function read_checkout_session(p_checkout_token text)
returns table (secret_token text, attempt_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    select s.secret_token, s.attempt_id
    from private.helcim_checkout_session s
    where s.checkout_token = p_checkout_token;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- EXECUTE PRIVILEGES
--
-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default. For a
-- SECURITY DEFINER function that means any anon or authenticated caller runs it
-- with the owner's rights. Everything below is revoked first, then granted back
-- only where a specific role genuinely needs it.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Callable by nobody but the database itself (trigger bodies) ──────────────
-- Trigger functions are invoked by the trigger mechanism, which does not check
-- EXECUTE. Revoking costs nothing and closes direct-invocation entirely.
revoke all on function force_signup_identity()      from public, anon, authenticated;
revoke all on function force_request_identity()     from public, anon, authenticated;
revoke all on function guard_payment()              from public, anon, authenticated;
revoke all on function write_audit()                from public, anon, authenticated;
revoke all on function notify_on_quote()            from public, anon, authenticated;
revoke all on function notify_on_invoice()          from public, anon, authenticated;
revoke all on function notify_on_payment()          from public, anon, authenticated;
revoke all on function notify_on_service_request()  from public, anon, authenticated;
revoke all on function notify_on_registration()     from public, anon, authenticated;
revoke all on function notify_on_activation()       from public, anon, authenticated;

-- ── Server-side only ─────────────────────────────────────────────────────────
-- enqueue_notification: PUBLIC EXECUTE here would let any signed-in user send
-- arbitrary email to arbitrary recipients from the verified Apex domain.
revoke all on function enqueue_notification(text,text,text,text,text,jsonb) from public, anon, authenticated;
grant  execute on function enqueue_notification(text,text,text,text,text,jsonb) to service_role;

-- cfg: reads app_config, which holds internal notification addresses.
revoke all on function cfg(text) from public, anon, authenticated;
grant  execute on function cfg(text) to service_role;

-- recalc_invoice_status: writes invoice financial state. Edge Functions only.
revoke all on function recalc_invoice_status(text) from public, anon, authenticated;
grant  execute on function recalc_invoice_status(text) to service_role;

-- Checkout session accessors: service_role only. secret_token never reaches a browser.
revoke all on function create_checkout_session(text,text,uuid) from public, anon, authenticated;
revoke all on function read_checkout_session(text)             from public, anon, authenticated;
grant  execute on function create_checkout_session(text,text,uuid) to service_role;
grant  execute on function read_checkout_session(text)             to service_role;

-- ── Intentionally customer-callable RPCs ─────────────────────────────────────
revoke all on function update_my_profile(text,text,text) from public, anon;
revoke all on function respond_to_quote(text,text)       from public, anon;
revoke all on function hide_declined_quote(text)         from public, anon;
grant  execute on function update_my_profile(text,text,text) to authenticated, service_role;
grant  execute on function respond_to_quote(text,text)       to authenticated, service_role;
grant  execute on function hide_declined_quote(text)         to authenticated, service_role;

-- ── is_admin(): referenced inside RLS policy expressions ─────────────────────
-- A role that queries a protected table must be able to execute the function its
-- policy calls, so anon and authenticated need EXECUTE. It is safe: it reads only
-- the caller's own JWT claim and returns a boolean. It grants nothing.
revoke all on function is_admin() from public;
grant  execute on function is_admin() to anon, authenticated, service_role;

-- ── new_id(): used as a column DEFAULT, evaluated as the inserting role ──────
-- Not SECURITY DEFINER. Returns a random string and reads nothing.
revoke all on function new_id(text) from public;
grant  execute on function new_id(text) to anon, authenticated, service_role;

commit;

-- =============================================================================
-- VERIFY  (run these after COMMIT — none of them change anything)
-- =============================================================================
-- 1. Nothing was lost:
select 'customers' t, count(*) from customers
union all select 'quotes', count(*) from quotes
union all select 'invoices', count(*) from invoices
union all select 'service_requests', count(*) from service_requests
union all select 'service_history', count(*) from service_history;

-- 2. Every previously-paid invoice has a ledger row:
select count(*) as paid_invoices_without_payment
from invoices i where i.status='paid'
  and not exists (select 1 from payments p where p.invoice_id=i.id);   -- expect 0

-- 3. No customer can write anything (expect zero rows):
select tablename, policyname, cmd from pg_policies
where schemaname='public' and cmd in ('UPDATE','INSERT','DELETE','ALL')
  and qual not ilike '%is_admin%' and coalesce(with_check,'') not ilike '%is_admin%'
  and tablename in ('invoices','payments','quotes');

-- 4. Attachments are paths, not URLs (expect 0):
select count(*) from quotes where attachments::text like '%http%';
select count(*) from service_requests where attachments::text like '%http%';

-- 5. Bucket is private:
select id, public, file_size_limit from storage.buckets where id='apex-uploads';

-- =============================================================================
-- CRON  (run separately, AFTER enabling pg_cron + pg_net under Database → Extensions)
-- Fill in <PROJECT_REF> and the two worker keys. Note the different headers.
-- =============================================================================
-- select cron.schedule('apex-outbox', '* * * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/outbox-worker',
--     headers := '{"Content-Type":"application/json","x-outbox-key":"<OUTBOX_WORKER_KEY>"}'::jsonb,
--     body := '{}'::jsonb);
-- $$);
-- select cron.schedule('apex-ach-reconcile', '*/30 * * * *', $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/payment-reconcile',
--     headers := '{"Content-Type":"application/json","x-worker-key":"<RECONCILE_WORKER_KEY>"}'::jsonb,
--     body := '{}'::jsonb);
-- $$);
