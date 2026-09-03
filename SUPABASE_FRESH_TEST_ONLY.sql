-- =============================================================================
--
-- ############################################################################
-- ##  DESTRUCTIVE. FRESH / TEST INSTALLS ONLY.
-- ##  This file DROPS customers, quotes, invoices, service_history and
-- ##  service_requests. Running it on the live database destroys all data.
-- ##  To upgrade production use PRODUCTION_UPGRADE.sql instead.
-- ############################################################################
-- APEX LIFT SOLUTIONS — FRESH DATABASE
-- Run the ENTIRE file in Supabase → SQL Editor.
--
-- This DROPS every Apex table and rebuilds from zero. Only run it while there
-- is no customer data you need. Auth users are NOT deleted (they live in
-- auth.users, which this file never touches) — but their customer profile
-- rows are, so re-approve any test accounts afterwards.
--
-- Security model in one paragraph: customers can READ their own rows and
-- INSERT a service request. That is all. They cannot UPDATE anything directly.
-- Approve/decline a quote and edit a profile go through RPC functions that
-- permit exactly one thing each. Payment state and invoice state are written
-- only by Edge Functions running with the service role. Secrets live in a
-- schema the API never exposes. Every important write is audit-logged.
-- =============================================================================

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. DROP EVERYTHING (order matters for foreign keys)
-- ─────────────────────────────────────────────────────────────────────────────
drop table if exists helcim_webhook_events   cascade;
drop table if exists payment_webhook_events  cascade;
drop table if exists payment_events          cascade;
drop table if exists notification_outbox     cascade;
drop table if exists contact_submissions     cascade;
drop table if exists rate_limits             cascade;
drop table if exists payments                cascade;
drop table if exists payment_attempts        cascade;
drop table if exists audit_log               cascade;
drop table if exists activity_log            cascade;
drop table if exists service_requests        cascade;
drop table if exists service_history         cascade;
drop table if exists invoices                cascade;
drop table if exists quotes                  cascade;
drop table if exists customers               cascade;
drop schema if exists private                cascade;

drop function if exists is_admin()                              cascade;
drop function if exists respond_to_quote(text, text)            cascade;
drop function if exists update_my_profile(text, text, text)     cascade;
drop function if exists hide_declined_quote(text)               cascade;
drop function if exists write_audit()                           cascade;
drop function if exists guard_payment()                         cascade;
drop function if exists force_pending_on_signup()               cascade;
drop function if exists force_signup_identity()                 cascade;
drop function if exists force_request_identity()                cascade;
drop function if exists create_checkout_session(text,text,uuid) cascade;
drop function if exists read_checkout_session(text)             cascade;
drop function if exists cfg(text)                               cascade;
drop function if exists new_id(text)                            cascade;
drop function if exists enqueue_notification(text,text,text,text,text,jsonb) cascade;
drop function if exists notify_on_quote()                       cascade;
drop function if exists notify_on_invoice()                     cascade;
drop function if exists notify_on_payment()                     cascade;
drop function if exists notify_on_service_request()             cascade;
drop function if exists notify_on_registration()                cascade;
drop function if exists notify_on_activation()                  cascade;
drop function if exists recalc_invoice_status(text)             cascade;

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


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. HELPERS
-- ─────────────────────────────────────────────────────────────────────────────

-- Single source of truth for "is this the admin?".  Every policy calls this.
-- Changing the admin address later is a one-line edit here, not ten policies.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(auth.jwt() ->> 'email', '') = 'admin@apexliftsolutionsusa.com'
$$;
revoke all on function is_admin() from public;
grant execute on function is_admin() to anon, authenticated;

-- Wide random IDs. The old floor(random()*9000) gave 9,000 values as a PRIMARY
-- KEY — ~50% collision odds by 112 rows, and trivially enumerable.
create or replace function new_id(prefix text) returns text
language sql volatile as $$
  select prefix || '-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10))
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PRIVATE SCHEMA — the API cannot see this, regardless of RLS
-- ─────────────────────────────────────────────────────────────────────────────
create schema private;
revoke all on schema private from anon, authenticated, public;

