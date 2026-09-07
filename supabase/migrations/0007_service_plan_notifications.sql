-- =============================================================================
-- APEX LIFT SOLUTIONS — SERVICE PLANS PHASE B/C
-- Notification triggers only.  NON-DESTRUCTIVE.  Safe to re-run.
--
-- Phase A deliberately shipped without notification triggers on the service
-- plan tables so that nothing could queue an email the outbox worker could not
-- render. The worker now has the four matching templates, so the triggers land
-- here.
--
-- This migration does NOT modify anything created by 0006_service_plans.sql.
-- It adds two trigger functions and two triggers, nothing else.
--
-- Exactly-once is inherited from notification_outbox.event_key being unique and
-- enqueue_notification being `on conflict do nothing`. Because these are
-- triggers, the enqueue happens in the SAME transaction as the business write:
-- an offer cannot be sent without its email being queued, and a queued email
-- cannot exist for an offer that was rolled back.
-- =============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. OFFER SENT → notify the customer
--
-- Fires on the draft→sent transition, and on an offer inserted directly as
-- 'sent'. Both rail prices are carried in the payload so the email can show the
-- comparison the customer is being asked to choose between.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.notify_on_service_plan_offer() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  e record;
  pl jsonb;
begin
  if tg_op = 'UPDATE' and not (old.status = 'draft' and new.status = 'sent') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status <> 'sent' then
    return new;
  end if;

  select id, email, name, company into c from customers where id = new.customer_id;
  if c.email is null then return new; end if;

  select unit_number, year, make, model, serial_number, service_location
    into e from customer_equipment where id = new.equipment_id;

  pl := jsonb_build_object(
    'offer_id',            new.id,
    'customer_name',       c.name,
    'company',             c.company,
    'plan_name',           new.plan_name,
    'description',         new.description,
    'included_services',   new.included_services,
    'exclusions',          new.exclusions,
    'unit_number',         e.unit_number,
    'equipment',           trim(both ' ' from concat_ws(' ', e.year, e.make, e.model)),
    'serial_number',       e.serial_number,
    'service_location',    e.service_location,
    'term_months',         new.term_months,
    'activation_date',     new.activation_date,
    'expires_at',          new.expires_at,
    'ach_subtotal_cents',  new.ach_monthly_subtotal_cents,
    'ach_tax_cents',       new.ach_monthly_tax_cents,
    'ach_total_cents',     new.ach_monthly_total_cents,
    'card_subtotal_cents', new.card_monthly_subtotal_cents,
    'card_tax_cents',      new.card_monthly_tax_cents,
    'card_total_cents',    new.card_monthly_total_cents,
    'tax_rate',            round(coalesce(new.tax_rate_milli_pct,0)/1000.0, 3),
    'tax_exempt',          new.tax_exempt
  );

  perform enqueue_notification(
    'service_plan_offer_sent:' || new.id, 'service_plan_offer_sent',
    c.email, 'service_plan_offer', new.id::text, pl);

  return new;
end $$;
revoke all on function public.notify_on_service_plan_offer() from public, anon, authenticated;

drop trigger if exists trg_notify_service_plan_offer on service_plan_offers;
create trigger trg_notify_service_plan_offer
  after insert or update on service_plan_offers
  for each row execute function public.notify_on_service_plan_offer();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. AGREEMENT SIGNED → notify the customer AND the admin
--
-- Note what the payload deliberately does NOT contain: any link to the PDF.
-- Signed agreements are private and are only ever reached through a short-lived
-- signed URL minted for the authenticated owner. The email tells them to sign
-- in; it does not carry the document or a durable link to it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.notify_on_service_plan_agreement() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  e record;
  pl jsonb;
begin
  select id, email, name, company into c from customers where id = new.customer_id;

  select unit_number, year, make, model, serial_number, service_location
    into e from customer_equipment where id = new.equipment_id;

  pl := jsonb_build_object(
    'agreement_id',      new.id,
    'offer_id',          new.offer_id,
    'customer_name',     c.name,
    'company',           c.company,
    'customer_email',    c.email,
    'agreement_version', new.agreement_version,
    'payment_method',    new.selected_payment_method,
    'subtotal_cents',    new.monthly_subtotal_cents,
    'tax_cents',         new.monthly_tax_cents,
    'total_cents',       new.monthly_total_cents,
    'term_months',       new.term_months,
    'activation_date',   new.activation_date,
    'signer_name',       new.signer_name,
    'signer_title',      new.signer_title,
    'signed_at',         new.signed_at,
    'unit_number',       e.unit_number,
    'equipment',         trim(both ' ' from concat_ws(' ', e.year, e.make, e.model)),
    'serial_number',     e.serial_number,
    'service_location',  e.service_location,
    'plan_name',         (select plan_name from service_plan_offers where id = new.offer_id)
  );

  if c.email is not null then
    perform enqueue_notification(
      'service_plan_agreement_signed:' || new.id, 'service_plan_agreement_signed',
      c.email, 'service_plan_agreement', new.id::text, pl);
  end if;

  perform enqueue_notification(
    'service_plan_agreement_signed:admin:' || new.id, 'service_plan_agreement_signed_admin',
    cfg('admin_notification_email'), 'service_plan_agreement', new.id::text, pl);

  return new;
end $$;
revoke all on function public.notify_on_service_plan_agreement() from public, anon, authenticated;

drop trigger if exists trg_notify_service_plan_agreement on service_plan_agreements;
create trigger trg_notify_service_plan_agreement
  after insert on service_plan_agreements
  for each row execute function public.notify_on_service_plan_agreement();

commit;

-- =============================================================================
-- READ-ONLY VERIFY
-- =============================================================================
select 'notification triggers' as check, count(*) as found, 2 as expected
  from pg_trigger
 where tgname in ('trg_notify_service_plan_offer','trg_notify_service_plan_agreement');

-- Still false. Phase B/C create no subscriptions and collect no payment details.
select key, value from app_config
 where key in ('recurring_billing_enabled','service_plan_contract_mode') order by key;
