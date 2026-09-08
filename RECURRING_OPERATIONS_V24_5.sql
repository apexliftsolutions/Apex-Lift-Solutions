-- APEX V24.5 — recurring operations / notification context
-- Safe additive production migration. Does NOT enable recurring billing.
begin;

insert into app_config(key,value) values ('recurring_billing_enabled','false')
on conflict (key) do nothing;

-- Include workflow/source metadata in invoice notifications so recurring cycle
-- invoices never instruct the customer to use the one-time checkout.
create or replace function public.notify_on_invoice() returns trigger
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
        'amount',new.amount,'due',new.due,'quote_id',new.quote_id,'created_at',new.created_at,
        'invoice_source',new.invoice_source,'subscription_id',new.subscription_id));
  end if;
  return new;
end $$;
revoke all on function public.notify_on_invoice() from public, anon, authenticated;

-- Same V22 event behavior, plus payment_source/subscription context for recurring
-- receipts/failure messages. No payment-state semantics are changed here.
create or replace function public.notify_on_payment()
returns trigger language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare inv invoices; pl jsonb; ev text;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  select * into inv from invoices where id = new.invoice_id;
  pl := jsonb_build_object(
    'invoice_id', new.invoice_id,
    'customer_name', inv.customer_name,
    'company', inv.company,
    'subtotal', round(coalesce(inv.subtotal_cents,0) / 100.0, 2),
    'tax', round(coalesce(inv.tax_cents,0) / 100.0, 2),
    'amount', round(new.amount_cents / 100.0, 2),
    'refund_amount', case when new.kind in ('refund','reversal') then round(new.amount_cents / 100.0, 2) else null end,
    'fee', round(coalesce(new.fee_cents,0) / 100.0, 2),
    'total_charged', round(coalesce(new.total_charged_cents,new.amount_cents) / 100.0, 2),
    'method', new.method,
    'method_display', new.method_display,
    'reference', coalesce(new.provider_transaction_id,new.reference),
    'kind', new.kind,
    'provider', new.provider,
    'payment_source', new.payment_source,
    'subscription_id', new.subscription_id,
    'reason', nullif(trim(coalesce(new.notes,'')), ''),
    'original_payment_id', new.refund_of,
    'processed_at', coalesce(new.settled_at,new.approved_at,new.completed_at,now())
  );
  if new.kind = 'payment' and new.status = 'succeeded' then ev := 'payment_received';
  elsif new.kind = 'payment' and new.status = 'pending' and new.method = 'ach' then ev := 'ach_submitted';
  elsif new.kind = 'payment' and new.status = 'failed' then ev := 'payment_declined';
  elsif new.kind = 'refund' and new.status = 'succeeded' then ev := 'payment_refunded';
  elsif new.kind = 'reversal' and new.status = 'succeeded' then ev := 'payment_voided';
  else return new;
  end if;
  perform enqueue_notification(ev || ':cust:' || new.id, ev, inv.customer_email, 'payment', new.id::text, pl);
  if ev <> 'payment_declined' then
    perform enqueue_notification(ev || ':admin:' || new.id, ev || '_admin', cfg('admin_notification_email'), 'payment', new.id::text, pl);
  end if;
  return new;
end $$;
revoke all on function public.notify_on_payment() from public, anon, authenticated;

commit;
