-- ==========================================================================
-- APEX LIFT SOLUTIONS — REFUND / VOID V22
-- Non-destructive production patch.
--
-- Purpose:
--   1) keep provider REVERSAL/VOID distinct from a true REFUND;
--   2) add refund/void amount + reason + original payment id to outbox payloads;
--   3) send payment_voided/payment_voided_admin for reversal rows;
--   4) preserve append-only payment history.
--
-- Safe to run once on the current production schema. It does not delete data.
-- ==========================================================================

begin;

create or replace function public.recalc_invoice_status(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  inv invoices;
  paid_c bigint;
  refund_c bigint;
  reversal_c bigint;
  pending_c bigint;
  total_c bigint;
  net_c bigint;
begin
  select * into inv
  from invoices
  where id = p_invoice_id
  for update;

  if not found or inv.status in ('void','hidden') then
    return;
  end if;

  total_c := round(inv.amount * 100);

  -- Base money applied to the Apex invoice. Fee Saver is not invoice revenue.
  select coalesce(sum(amount_cents), 0)
  into paid_c
  from payments
  where invoice_id = p_invoice_id
    and kind = 'payment'
    and status = 'succeeded';

  -- Actual money returned after a completed payment.
  select coalesce(sum(amount_cents), 0)
  into refund_c
  from payments
  where invoice_id = p_invoice_id
    and kind = 'refund'
    and status = 'succeeded';

  -- Provider void/reverse: the original payment no longer counts as collected.
  select coalesce(sum(amount_cents), 0)
  into reversal_c
  from payments
  where invoice_id = p_invoice_id
    and kind = 'reversal'
    and status = 'succeeded';

  select coalesce(sum(amount_cents), 0)
  into pending_c
  from payments
  where invoice_id = p_invoice_id
    and kind = 'payment'
    and status in ('initiated','pending');

  net_c := greatest(paid_c - refund_c - reversal_c, 0);

  -- Refunds preserve explicit refund history/state.
  if refund_c > 0 then
    if net_c = 0 then
      update invoices
      set status = 'refunded'
      where id = p_invoice_id;
    else
      update invoices
      set status = 'partially_refunded'
      where id = p_invoice_id;
    end if;

  elsif net_c >= total_c then
    update invoices
    set status = 'paid',
        paid_at = coalesce(paid_at, now())
    where id = p_invoice_id;

  elsif pending_c > 0 then
    update invoices
    set status = 'payment_pending',
        paid_at = null
    where id = p_invoice_id;

  else
    -- Includes a fully reversed/voided payment on an invoice that itself is
    -- still valid. It becomes payable again.
    update invoices
    set status = 'unpaid',
        paid_at = null,
        paid_via = null,
        payment_id = null
    where id = p_invoice_id;
  end if;
end
$function$;


create or replace function public.notify_on_payment()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  inv invoices;
  pl jsonb;
  ev text;
begin
  -- Do not enqueue twice for an UPDATE that did not change payment status.
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status then
    return new;
  end if;

  select * into inv
  from invoices
  where id = new.invoice_id;

  pl := jsonb_build_object(
    'invoice_id', new.invoice_id,
    'customer_name', inv.customer_name,
    'company', inv.company,
    'subtotal', round(coalesce(inv.subtotal_cents,0) / 100.0, 2),
    'tax', round(coalesce(inv.tax_cents,0) / 100.0, 2),
    'amount', round(new.amount_cents / 100.0, 2),
    'refund_amount', case
      when new.kind in ('refund','reversal') then round(new.amount_cents / 100.0, 2)
      else null
    end,
    'fee', round(coalesce(new.fee_cents,0) / 100.0, 2),
    'total_charged', round(coalesce(new.total_charged_cents,new.amount_cents) / 100.0, 2),
    'method', new.method,
    'method_display', new.method_display,
    'reference', coalesce(new.provider_transaction_id,new.reference),
    'kind', new.kind,
    'provider', new.provider,
    'reason', nullif(trim(coalesce(new.notes,'')), ''),
    'original_payment_id', new.refund_of,
    'processed_at', coalesce(new.settled_at,new.approved_at,new.completed_at,now())
  );

  if new.kind = 'payment' and new.status = 'succeeded' then
    ev := 'payment_received';

  elsif new.kind = 'payment'
        and new.status = 'pending'
        and new.method = 'ach' then
    ev := 'ach_submitted';

  elsif new.kind = 'payment' and new.status = 'failed' then
    ev := 'payment_declined';

  elsif new.kind = 'refund' and new.status = 'succeeded' then
    ev := 'payment_refunded';

  elsif new.kind = 'reversal' and new.status = 'succeeded' then
    ev := 'payment_voided';

  else
    return new;
  end if;

  perform enqueue_notification(
    ev || ':cust:' || new.id,
    ev,
    inv.customer_email,
    'payment',
    new.id::text,
    pl
  );

  if ev <> 'payment_declined' then
    perform enqueue_notification(
      ev || ':admin:' || new.id,
      ev || '_admin',
      cfg('admin_notification_email'),
      'payment',
      new.id::text,
      pl
    );
  end if;

  return new;
end
$function$;

commit;

-- --------------------------------------------------------------------------
-- READ-ONLY VERIFY
-- --------------------------------------------------------------------------
select p.proname as function_name,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('recalc_invoice_status','notify_on_payment')
order by p.proname;
