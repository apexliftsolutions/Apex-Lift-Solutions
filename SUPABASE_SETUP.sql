-- =============================================
-- APEX LIFT SOLUTIONS — Supabase Setup SQL v2
-- Run this in: Supabase Dashboard → SQL Editor
-- =============================================

-- QUOTES table
create table if not exists quotes (
  id             text primary key default ('Q-' || floor(random()*9000+1000)::text),
  customer_email text not null,
  customer_name  text,
  company        text,
  equipment      text,
  description    text,
  items          jsonb,
  amount         numeric(10,2) not null default 0,
  status         text not null default 'pending',
  responded_at   timestamptz,
  notes          text,
  created_at     timestamptz not null default now()
);

-- INVOICES table
create table if not exists invoices (
  id             text primary key default ('INV-' || floor(random()*9000+1000)::text),
  customer_email text not null,
  customer_name  text,
  company        text,
  description    text,
  amount         numeric(10,2) not null default 0,
  status         text not null default 'unpaid',
  paid_at        timestamptz,
  due            timestamptz,
  quote_id       text references quotes(id),
  created_at     timestamptz not null default now()
);

-- CUSTOMERS table (with password_hash for portal login)
create table if not exists customers (
  id            bigint primary key generated always as identity,
  email         text unique not null,
  name          text,
  company       text,
  phone         text,
  password_hash text,
  status        text default 'pending',
  since         text,
  created_at    timestamptz not null default now()
);

-- SERVICE HISTORY table
create table if not exists service_history (
  id             text primary key,
  customer_email text not null,
  description    text,
  equipment      text,
  date           timestamptz,
  tech           text,
  notes          text,
  created_at     timestamptz not null default now()
);

-- ── ROW LEVEL SECURITY ─────────────────────────
alter table quotes enable row level security;
alter table invoices enable row level security;
alter table customers enable row level security;
alter table service_history enable row level security;

create policy "Allow anon all on quotes"          on quotes          for all using (true) with check (true);
create policy "Allow anon all on invoices"        on invoices        for all using (true) with check (true);
create policy "Allow anon all on customers"       on customers       for all using (true) with check (true);
create policy "Allow anon all on service_history" on service_history for all using (true) with check (true);

-- ── ADD password_hash IF TABLE ALREADY EXISTS ──
alter table customers add column if not exists password_hash text;

-- ── SEED DEMO DATA ─────────────────────────────
-- Password for demo customer is "demo123"
-- Hash = SHA256("demo123apex_salt_2026")
insert into customers (email, name, company, phone, password_hash, status, since) values
  ('customer@demo.com', 'Rocko', 'Demo Warehouse Co.', '(516) 555-0101',
   '3b5bbf87640ae05b4db5a4f08ef49a6f2e49e1dd060a68e7c1d0aeba2f00bfe2',
   'active', 'May 2026')
on conflict (email) do update set
  password_hash = excluded.password_hash,
  status = 'active';

insert into customers (email, name, company, phone, password_hash, status, since) values
  ('james@midtownlogistics.com', 'James M.', 'Midtown Logistics', '(718) 555-0202',
   '3b5bbf87640ae05b4db5a4f08ef49a6f2e49e1dd060a68e7c1d0aeba2f00bfe2',
   'active', 'Apr 2026')
on conflict (email) do update set
  password_hash = excluded.password_hash,
  status = 'active';

insert into quotes (id, customer_email, customer_name, company, equipment, description, items, amount, status) values
  ('Q-1004', 'customer@demo.com', 'Rocko', 'Demo Warehouse Co.', 'Toyota Forklift',
   'Forklift Repair — LBR Bracket, Side Shift Hoses, LP Tank Fitting, Hardware',
   '[{"desc":"LBR Bracket","type":"Parts","amount":373.66},{"desc":"Side Shift Hoses","type":"Parts","amount":318.73},{"desc":"LP Tank Fitting","type":"Parts","amount":25.00},{"desc":"Hardware","type":"Parts","amount":82.70},{"desc":"Remove and replace LP fitting","type":"Labor","amount":90.00},{"desc":"Remove and replace LBR bracket","type":"Labor","amount":180.00},{"desc":"Remove and replace side shift hoses","type":"Labor","amount":540.00},{"desc":"Travel","type":"Travel","amount":50.00}]'::jsonb,
   1660.09, 'pending')
on conflict (id) do nothing;

insert into invoices (id, customer_email, customer_name, company, description, amount, status, due) values
  ('INV-1001', 'james@midtownlogistics.com', 'James M.', 'Midtown Logistics',
   'Preventive Maintenance — Toyota 8FGU25', 420.00, 'paid', now() + interval '30 days')
on conflict (id) do nothing;

insert into service_history (id, customer_email, description, equipment, date, tech, notes) values
  ('SVC-2026-01', 'customer@demo.com', 'Preventive Maintenance — 90-Day Visit',
   'Toyota Forklift', '2026-04-15', 'Apex Tech #1',
   'Fluid checks completed. Air filter replaced. All safety systems operational.')
on conflict (id) do nothing;
