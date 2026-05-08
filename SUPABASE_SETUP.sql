-- =============================================
-- APEX LIFT SOLUTIONS — Supabase Setup SQL v4
-- Uses Supabase Auth (auth.users) as identity.
-- RLS enforces row-level access server-side.
-- Run in: Supabase Dashboard → SQL Editor
-- =============================================

-- CUSTOMERS profile table (linked to auth.users)
create table if not exists customers (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text unique not null,
  name          text,
  company       text,
  phone         text,
  status        text default 'pending',  -- pending | active | inactive
  since         text,
  created_at    timestamptz not null default now()
);

-- QUOTES table
create table if not exists quotes (
  id             text primary key default ('Q-' || floor(random()*9000+1000)::text),
  customer_id    uuid references customers(id) on delete set null,
  customer_email text not null,
  customer_name  text,
  company        text,
  equipment      text,
  description    text,
  items          jsonb,
  amount         numeric(10,2) not null default 0,
  status         text not null default 'pending',
  invoiced       boolean default false,
  responded_at   timestamptz,
  notes          text,
  attachments    jsonb,                            -- array of Supabase Storage URLs
  created_at     timestamptz not null default now()
);

-- INVOICES table
create table if not exists invoices (
  id             text primary key default ('INV-' || floor(random()*9000+1000)::text),
  customer_id    uuid references customers(id) on delete set null,
  customer_email text not null,
  customer_name  text,
  company        text,
  description    text,
  amount         numeric(10,2) not null default 0,
  status         text not null default 'unpaid',
  paid_at        timestamptz,
  due            timestamptz,
  quote_id       text references quotes(id),
  items          jsonb,                            -- copied from quote for receipt
  created_at     timestamptz not null default now()
);

-- SERVICE HISTORY table
create table if not exists service_history (
  id             text primary key,
  customer_id    uuid references customers(id) on delete set null,
  customer_email text not null,
  description    text,
  equipment      text,
  date           timestamptz,
  tech           text,
  notes          text,
  created_at     timestamptz not null default now()
);

-- ── ROW LEVEL SECURITY ─────────────────────────
alter table customers      enable row level security;
alter table quotes         enable row level security;
alter table invoices       enable row level security;
alter table service_history enable row level security;

-- ── CUSTOMERS RLS ──────────────────────────────
-- Admin can do everything
create policy "Admin full access on customers"
  on customers for all
  using (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customers can only read their own profile
create policy "Customer read own profile"
  on customers for select
  using (auth.uid() = id);

-- ── QUOTES RLS ─────────────────────────────────
-- Admin can do everything
create policy "Admin full access on quotes"
  on quotes for all
  using (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customers can only read their OWN quotes (server enforced)
create policy "Customer read own quotes"
  on quotes for select
  using (auth.uid() = customer_id);

-- Customers can update status on their own quotes (approve/decline)
create policy "Customer update own quote status"
  on quotes for update
  using (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);

-- ── INVOICES RLS ───────────────────────────────
-- Admin can do everything
create policy "Admin full access on invoices"
  on invoices for all
  using (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customers can only read their OWN invoices (server enforced)
create policy "Customer read own invoices"
  on invoices for select
  using (auth.uid() = customer_id);

-- ── SERVICE HISTORY RLS ────────────────────────
-- Admin can do everything
create policy "Admin full access on service_history"
  on service_history for all
  using (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customers can only read their OWN service history
create policy "Customer read own service_history"
  on service_history for select
  using (auth.uid() = customer_id);

-- ── SUPABASE AUTH SETTINGS ─────────────────────
-- In Supabase Dashboard → Authentication → Settings:
-- 1. Set "Site URL" to: https://apexliftsolutionsusa.com
-- 2. Add redirect URL: https://apexliftsolutionsusa.com/portal-forgot.html
-- 3. Enable email confirmations if desired

-- ── SEED ADMIN ACCOUNT ─────────────────────────
-- Create admin account via: Supabase Dashboard → Auth → Users → Add User
-- Email: admin@apexliftsolutionsusa.com
-- Set a strong password there — never in code.

-- ── SEED DEMO CUSTOMER (optional) ──────────────
-- After creating a Supabase Auth user for customer@demo.com,
-- insert their profile (replace UUID with their actual auth.users id):
-- insert into customers (id, email, name, company, phone, status, since) values
--   ('YOUR-UUID-HERE', 'customer@demo.com', 'Rocko', 'Demo Warehouse Co.', '(516) 555-0101', 'active', 'May 2026');


-- ── ADD MISSING COLUMNS IF TABLE EXISTS ──────
alter table quotes    add column if not exists invoiced    boolean default false;
alter table quotes    add column if not exists attachments jsonb;
alter table invoices  add column if not exists items       jsonb;

-- ── SUPABASE STORAGE BUCKET ──────────────────
-- Run in Supabase Dashboard → Storage → Create Bucket
-- Bucket name: apex-uploads
-- Public: YES (so file URLs work in emails/portal)
-- Then add this RLS policy so only admin can upload:
--
-- create policy "Admin can upload files"
--   on storage.objects for insert
--   with check (bucket_id = 'apex-uploads' AND auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');
--
-- create policy "Public can read files"
--   on storage.objects for select
--   using (bucket_id = 'apex-uploads');

-- ── INSERT POLICY FOR CUSTOMER SELF-REGISTRATION ──
-- Allows register form to create customer profile row
create policy if not exists "Allow new user to insert own profile"
  on customers for insert
  with check (auth.uid() = id);
