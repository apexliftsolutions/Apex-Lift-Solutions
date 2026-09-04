-- =============================================================================
-- APEX LIFT SOLUTIONS — NEW YORK SALES TAX  (NON-DESTRUCTIVE)
-- Run AFTER PRODUCTION_UPGRADE.sql and FEESAVER_UPGRADE.sql.
-- Safe to re-run. No DROP TABLE / TRUNCATE / DELETE.
--
-- DESIGN DECISION — read this before running:
--   `quotes.amount` and `invoices.amount` continue to be the GRAND TOTAL the
--   customer owes, now INCLUSIVE of sales tax. The new columns are the
--   breakdown, not a replacement.
--
--   This is deliberate. recalc_invoice_status(), payment-checkout,
--   payment-validate, payment-events and payment-reconcile all already treat
--   invoices.amount as "what settles this invoice". Keeping that meaning means
--   the entire payment path keeps working with no change to its amount logic.
--
--     subtotal_cents + tax_cents = round(amount * 100)
--
-- HISTORICAL ROWS:
--   Existing quotes/invoices had no tax charged. They are backfilled as
--   subtotal = amount, tax = 0, rate = 0. Tax is NEVER applied retroactively.
-- =============================================================================

begin;

-- ── Breakdown columns ───────────────────────────────────────────────────────
-- tax_rate_milli_pct stores thousandths of a percent: 8625 = 8.625%.
-- Basis points cannot represent 8.625% exactly (862.5 bps), hence milli-pct.
alter table quotes
  add column if not exists subtotal_cents     bigint,
  add column if not exists tax_cents          bigint  not null default 0,
  add column if not exists tax_rate_milli_pct integer not null default 0,
  add column if not exists tax_exempt         boolean not null default false,
  add column if not exists tax_jurisdiction   text;

alter table invoices
  add column if not exists subtotal_cents     bigint,
  add column if not exists tax_cents          bigint  not null default 0,
  add column if not exists tax_rate_milli_pct integer not null default 0,
  add column if not exists tax_exempt         boolean not null default false,
  add column if not exists tax_jurisdiction   text,
  add column if not exists exempt_cert_number text;

comment on column invoices.subtotal_cents     is 'Sum of line items before sales tax.';
comment on column invoices.tax_cents          is 'Sales tax charged. 0 when tax_exempt.';
comment on column invoices.tax_rate_milli_pct is 'Rate in thousandths of a percent. 8625 = 8.625%.';
comment on column invoices.amount             is 'GRAND TOTAL owed, INCLUSIVE of sales tax. subtotal_cents + tax_cents = amount*100.';
comment on column invoices.exempt_cert_number is 'ST-119.1 / ST-120 certificate on file. Required to defend an exempt sale on audit.';

-- ── Backfill: no retroactive tax ────────────────────────────────────────────
update quotes   set subtotal_cents = round(amount * 100) where subtotal_cents is null;
update invoices set subtotal_cents = round(amount * 100) where subtotal_cents is null;

-- ── Default rate, editable per quote/invoice ────────────────────────────────
-- Nassau and Suffolk County are both 8.625% (4.000% NY State + 4.250% county
-- + 0.375% MCTD). Change here if Apex starts serving a different jurisdiction;
-- NYC is 8.875%. The admin form can override this per document.
insert into app_config (key, value) values
  ('sales_tax_default_milli_pct', '8625'),
  ('sales_tax_default_jurisdiction', 'Nassau / Suffolk County, NY')
on conflict (key) do nothing;

-- ── Integrity: the breakdown must always reconcile to the total ─────────────
create or replace function guard_tax_totals() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare total_c bigint;
begin
  if new.subtotal_cents is null then
    new.subtotal_cents := round(new.amount * 100) - coalesce(new.tax_cents, 0);
  end if;
  if new.tax_exempt then new.tax_cents := 0; end if;

  total_c := coalesce(new.subtotal_cents, 0) + coalesce(new.tax_cents, 0);

  -- Allow a 1-cent tolerance for rounding, then snap amount to the breakdown so
  -- the two can never drift apart.
  if abs(round(new.amount * 100) - total_c) > 1 then
    raise exception 'Tax breakdown does not reconcile: subtotal % + tax % <> amount %',
      new.subtotal_cents, new.tax_cents, round(new.amount * 100);
  end if;
  new.amount := total_c / 100.0;
  return new;
end $$;

drop trigger if exists trg_guard_tax_quotes   on quotes;
drop trigger if exists trg_guard_tax_invoices on invoices;
create trigger trg_guard_tax_quotes   before insert or update on quotes   for each row execute function guard_tax_totals();
create trigger trg_guard_tax_invoices before insert or update on invoices for each row execute function guard_tax_totals();

revoke all on function guard_tax_totals() from public, anon, authenticated;

