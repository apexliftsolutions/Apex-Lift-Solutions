-- =============================================
-- APEX LIFT SOLUTIONS — Supabase Setup SQL v5
-- Complete, audited against portal JS code.
-- Run in: Supabase Dashboard → SQL Editor
--
-- CHANGES FROM v4:
--   + service_requests table (was entirely missing)
--   + service_history: amount, paid, paid_at, customer_name, company
--   + Storage policies (were commented out — uploads silently failed)
--   + Customer invoice update policy (Stripe ?paid= redirect flow)
--   + Customer upload policy scoped to own path
--   + Removed invalid "create policy if not exists" syntax
--   + All gaps from JS audit are covered
-- =============================================


-- ═════════════════════════════════════════════
-- TABLES
-- ═════════════════════════════════════════════

-- CUSTOMERS (linked to Supabase Auth users)
create table if not exists customers (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text unique not null,
  name          text,
  company       text,
  phone         text,
  status        text default 'pending',   -- pending | active | inactive
  since         text,
  created_at    timestamptz not null default now()
);

-- QUOTES
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
  attachments    jsonb,
  created_at     timestamptz not null default now()
);

-- INVOICES
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
  items          jsonb,
  created_at     timestamptz not null default now()
);

-- SERVICE HISTORY
-- v5: added amount, paid, paid_at, customer_name, company
--     (were missing but written by portal-admin.js saveHistoryRecord)
create table if not exists service_history (
  id             text primary key,
  customer_id    uuid references customers(id) on delete set null,
  customer_email text not null,
  customer_name  text,
  company        text,
  description    text,
  equipment      text,
  date           timestamptz,
  tech           text,
  notes          text,
  amount         numeric(10,2),
  paid           boolean default false,
  paid_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- SERVICE REQUESTS
-- v5: entirely new — was missing from v4.
-- Customers submit these via the Request Service form.
-- Admin reads, updates status, and converts to quotes.
create table if not exists service_requests (
  id             text primary key default ('REQ-' || floor(random()*9000+1000)::text),
  customer_id    uuid references customers(id) on delete set null,
  customer_email text not null,
  customer_name  text,
  company        text,
  equipment      text,
  issue_type     text,
  description    text not null,
  urgency        text not null default 'normal',  -- normal | urgent | emergency
  attachments    jsonb,
  status         text not null default 'open',    -- open | quoted | closed
  created_at     timestamptz not null default now()
);


-- ═════════════════════════════════════════════
-- SAFE COLUMN ADDITIONS (existing DB migration)
-- Run these if tables already exist from v4.
-- ═════════════════════════════════════════════

alter table quotes         add column if not exists invoiced    boolean default false;
alter table quotes         add column if not exists attachments jsonb;
alter table invoices       add column if not exists items       jsonb;

-- service_history v5 additions
alter table service_history add column if not exists amount        numeric(10,2);
alter table service_history add column if not exists paid          boolean default false;
alter table service_history add column if not exists paid_at       timestamptz;
alter table service_history add column if not exists customer_name text;
alter table service_history add column if not exists company       text;


-- ═════════════════════════════════════════════
-- ENABLE ROW LEVEL SECURITY
-- ═════════════════════════════════════════════

alter table customers        enable row level security;
alter table quotes           enable row level security;
alter table invoices         enable row level security;
alter table service_history  enable row level security;
alter table service_requests enable row level security;


-- ═════════════════════════════════════════════
-- CUSTOMERS POLICIES
-- ═════════════════════════════════════════════

-- Admin: full access to all rows
create policy "Admin full access on customers"
  on customers for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customer: read only their own profile row
create policy "Customer read own profile"
  on customers for select
  using (auth.uid() = id);

-- Customer: insert their own profile row on self-registration
-- Needed by portal-login.js handleRegister():
--   _sb.from('customers').insert({ id: data.user.id, email, name, ... })
-- Without this, auth.signUp() succeeds but the customer profile row
-- is silently blocked, leaving an orphaned auth user with no portal access.
create policy "Customer insert own profile"
  on customers for insert
  with check (auth.uid() = id);


-- ═════════════════════════════════════════════
-- QUOTES POLICIES
-- ═════════════════════════════════════════════

-- Admin: full access
create policy "Admin full access on quotes"
  on quotes for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customer: read their own quotes only
create policy "Customer read own quotes"
  on quotes for select
  using (auth.uid() = customer_id);

-- Customer: update their own quotes (approve, decline, remove declined)
-- Needed by portal-customer.js respondQuote() and removeQuote()
create policy "Customer update own quotes"
  on quotes for update
  using      (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);


-- ═════════════════════════════════════════════
-- INVOICES POLICIES
-- ═════════════════════════════════════════════

-- Admin: full access
create policy "Admin full access on invoices"
  on invoices for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customer: read their own invoices only
create policy "Customer read own invoices"
  on invoices for select
  using (auth.uid() = customer_id);

-- Customer: update their own invoices
-- Needed by portal-customer.js Stripe ?paid= redirect handler:
--   sb.from('invoices').update({ status:'paid', paid_at:... }).eq('id', paidId)
-- Without this, a successful Stripe payment cannot write "paid" back to
-- the database and the invoice stays showing as unpaid.
create policy "Customer update own invoices"
  on invoices for update
  using      (auth.uid() = customer_id)
  with check (auth.uid() = customer_id);


-- ═════════════════════════════════════════════
-- SERVICE HISTORY POLICIES
-- ═════════════════════════════════════════════

-- Admin: full access (create, read, update, delete records)
create policy "Admin full access on service_history"
  on service_history for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customer: read their own history only
create policy "Customer read own service_history"
  on service_history for select
  using (auth.uid() = customer_id);


-- ═════════════════════════════════════════════
-- SERVICE REQUESTS POLICIES
-- (v5 — table was missing entirely from v4)
-- ═════════════════════════════════════════════

-- Admin: full access (read all, update status, delete)
create policy "Admin full access on service_requests"
  on service_requests for all
  using      (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com')
  with check (auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com');

-- Customer: insert their own service requests
-- Needed by portal-customer.js submitRequest():
--   sb.from('service_requests').insert({ customer_id: USER.id, ... })
create policy "Customer insert own service_requests"
  on service_requests for insert
  with check (auth.uid() = customer_id);

-- Customer: read their own service requests
create policy "Customer read own service_requests"
  on service_requests for select
  using (auth.uid() = customer_id);


-- ═════════════════════════════════════════════
-- STORAGE: apex-uploads bucket
-- ═════════════════════════════════════════════
-- BEFORE running these policies, create the bucket manually:
--   Dashboard → Storage → New Bucket
--   Name: apex-uploads
--   Public: YES  (needed so attachment URLs in emails work without auth)
--
-- These were commented out in v4 — uploads from both admin and customers
-- were silently failing with permission errors.

-- Admin: upload to any path in the bucket
create policy "Admin can upload files"
  on storage.objects for insert
  with check (
    bucket_id = 'apex-uploads'
    and auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com'
  );

-- Admin: update files (overwrite / replace)
create policy "Admin can update files"
  on storage.objects for update
  using (
    bucket_id = 'apex-uploads'
    and auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com'
  );

-- Admin: delete files
create policy "Admin can delete files"
  on storage.objects for delete
  using (
    bucket_id = 'apex-uploads'
    and auth.jwt()->>'email' = 'admin@apexliftsolutionsusa.com'
  );

-- Customer: upload files to their own service-request folder only
-- Path enforced: service-requests/{their-user-id}/filename
-- This means customer A cannot write to customer B's folder,
-- and no customer can write to the quotes/ path (admin-only).
create policy "Customer can upload own service request files"
  on storage.objects for insert
  with check (
    bucket_id = 'apex-uploads'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = 'service-requests'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- Public: read any file in the bucket
-- Required so attachment URLs embedded in emails and portal work
-- without the viewer needing to be authenticated.
create policy "Public read apex-uploads"
  on storage.objects for select
  using (bucket_id = 'apex-uploads');


-- ═════════════════════════════════════════════
-- MANUAL STEPS (not SQL — do in dashboard)
-- ═════════════════════════════════════════════

-- 1. AUTH URLS
--    Dashboard → Authentication → URL Configuration
--      Site URL:     https://apexliftsolutionsusa.com
--      Redirect URL: https://apexliftsolutionsusa.com/portal-forgot.html

-- 2. OTP SETTINGS (required for portal-forgot.js)
--    Dashboard → Authentication → Providers → Email
--      Enable Email Signup: ON
--      OTP expiry: 600 seconds
--    Dashboard → Authentication → Email Templates → Magic Link
--      Confirm {{ .Token }} is in the body (this is the 6-digit code)

-- 3. ADMIN ACCOUNT
--    Dashboard → Authentication → Users → Add User
--      Email:    admin@apexliftsolutionsusa.com
--      Password: set strong password here — never in code

-- 4. STORAGE BUCKET
--    Dashboard → Storage → New Bucket
--      Name: apex-uploads
--      Public: YES


-- ═════════════════════════════════════════════
-- OPTIONAL: SEED DEMO CUSTOMER
-- ═════════════════════════════════════════════
-- Create the auth user first (Dashboard → Auth → Users → Add User),
-- then paste their UUID here:

-- insert into customers (id, email, name, company, phone, status, since) values
--   ('PASTE-UUID-HERE', 'testcustomer1@youremail.com', 'Test One',
--    'Company A', '(555) 111-0001', 'active', 'May 2026');

-- insert into customers (id, email, name, company, phone, status, since) values
--   ('PASTE-UUID-HERE', 'testcustomer2@youremail.com', 'Test Two',
--    'Company B', '(555) 222-0002', 'active', 'May 2026');
