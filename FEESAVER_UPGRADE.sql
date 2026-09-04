-- =============================================================================
-- APEX LIFT SOLUTIONS — FEE SAVER SUPPORT  (NON-DESTRUCTIVE)
-- Run AFTER PRODUCTION_UPGRADE.sql. Safe to re-run. No DROP TABLE / TRUNCATE.
--
-- Why this is needed:
--   With Helcim Fee Saver, a CARD transaction's `amount` is the TOTAL charged
--   (base invoice + convenience fee). ACH has no fee. If we stored the total in
--   payments.amount_cents, the invoice ledger would over-state what the invoice
--   was actually settled for.
--
--   So we store three separate numbers:
--     amount_cents         base amount applied to the invoice  (settles it)
--     fee_cents            convenience fee, 0 for ACH
--     total_charged_cents  what the customer's card was actually charged
--
--   recalc_invoice_status() continues to use amount_cents only.
-- =============================================================================

begin;

alter table payments add column if not exists fee_cents           bigint not null default 0 check (fee_cents >= 0);
alter table payments add column if not exists total_charged_cents bigint;

-- Backfill existing rows: no Fee Saver was in effect, so charged == base.
update payments set total_charged_cents = amount_cents where total_charged_cents is null;

comment on column payments.amount_cents         is 'Base amount applied to the invoice. Excludes any convenience fee.';
comment on column payments.fee_cents            is 'Helcim Fee Saver convenience fee. Always 0 for ACH.';
comment on column payments.total_charged_cents  is 'Total actually charged to the customer = amount_cents + fee_cents.';

-- ── Guardrail for what may auto-settle ──────────────────────────────────────
-- Helcim does not return a field that separates the convenience fee from the
-- base on the card-transaction object, so the fee can only be INFERRED as
-- (charged - base). We will not auto-settle an inferred fee larger than this
-- ceiling; anything above it lands in 'unknown' for a human to look at.
--
-- This is a sanity bound, NOT a fee calculation. Set it slightly above the
-- highest rate Helcim actually applies to your account (check Fee Saver
-- Settings). Expressed in basis points: 500 = 5.00%.
insert into app_config (key, value) values
  ('feesaver_max_fee_bps', '500'),
  ('feesaver_max_fee_floor_cents', '100')
on conflict (key) do nothing;

-- ── Invoice status still derives from the BASE amount only ──────────────────
create or replace function recalc_invoice_status(p_invoice_id text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; paid_c bigint; refund_c bigint; pending_c bigint; total_c bigint;
begin
  select * into inv from invoices where id = p_invoice_id for update;
  if not found or inv.status in ('void','hidden') then return; end if;
  total_c := round(inv.amount * 100);

  -- amount_cents is the base applied to the invoice; convenience fees are
  -- revenue for the processor, not payment against the invoice.
  select coalesce(sum(amount_cents),0) into paid_c
    from payments where invoice_id = p_invoice_id and kind = 'payment' and status = 'succeeded';
  select coalesce(sum(amount_cents),0) into refund_c
    from payments where invoice_id = p_invoice_id and kind in ('refund','reversal') and status = 'succeeded';
  select coalesce(sum(amount_cents),0) into pending_c
    from payments where invoice_id = p_invoice_id and kind = 'payment' and status in ('initiated','pending');

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
revoke all on function recalc_invoice_status(text) from public, anon, authenticated;
grant  execute on function recalc_invoice_status(text) to service_role;

-- ── Receipt emails should show base / fee / total ───────────────────────────
create or replace function notify_on_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; pl jsonb; ev text;
begin
  if tg_op='UPDATE' and old.status is not distinct from new.status then return new; end if;
  select * into inv from invoices where id = new.invoice_id;
  pl := jsonb_build_object(
        'invoice_id',new.invoice_id,'customer_name',inv.customer_name,'company',inv.company,
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
select column_name, data_type from information_schema.columns
where table_name='payments' and column_name in ('amount_cents','fee_cents','total_charged_cents');
select key, value from app_config where key like 'feesaver%';