-- ── Quote → invoice must COPY the agreed tax, never recalculate ─────────────
-- An approved quote is a price the customer accepted. If the default rate later
-- changes, the invoice must still reflect what was agreed.
create or replace function quote_to_invoice(p_quote_id text)
returns invoices language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; inv invoices;
begin
  if not is_admin() then raise exception 'Not permitted'; end if;
  select * into q from quotes where id = p_quote_id for update;
  if not found then raise exception 'Quote not found'; end if;
  if q.status <> 'approved' then raise exception 'Only an approved quote can be invoiced'; end if;
  if q.invoiced then raise exception 'Quote has already been invoiced'; end if;

  insert into invoices (
    customer_id, customer_email, customer_name, company, description, items,
    subtotal_cents, tax_cents, tax_rate_milli_pct, tax_exempt, tax_jurisdiction,
    amount, status, quote_id, due
  ) values (
    q.customer_id, q.customer_email, q.customer_name, q.company,
    coalesce(q.description, 'Forklift Service'), q.items,
    q.subtotal_cents, q.tax_cents, q.tax_rate_milli_pct, q.tax_exempt, q.tax_jurisdiction,
    q.amount, 'unpaid', q.id, now() + interval '30 days'
  ) returning * into inv;

  update quotes set invoiced = true where id = p_quote_id;
  return inv;
end $$;
revoke all on function quote_to_invoice(text) from public, anon, authenticated;
grant  execute on function quote_to_invoice(text) to service_role;

-- ── Emails carry the breakdown ──────────────────────────────────────────────
create or replace function notify_on_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op='INSERT' then
    perform enqueue_notification('invoice_created:'||new.id,'invoice_created',new.customer_email,'invoice',new.id,
      jsonb_build_object('invoice_id',new.id,'customer_name',new.customer_name,'company',new.company,
        'description',new.description,'items',new.items,
        'subtotal', round(coalesce(new.subtotal_cents,0)/100.0,2),
        'tax',      round(coalesce(new.tax_cents,0)/100.0,2),
        'tax_rate', round(coalesce(new.tax_rate_milli_pct,0)/1000.0,3),
        'tax_exempt', new.tax_exempt,
        'amount',new.amount,'due',new.due,'quote_id',new.quote_id,'created_at',new.created_at));
  end if;
  return new;
end $$;
revoke all on function notify_on_invoice() from public, anon, authenticated;

create or replace function notify_on_quote() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare pl jsonb;
begin
  pl := jsonb_build_object('quote_id',new.id,'customer_name',new.customer_name,'company',new.company,
        'equipment',new.equipment,'description',new.description,'items',new.items,
        'subtotal', round(coalesce(new.subtotal_cents,0)/100.0,2),
        'tax',      round(coalesce(new.tax_cents,0)/100.0,2),
        'tax_rate', round(coalesce(new.tax_rate_milli_pct,0)/1000.0,3),
        'tax_exempt', new.tax_exempt,
        'amount',new.amount,'created_at',new.created_at,'responded_at',new.responded_at);
  if tg_op='INSERT' then
    perform enqueue_notification('quote_created:'||new.id,'quote_created',new.customer_email,'quote',new.id,pl);
  elsif tg_op='UPDATE' and old.status='pending' and new.status in ('approved','declined') then
    perform enqueue_notification('quote_'||new.status||':cust:'||new.id,'quote_'||new.status,new.customer_email,'quote',new.id,pl);
    perform enqueue_notification('quote_'||new.status||':admin:'||new.id,'quote_'||new.status||'_admin',cfg('admin_notification_email'),'quote',new.id,pl);
  end if;
  return new;
end $$;
revoke all on function notify_on_quote() from public, anon, authenticated;

-- Payment receipt: invoice total already includes tax; expose the split too.
create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; pl jsonb; ev text;
begin
  if tg_op='UPDATE' and old.status is not distinct from new.status then return new; end if;
  select * into inv from invoices where id = new.invoice_id;
  pl := jsonb_build_object(
        'invoice_id',new.invoice_id,'customer_name',inv.customer_name,'company',inv.company,
        'subtotal',      round(coalesce(inv.subtotal_cents,0)/100.0,2),
        'tax',           round(coalesce(inv.tax_cents,0)/100.0,2),
        'amount',        round(new.amount_cents/100.0,2),
        'fee',           round(coalesce(new.fee_cents,0)/100.0,2),
        'total_charged', round(coalesce(new.total_charged_cents,new.amount_cents)/100.0,2),
        'method',new.method,'method_display',new.method_display,
        'reference',coalesce(new.provider_transaction_id,new.reference),
        'kind',new.kind,'provider',new.provider,
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
revoke all on function notify_on_payment() from public, anon, authenticated;

commit;

-- VERIFY
select 'quotes'   t, count(*) rows, count(*) filter (where subtotal_cents is null) missing_subtotal from quotes
union all
select 'invoices',  count(*),        count(*) filter (where subtotal_cents is null) from invoices;

select id, subtotal_cents, tax_cents, round(amount*100)::bigint amount_cents,
       (subtotal_cents + tax_cents) = round(amount*100)::bigint AS reconciles
from invoices order by created_at desc limit 10;

select key, value from app_config where key like 'sales_tax%';