create table private.helcim_checkout_session (
  checkout_token text primary key,
  secret_token   text not null,          -- proves a browser result is genuine
  attempt_id     uuid not null,
  created_at     timestamptz not null default now()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CUSTOMERS
-- ─────────────────────────────────────────────────────────────────────────────
create table customers (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique not null,
  name        text,
  company     text,
  phone       text,
  status      text not null default 'pending' check (status in ('pending','active','inactive')),
  since       text,
  created_at  timestamptz not null default now()
);
alter table customers enable row level security;

create policy "cust_admin_all"  on customers for all    using (is_admin()) with check (is_admin());
create policy "cust_read_own"   on customers for select using (auth.uid() = id);
create policy "cust_insert_own" on customers for insert with check (auth.uid() = id);
-- NO customer update policy. Profile edits go through update_my_profile().

-- Whatever status a signup sends, it lands as pending.
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

-- NOTE: the trigger that uses this function is created in section 7, immediately
-- after the service_requests table exists. Defining a trigger here would fail,
-- because this script drops and recreates that table further down.


-- The ONLY way a customer changes their own profile. Three fields, nothing else.
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


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. QUOTES
-- ─────────────────────────────────────────────────────────────────────────────
create table quotes (
  id              text primary key default new_id('Q'),
  customer_id     uuid not null references customers(id) on delete restrict,
  customer_email  text not null,
  customer_name   text,
  company         text,
  equipment       text,
  description     text,
  items           jsonb,
  attachments     jsonb,                 -- storage paths, NOT public URLs
  amount          numeric(10,2) not null default 0 check (amount >= 0),
  status          text not null default 'pending' check (status in ('pending','approved','declined')),
  invoiced        boolean not null default false,
  hidden_by_customer boolean not null default false,
  responded_at    timestamptz,
  notes           text,
  created_at      timestamptz not null default now()
);
create index on quotes(customer_id);
alter table quotes enable row level security;

create policy "quote_admin_all" on quotes for all    using (is_admin()) with check (is_admin());
create policy "quote_read_own"  on quotes for select using (auth.uid() = customer_id);
-- NO customer update policy. Approve/decline goes through respond_to_quote().

-- The ONLY way a customer responds to a quote. One transition, one time.
create or replace function respond_to_quote(p_quote_id text, p_response text)
returns quotes language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_response not in ('approved','declined') then raise exception 'Invalid response'; end if;

  select * into q from quotes where id = p_quote_id for update;   -- row lock
  if not found or q.customer_id <> auth.uid() then raise exception 'Quote not found'; end if;
  if q.status <> 'pending' then raise exception 'This quote has already been responded to'; end if;

  update quotes set status = p_response, responded_at = now()
   where id = p_quote_id returning * into q;
  return q;
end $$;
revoke all on function respond_to_quote(text,text) from public;
grant execute on function respond_to_quote(text,text) to authenticated;

-- Hide a declined quote from the customer's own view. Touches one boolean.
create or replace function hide_declined_quote(p_quote_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update quotes set hidden_by_customer = true
   where id = p_quote_id and customer_id = auth.uid() and status = 'declined';
end $$;
revoke all on function hide_declined_quote(text) from public;
grant execute on function hide_declined_quote(text) to authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. INVOICES — customers are SELECT-only. Full stop.
-- ─────────────────────────────────────────────────────────────────────────────
create table invoices (
  id              text primary key default new_id('INV'),
  customer_id     uuid not null references customers(id) on delete restrict,
  customer_email  text not null,
  customer_name   text,
  company         text,
  description     text,
  items           jsonb,
  amount          numeric(10,2) not null check (amount > 0),
  status          text not null default 'unpaid' check (status in ('unpaid','payment_pending','paid','partially_refunded','refunded','void','hidden')),
  paid_at         timestamptz,
  due             timestamptz,
  quote_id        text references quotes(id) on delete set null,
  paid_via        text,                  -- 'helcim' | 'manual'
  payment_id      uuid,                  -- set once paid (FK added below)
  created_at      timestamptz not null default now()
);
create index on invoices(customer_id);
alter table invoices enable row level security;

create policy "inv_admin_all" on invoices for all    using (is_admin()) with check (is_admin());
create policy "inv_read_own"  on invoices for select using (auth.uid() = customer_id);
-- NO customer insert/update/delete. Payment state is written by Edge Functions.


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. PAYMENTS — one row per money event. History is never overwritten.
-- ─────────────────────────────────────────────────────────────────────────────
create table payments (
  id                      uuid primary key default gen_random_uuid(),
  invoice_id              text not null references invoices(id) on delete restrict,
  customer_id             uuid not null references customers(id) on delete restrict,

  provider                text not null check (provider in ('helcim','manual')),
  kind                    text not null default 'payment' check (kind in ('payment','refund','reversal')),
  method                  text check (method in ('card','ach','check','cash','bank_transfer','terminal','other')),

  amount_cents            bigint not null check (amount_cents > 0),   -- integer cents only
  currency                text   not null default 'USD',

  status                  text not null check (status in ('initiated','pending','succeeded','failed','unknown','voided')),

  -- Provider references only. Never card/bank data.
  idempotency_key         text,
  provider_transaction_id text,
  provider_invoice_number text,
  checkout_token          text,
  method_display          text,          -- 'Visa ····4242' masked
  failure_category        text,          -- coarse bucket, never raw processor text

  -- Manual payments
  reference               text,          -- check #, wire ref, etc.
  notes                   text,
  recorded_by             uuid,          -- admin auth uid

  refund_of               uuid references payments(id),   -- set on refund/reversal rows
  initiated_at            timestamptz not null default now(),
  approved_at             timestamptz,
  settled_at              timestamptz,
  declined_at             timestamptz,
  created_at              timestamptz not null default now(),
  completed_at            timestamptz
);

-- A Helcim transaction can only ever be recorded once.
create unique index uq_pay_provider_txn on payments (provider, provider_transaction_id)
  where provider_transaction_id is not null;
-- Idempotency: a replayed checkout returns the original row, never charges twice.
create unique index uq_pay_idem on payments (customer_id, idempotency_key)
  where idempotency_key is not null;
-- Only one in-flight Helcim attempt per invoice.
create unique index uq_pay_inflight on payments (invoice_id)
  where provider = 'helcim' and status in ('initiated','pending','unknown') and kind = 'payment';
create index on payments(customer_id);
create index on payments(invoice_id);

alter table payments enable row level security;
create policy "pay_admin_read" on payments for select using (is_admin());
create policy "pay_read_own"   on payments for select using (auth.uid() = customer_id);
-- NO insert/update for anyone via the API. Edge Functions use the service role.

alter table invoices add constraint fk_invoice_payment
  foreign key (payment_id) references payments(id) on delete set null;

-- Amounts are immutable and a succeeded payment cannot be reopened.
create or replace function guard_payment() returns trigger
language plpgsql as $$
begin
  if old.amount_cents is distinct from new.amount_cents then
    raise exception 'payment amount is immutable';
  end if;
  if old.status = 'succeeded' and new.status is distinct from 'succeeded' then
    raise exception 'a succeeded payment cannot be reopened — record a refund row instead';
  end if;
  return new;
end $$;
create trigger trg_guard_payment before update on payments
  for each row execute function guard_payment();

-- Payment-provider webhook inbox. Unique on event id = duplicate deliveries are no-ops.
create table payment_webhook_events (
  webhook_id    text primary key,
  event_type    text,
  payload       jsonb,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  result        text
);
alter table payment_webhook_events enable row level security;
create policy "wh_admin_read" on payment_webhook_events for select using (is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. SERVICE REQUESTS — the one thing customers may INSERT
-- ─────────────────────────────────────────────────────────────────────────────
create table service_requests (
  id              text primary key default new_id('REQ'),
  customer_id     uuid not null references customers(id) on delete cascade,
  customer_email  text not null,
  customer_name   text,
  company         text,
  equipment       text,
  issue_type      text,
  description     text not null,
  urgency         text not null default 'normal' check (urgency in ('normal','urgent','emergency')),
  attachments     jsonb,                 -- storage paths
  status          text not null default 'open' check (status in ('open','quoted','closed')),
  created_at      timestamptz not null default now()
);
create index on service_requests(customer_id);
alter table service_requests enable row level security;

-- Identity is derived from the caller's own customers row, never from the request
-- body. force_request_identity() is defined in section 3.
drop trigger if exists trg_request_identity on service_requests;
create trigger trg_request_identity before insert on service_requests
  for each row execute function force_request_identity();

create policy "req_admin_all"   on service_requests for all    using (is_admin()) with check (is_admin());
create policy "req_read_own"    on service_requests for select using (auth.uid() = customer_id);
create policy "req_insert_own"  on service_requests for insert
  with check (auth.uid() = customer_id and status = 'open');


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. SERVICE HISTORY — admin writes, customer reads
-- ─────────────────────────────────────────────────────────────────────────────
create table service_history (
  id              text primary key default new_id('SVC'),
  customer_id     uuid not null references customers(id) on delete restrict,
  customer_email  text not null,
  customer_name   text,
  company         text,
  description     text,
  equipment       text,
  date            timestamptz,
  tech            text,
  notes           text,
  amount          numeric(10,2),
  paid            boolean not null default false,
  paid_at         timestamptz,
  invoice_id      text references invoices(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index on service_history(customer_id);
alter table service_history enable row level security;
create policy "hist_admin_all" on service_history for all    using (is_admin()) with check (is_admin());
create policy "hist_read_own"  on service_history for select using (auth.uid() = customer_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. AUDIT LOG — append-only, nobody can edit it through the API
-- ─────────────────────────────────────────────────────────────────────────────
create table audit_log (
  id          bigserial primary key,
  actor_email text,
  actor_id    uuid,
  action      text not null,
  table_name  text,
  record_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
alter table audit_log enable row level security;
create policy "audit_admin_read" on audit_log for select using (is_admin());
-- Deliberately no insert/update/delete policy: triggers write it with SECURITY DEFINER.

create or replace function write_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_log (actor_email, actor_id, action, table_name, record_id, detail)
  values (
    auth.jwt() ->> 'email', auth.uid(), tg_op, tg_table_name,
    coalesce(to_jsonb(coalesce(new, old)) ->> 'id', '(unknown)'),
    case when tg_op = 'DELETE' then jsonb_build_object('old', to_jsonb(old))
         when tg_op = 'INSERT' then jsonb_build_object('new', to_jsonb(new))
         else jsonb_build_object('old_status', to_jsonb(old) ->> 'status',
                                 'new_status', to_jsonb(new) ->> 'status') end
  );
  return coalesce(new, old);
end $$;

create trigger trg_audit_customers after insert or update or delete on customers for each row execute function write_audit();
create trigger trg_audit_quotes    after insert or update or delete on quotes    for each row execute function write_audit();
create trigger trg_audit_invoices  after insert or update or delete on invoices  for each row execute function write_audit();
create trigger trg_audit_payments  after insert or update or delete on payments  for each row execute function write_audit();

-- Free-form app events written by Edge Functions (checkout created, etc.)
create table activity_log (
  id         bigserial primary key,
  actor_id   uuid,
  action     text not null,
  detail     text,
  created_at timestamptz not null default now()
);
alter table activity_log enable row level security;
create policy "activity_admin_read" on activity_log for select using (is_admin());


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. STORAGE — PRIVATE bucket, path-scoped
--
-- Customer photos may contain serial plates, warehouse interiors, damage.
-- Nobody should open one without being logged in as the owner or the admin.
-- The client fetches short-lived signed URLs; there are no permanent links.
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('apex-uploads', 'apex-uploads', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/heic','application/pdf'];

-- Admin: everything
create policy "st_admin_all" on storage.objects for all
  using (bucket_id = 'apex-uploads' and is_admin())
  with check (bucket_id = 'apex-uploads' and is_admin());

-- Customer: read + write ONLY inside service-requests/<own uuid>/
create policy "st_cust_read_own" on storage.objects for select
  using (bucket_id = 'apex-uploads'
     and (storage.foldername(name))[1] = 'service-requests'
     and (storage.foldername(name))[2] = auth.uid()::text);

create policy "st_cust_write_own" on storage.objects for insert
  with check (bucket_id = 'apex-uploads'
     and (storage.foldername(name))[1] = 'service-requests'
     and (storage.foldername(name))[2] = auth.uid()::text);

-- Customer: read quote attachments admin uploaded for THEIR quotes
create policy "st_cust_read_quote_att" on storage.objects for select
  using (bucket_id = 'apex-uploads'
     and (storage.foldername(name))[1] = 'quotes'
     and exists (select 1 from quotes q
                  where q.id = (storage.foldername(name))[2]
                    and q.customer_id = auth.uid()));



-- ─────────────────────────────────────────────────────────────────────────────
-- 11. PAYMENT EVENTS — lifecycle history, never overwritten
-- ─────────────────────────────────────────────────────────────────────────────
create table payment_events (
  id          bigserial primary key,
  payment_id  uuid references payments(id) on delete cascade,
  invoice_id  text,
  event       text not null,        -- checkout_created | approved | pending | settled | declined | refunded | reversed | amount_mismatch
  source      text not null,        -- browser_validate | webhook | reconcile | admin
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index on payment_events(payment_id);
alter table payment_events enable row level security;
create policy "pev_admin_read" on payment_events for select using (is_admin());
create policy "pev_read_own"   on payment_events for select
  using (exists (select 1 from payments p where p.id = payment_id and p.customer_id = auth.uid()));

-- Invoice financial state is DERIVED from the ledger, never set by hand.
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

  if paid_c - refund_c >= total_c and refund_c = 0 then
    update invoices set status = 'paid', paid_at = coalesce(paid_at, now()) where id = p_invoice_id;
  elsif paid_c >= total_c and refund_c >= paid_c then
    update invoices set status = 'refunded' where id = p_invoice_id;
  elsif paid_c >= total_c and refund_c > 0 then
    update invoices set status = 'partially_refunded' where id = p_invoice_id;
  elsif pending_c > 0 then
    update invoices set status = 'payment_pending', paid_at = null where id = p_invoice_id;
  else
    update invoices set status = 'unpaid', paid_at = null where id = p_invoice_id;
  end if;
end $$;
revoke all on function recalc_invoice_status(text) from public;   -- service role only


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. NOTIFICATION OUTBOX — email can fail; business state cannot
--
-- Triggers enqueue a row in the SAME transaction as the business write. A
-- worker drains it via Resend. Unique event_key means one business event
-- produces exactly one email, however many times a webhook is redelivered.
-- ─────────────────────────────────────────────────────────────────────────────
create table notification_outbox (
  id              bigserial primary key,
  event_key       text not null unique,
  event_type      text not null,
  recipient       text not null,
  entity_type     text,
  entity_id       text,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempt_count   int  not null default 0,
  last_error      text,
  provider_msg_id text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index on notification_outbox(status, next_attempt_at);
alter table notification_outbox enable row level security;
create policy "outbox_admin_read" on notification_outbox for select using (is_admin());
-- No write policy for anyone: triggers (security definer) and the worker (service role) only.

create or replace function enqueue_notification(
  p_event_key text, p_event_type text, p_recipient text,
  p_entity_type text, p_entity_id text, p_payload jsonb)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into notification_outbox (event_key, event_type, recipient, entity_type, entity_id, payload)
  values (p_event_key, p_event_type, lower(p_recipient), p_entity_type, p_entity_id, coalesce(p_payload,'{}'::jsonb))
  on conflict (event_key) do nothing;
$$;

-- Admin recipient is config, not a literal scattered through JS. Set once here.
create table if not exists app_config (key text primary key, value text not null);
insert into app_config values
  ('admin_notification_email',   'admin@apexliftsolutionsusa.com'),
  ('service_notification_email', 'apexliftsolutions1@gmail.com')
on conflict (key) do nothing;
alter table app_config enable row level security;
create policy "cfg_admin_all" on app_config for all using (is_admin()) with check (is_admin());

create or replace function cfg(k text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select value from app_config where key = k
$$;

-- ── Quote events ──
create or replace function notify_on_quote() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare pl jsonb;
begin
  pl := jsonb_build_object('quote_id', new.id, 'customer_name', new.customer_name, 'company', new.company,
          'equipment', new.equipment, 'description', new.description, 'items', new.items,
          'amount', new.amount, 'created_at', new.created_at, 'responded_at', new.responded_at);
  if tg_op = 'INSERT' then
    perform enqueue_notification('quote_created:'||new.id, 'quote_created', new.customer_email, 'quote', new.id, pl);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved','declined') then
    perform enqueue_notification('quote_'||new.status||':cust:'||new.id, 'quote_'||new.status, new.customer_email, 'quote', new.id, pl);
    perform enqueue_notification('quote_'||new.status||':admin:'||new.id, 'quote_'||new.status||'_admin', cfg('admin_notification_email'), 'quote', new.id, pl);
  end if;
  return new;
end $$;
create trigger trg_notify_quote after insert or update on quotes for each row execute function notify_on_quote();

-- ── Invoice created ──
create or replace function notify_on_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    perform enqueue_notification('invoice_created:'||new.id, 'invoice_created', new.customer_email, 'invoice', new.id,
      jsonb_build_object('invoice_id', new.id, 'customer_name', new.customer_name, 'company', new.company,
        'description', new.description, 'items', new.items, 'amount', new.amount,
        'due', new.due, 'quote_id', new.quote_id, 'created_at', new.created_at));
  end if;
  return new;
end $$;
create trigger trg_notify_invoice after insert on invoices for each row execute function notify_on_invoice();

-- ── Payment events (the important one) ──
create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; pl jsonb; ev text;
begin
  -- Only fire on a status TRANSITION, never on a re-save of the same status.
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  select * into inv from invoices where id = new.invoice_id;
  pl := jsonb_build_object('invoice_id', new.invoice_id, 'customer_name', inv.customer_name, 'company', inv.company,
          'amount', round(new.amount_cents/100.0, 2), 'method', new.method, 'method_display', new.method_display,
          'reference', coalesce(new.provider_transaction_id, new.reference), 'kind', new.kind, 'provider', new.provider,
          'paid_at', coalesce(new.settled_at, new.approved_at, new.completed_at, now()));

  if new.kind = 'payment' and new.status = 'succeeded' then
    ev := 'payment_received';
  elsif new.kind = 'payment' and new.status = 'pending' and new.method = 'ach' then
    ev := 'ach_submitted';
  elsif new.kind = 'payment' and new.status = 'failed' then
    ev := 'payment_declined';
  elsif new.kind in ('refund','reversal') and new.status = 'succeeded' then
    ev := 'payment_refunded';
  else
    return new;
  end if;

  perform enqueue_notification(ev||':cust:'||new.id, ev, inv.customer_email, 'payment', new.id::text, pl);
  if ev <> 'payment_declined' then   -- don't spam admin with every declined attempt
    perform enqueue_notification(ev||':admin:'||new.id, ev||'_admin', cfg('admin_notification_email'), 'payment', new.id::text, pl);
  end if;
  return new;
end $$;
create trigger trg_notify_payment after insert or update on payments for each row execute function notify_on_payment();


-- ── New registration → admin ──
create or replace function notify_on_registration() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform enqueue_notification('registration:'||new.id::text, 'registration_admin', cfg('admin_notification_email'),
    'customer', new.id::text, jsonb_build_object('name', new.name, 'email', new.email, 'company', new.company, 'phone', new.phone));
  return new;
end $$;
create trigger trg_notify_registration after insert on customers for each row execute function notify_on_registration();

-- ── Account activated → customer ──
create or replace function notify_on_activation() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status <> 'active' and new.status = 'active' then
    perform enqueue_notification('activated:'||new.id::text, 'account_activated', new.email,
      'customer', new.id::text, jsonb_build_object('customer_name', new.name, 'company', new.company));
  end if;
  return new;
end $$;
create trigger trg_notify_activation after update on customers for each row execute function notify_on_activation();

-- ── Service request submitted ──
create or replace function notify_on_service_request() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform enqueue_notification('service_request:'||new.id, 'service_request_admin', cfg('service_notification_email'),
    'service_request', new.id, jsonb_build_object('request_id', new.id, 'customer_name', new.customer_name,
      'company', new.company, 'customer_email', new.customer_email, 'equipment', new.equipment,
      'issue_type', new.issue_type, 'description', new.description, 'urgency', new.urgency,
      'attachment_count', coalesce(jsonb_array_length(new.attachments),0)));
  return new;
end $$;
create trigger trg_notify_request after insert on service_requests for each row execute function notify_on_service_request();


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. PUBLIC CONTACT FORM — server-side, rate-limited
-- ─────────────────────────────────────────────────────────────────────────────
create table contact_submissions (
  id          uuid primary key default gen_random_uuid(),
  form        text not null,          -- 'request_service' | 'careers'
  payload     jsonb not null,
  ip_hash     text,
  created_at  timestamptz not null default now()
);
alter table contact_submissions enable row level security;
create policy "contact_admin_read" on contact_submissions for select using (is_admin());

create table rate_limits (
  bucket      text primary key,       -- e.g. 'contact:<ip_hash>'
  hits        int not null default 0,
  window_start timestamptz not null default now()
);
alter table rate_limits enable row level security;   -- no policies: service role only


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. OUTBOX WORKER SCHEDULE (pg_cron + pg_net)
-- Enable both under Database → Extensions first, then run this block.
-- Replace <PROJECT_REF> and <ANON_KEY>. The worker itself checks a shared
-- secret header, so the anon key here is only transport, not authorization.
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- DONE — verify
-- ─────────────────────────────────────────────────────────────────────────────
select tablename,
       string_agg(policyname || ' [' || cmd || ']', ', ' order by policyname) as policies
from pg_policies where schemaname in ('public','storage')
group by tablename order by tablename;
