-- ================================================================
--  APEX LIFT SOLUTIONS — Complete Supabase Setup (Final)
--  Paste this entire file into: Dashboard → SQL Editor → Run
--  Fresh project only — drop all existing tables first if needed.
-- ================================================================


-- ═══════════════════════════════════════════════════════════════
-- TABLES
-- ═══════════════════════════════════════════════════════════════

create table customers (
  id          uuid        primary key references auth.users(id) on delete cascade,
  email       text        unique not null,
  name        text        not null default '',
  company     text        not null default '',
  phone       text        not null default '',
  status      text        not null default 'pending',  -- pending | active | inactive
  since       text        not null default '',
  created_at  timestamptz not null default now()
);

create table quotes (
  id             text        primary key default ('Q-' || floor(random()*9000+1000)::text),
  customer_id    uuid        references customers(id) on delete set null,
  customer_email text        not null,
  customer_name  text        not null default '',
  company        text        not null default '',
  equipment      text        not null default '',
  description    text        not null default '',
  items          jsonb,
  amount         numeric(10,2) not null default 0,
  status         text        not null default 'pending',  -- pending | approved | declined
  invoiced       boolean     not null default false,
  responded_at   timestamptz,
  notes          text,
  attachments    jsonb,
  created_at     timestamptz not null default now()
);

create table invoices (
  id             text        primary key default ('INV-' || floor(random()*9000+1000)::text),
  customer_id    uuid        references customers(id) on delete set null,
  customer_email text        not null,
  customer_name  text        not null default '',
  company        text        not null default '',
  description    text        not null default '',
  items          jsonb,
  amount         numeric(10,2) not null default 0,
  status         text        not null default 'unpaid',  -- unpaid | paid | hidden
  due            timestamptz,
  paid_at        timestamptz,
  quote_id       text        references quotes(id) on delete set null,
  created_at     timestamptz not null default now()
);

create table service_history (
  id             text        primary key,
  customer_id    uuid        references customers(id) on delete set null,
  customer_email text        not null,
  customer_name  text        not null default '',
  company        text        not null default '',
  equipment      text        not null default '',
  description    text        not null default '',
  tech           text        not null default '',
  notes          text,
  date           timestamptz,
  amount         numeric(10,2),
  paid           boolean     not null default false,
  paid_at        timestamptz,
  created_at     timestamptz not null default now()
);

create table service_requests (
  id             text        primary key default ('REQ-' || floor(random()*9000+1000)::text),
  customer_id    uuid        references customers(id) on delete set null,
  customer_email text        not null,
  customer_name  text        not null default '',
  company        text        not null default '',
  equipment      text        not null default '',
  issue_type     text        not null default '',
  description    text        not null,
  urgency        text        not null default 'normal',  -- normal | urgent | emergency
  attachments    jsonb,
  status         text        not null default 'open',    -- open | quoted | closed
  created_at     timestamptz not null default now()
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

-- Customers read their own profile (for name/company display + status check on login)
create policy "customer_read_own_profile"
  on customers for select
  using (auth.uid() = id);

-- Customers insert their own profile on registration
-- portal-login.js handleRegister(): _sb.from('customers').insert({ id: data.user.id, ... })
create policy "customer_insert_own_profile"
  on customers for insert
  with check (auth.uid() = id);

-- Customers update their own profile (name, company, phone via Account tab)
-- portal-customer.js saveProfile(): sb.from('customers').update({ name, company, phone })
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

-- Approve, decline, and hide declined quotes
-- portal-customer.js respondQuote() and removeQuote()
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

-- Required for Stripe ?paid= redirect: sb.from('invoices').update({ status:'paid' })
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

-- portal-customer.js submitRequest(): sb.from('service_requests').insert(...)
create policy "customer_insert_own_service_requests"
  on service_requests for insert
  with check (auth.uid() = customer_id);

create policy "customer_read_own_service_requests"
  on service_requests for select
  using (auth.uid() = customer_id);


-- ═══════════════════════════════════════════════════════════════
-- STORAGE: apex-uploads bucket
-- ═══════════════════════════════════════════════════════════════
-- Create the bucket FIRST (manually in the dashboard):
--   Storage → New Bucket → Name: apex-uploads → Public: YES
-- Then run these policies.

-- Admin uploads anywhere (quote attachments, etc.)
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

-- Customers upload only to service-requests/{their-user-id}/filename
-- Prevents writing to quote/ paths or other customers' folders
create policy "customer_storage_insert_own_path"
  on storage.objects for insert
  with check (
    bucket_id = 'apex-uploads'
    and auth.role() = 'authenticated'
    and (storage.foldername(name))[1] = 'service-requests'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- Public read so attachment URLs in emails work without auth headers
create policy "public_storage_select"
  on storage.objects for select
  using (bucket_id = 'apex-uploads');


-- ═══════════════════════════════════════════════════════════════
-- MANUAL STEPS AFTER RUNNING THIS SQL
-- ═══════════════════════════════════════════════════════════════
--
-- 1. STORAGE BUCKET
--    Dashboard → Storage → New Bucket
--    Name: apex-uploads | Public: YES
--    (run storage policies above after creating it)
--
-- 2. ADMIN ACCOUNT
--    Dashboard → Authentication → Users → Add User
--    Email: admin@apexliftsolutionsusa.com
--    Set a strong password — never put passwords in code
--
-- 3. AUTH URL SETTINGS
--    Dashboard → Authentication → URL Configuration
--    Site URL:     https://apexliftsolutionsusa.com
--    Redirect URL: https://apexliftsolutionsusa.com/portal-forgot.html
--
-- 4. OTP SETTINGS (for password reset flow)
--    Dashboard → Authentication → Providers → Email
--    OTP expiry: 600 seconds
--    Dashboard → Authentication → Email Templates → Magic Link
--    Confirm {{ .Token }} appears in the body
--
-- 5. CAREERS FORM
--    Both the contact and careers forms route through your existing
--    Formspree endpoint (myklrjov). The _subject field differentiates
--    quote requests from job applications in your inbox.
