-- ================================================================
--  APEX LIFT SOLUTIONS — Supabase Setup (Clean Slate)
--  Paste into: Dashboard → SQL Editor → Run
--
--  STEP 1 of 2: Run this entire file.
--  STEP 2 of 2: See manual steps at the bottom.
--
--  Safe to run on a fresh project OR an existing one.
--  The DROP section at the top clears everything first.
-- ================================================================


-- ═══════════════════════════════════════════════════════════════
-- CLEAN SLATE — drop everything that might already exist
-- ═══════════════════════════════════════════════════════════════

-- Drop tables (cascade removes their policies too)
drop table if exists service_requests cascade;
drop table if exists service_history  cascade;
drop table if exists invoices         cascade;
drop table if exists quotes           cascade;
drop table if exists customers        cascade;

-- Drop any existing storage policies on storage.objects
-- (Supabase creates some defaults; we replace them all)
do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', pol.policyname);
  end loop;
end;
$$;


-- ═══════════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════════

create table customers (
  id          uuid          primary key references auth.users(id) on delete cascade,
  email       text          unique not null,
  name        text          not null default '',
  company     text          not null default '',
  phone       text          not null default '',
  status      text          not null default 'pending',  -- pending | active | inactive
  since       text          not null default '',
  created_at  timestamptz   not null default now()
);

create table quotes (
  id             text          primary key default ('Q-' || floor(random()*9000+1000)::text),
  customer_id    uuid          references customers(id) on delete set null,
  customer_email text          not null,
  customer_name  text          not null default '',
  company        text          not null default '',
  equipment      text          not null default '',
  description    text          not null default '',
  items          jsonb,
  amount         numeric(10,2) not null default 0,
  status         text          not null default 'pending',  -- pending | approved | declined
  invoiced       boolean       not null default false,
  responded_at   timestamptz,
  notes          text,
  attachments    jsonb,
  created_at     timestamptz   not null default now()
);

create table invoices (
  id             text          primary key default ('INV-' || floor(random()*9000+1000)::text),
  customer_id    uuid          references customers(id) on delete set null,
  customer_email text          not null,
  customer_name  text          not null default '',
  company        text          not null default '',
  description    text          not null default '',
  items          jsonb,
  amount         numeric(10,2) not null default 0,
  status         text          not null default 'unpaid',  -- unpaid | paid | hidden
  due            timestamptz,
  paid_at        timestamptz,
  quote_id       text          references quotes(id) on delete set null,
  created_at     timestamptz   not null default now()
);

create table service_history (
  id             text          primary key,
  customer_id    uuid          references customers(id) on delete set null,
  customer_email text          not null,
  customer_name  text          not null default '',
  company        text          not null default '',
  equipment      text          not null default '',
  description    text          not null default '',
  tech           text          not null default '',
  notes          text,
  date           timestamptz,
  amount         numeric(10,2),
  paid           boolean       not null default false,
  paid_at        timestamptz,
  created_at     timestamptz   not null default now()
);

create table service_requests (
  id             text          primary key default ('REQ-' || floor(random()*9000+1000)::text),
  customer_id    uuid          references customers(id) on delete set null,
  customer_email text          not null,
  customer_name  text          not null default '',
  company        text          not null default '',
  equipment      text          not null default '',
  issue_type     text          not null default '',
  description    text          not null,
  urgency        text          not null default 'normal',  -- normal | urgent | emergency
  attachments    jsonb,
  status         text          not null default 'open',    -- open | quoted | closed
  created_at     timestamptz   not null default now()
);


-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════

alter table customers        enable row level security;
alter table quotes           enable row level security;
alter table invoices         enable row level security;
alter table service_history  enable row level security;
alter table service_requests enable row level security;


-- ═══════════════════════════════════════════════════════════════
-- CUSTOMERS POLICIES
-- ═══════════════════════════════════════════════════════════════

create policy "admin_customers_all"
  on customers for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

create policy "customer_read_own_profile"
  on customers for select
  using (auth.uid() = id);

create policy "customer_insert_own_profile"
  on customers for insert
  with check (auth.uid() = id);

create policy "customer_update_own_profile"
  on customers for update
  using      (auth.uid() = id)
  with check (auth.uid() = id);


-- ═══════════════════════════════════════════════════════════════
-- QUOTES POLICIES
-- ═══════════════════════════════════════════════════════════════

create policy "admin_quotes_all"
  on quotes for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

create policy "customer_read_own_quotes"
  on quotes for select
  using (auth.uid() = customer_id);

create policy "customer_update_own_quotes"
  on quotes for update
  using      (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);


-- ═══════════════════════════════════════════════════════════════
-- INVOICES POLICIES
-- ═══════════════════════════════════════════════════════════════

create policy "admin_invoices_all"
  on invoices for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

create policy "customer_read_own_invoices"
  on invoices for select
  using (auth.uid() = customer_id);

create policy "customer_update_own_invoices"
  on invoices for update
  using      (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);


-- ═══════════════════════════════════════════════════════════════
-- SERVICE HISTORY POLICIES
-- ═══════════════════════════════════════════════════════════════

create policy "admin_service_history_all"
  on service_history for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

create policy "customer_read_own_service_history"
  on service_history for select
  using (auth.uid() = customer_id);


-- ═══════════════════════════════════════════════════════════════
-- SERVICE REQUESTS POLICIES
-- ═══════════════════════════════════════════════════════════════

create policy "admin_service_requests_all"
  on service_requests for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

create policy "customer_insert_own_service_requests"
  on service_requests for insert
  with check (auth.uid() = customer_id);

create policy "customer_read_own_service_requests"
  on service_requests for select
  using (auth.uid() = customer_id);


-- ═══════════════════════════════════════════════════════════════
-- STORAGE POLICIES
-- ═══════════════════════════════════════════════════════════════
-- The DROP block at the top already wiped any existing storage
-- policies, so these will always create cleanly.
--
-- IMPORTANT: Create the bucket manually BEFORE running this file:
--   Dashboard → Storage → New Bucket
--   Name: apex-uploads  |  Public: YES

create policy "admin_storage_insert"
  on storage.objects for insert
  with check (
    bucket_id = 'apex-uploads'
    and auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com'
  );

create policy "admin_storage_update"
  on storage.objects for update
  using (
    bucket_id = 'apex-uploads'
    and auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com'
  );

create policy "admin_storage_delete"
  on storage.objects for delete
  using (
    bucket_id = 'apex-uploads'
    and auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com'
  );

create policy "customer_storage_insert_own_path"
  on storage.objects for insert
  with check (
    bucket_id = 'apex-uploads'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = 'service-requests'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "public_storage_select"
  on storage.objects for select
  using (bucket_id = 'apex-uploads');


-- ================================================================
--  MANUAL STEPS — do these in the Supabase dashboard
-- ================================================================
--
--  1. STORAGE BUCKET (do this BEFORE running this SQL)
--     Storage → New Bucket
--     Name: apex-uploads  |  Public: YES
--
--  2. ADMIN ACCOUNT
--     Authentication → Users → Add User
--     Email:    admin@apexliftsolutionsusa.com
--     Password: set a strong one here — never in code
--
--  3. AUTH URL SETTINGS
--     Authentication → URL Configuration
--     Site URL:     https://apexliftsolutionsusa.com
--     Redirect URL: https://apexliftsolutionsusa.com/portal-forgot.html
--
--  4. OTP SETTINGS (password reset)
--     Authentication → Providers → Email → OTP expiry: 600
--     Authentication → Email Templates → Magic Link
--     Confirm {{ .Token }} is in the email body
-- ================================================================


-- ═══════════════════════════════════════════════════════════════
-- ACTIVITY LOG TABLE (add after initial setup)
-- ═══════════════════════════════════════════════════════════════
-- Records every sensitive admin action: invoice creation,
-- payments marked, customer activations, deletions, etc.
-- Written by the admin-action Edge Function using the service role.

create table if not exists activity_log (
  id          bigint      generated always as identity primary key,
  actor_id    uuid,
  actor_email text        not null default 'admin@apexliftsolutionsusa.com',
  action      text        not null,
  description text        not null,
  created_at  timestamptz not null default now()
);

alter table activity_log enable row level security;

-- Only admin can read the log
create policy "admin_read_activity_log"
  on activity_log for select
  using (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Edge Function uses service role key which bypasses RLS for inserts.
-- No customer-facing insert policy needed or wanted.
