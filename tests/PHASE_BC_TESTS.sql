-- =============================================================================
-- PHASE B / C — ADVERSARIAL + BEHAVIOURAL TESTS
--
-- Exercises the offer → agreement flow the Edge Functions drive, at the layer
-- that actually enforces the rules. PASS means the database refused something
-- it must refuse, or performed something it must perform.
--
-- LOCAL / STAGING ONLY. Creates fake customers, equipment, offers, agreements,
-- invoices and payments. Never run this against production.
-- =============================================================================
\set ON_ERROR_STOP off
\pset format aligned
\t on

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@apexliftsolutionsusa.com"}', false);

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into customer_equipment (id, customer_id, unit_number, year, make, model, serial_number, service_location) values
  ('bc000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','FL-21','2019','Toyota','8FGCU25','BC-1001','Bay 3 — Hicksville NY'),
  ('bc000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','FL-22','2021','Crown','FC4500','BC-1002','Bay 4'),
  ('bc000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','FL-90','2018','Hyster','H50XT','BC-9001','Elsewhere Ltd')
on conflict do nothing;

-- Priced the way service-plans-admin prices them: ACH $180 / card $189, 8.625%.
insert into service_plan_offers (id, customer_id, equipment_id, status, plan_name, description,
  included_services, exclusions, term_months, activation_date,
  ach_monthly_subtotal_cents, ach_monthly_tax_cents, ach_monthly_total_cents,
  card_monthly_subtotal_cents, card_monthly_tax_cents, card_monthly_total_cents,
  tax_rate_milli_pct, tax_jurisdiction, sent_at, expires_at) values
  ('bcf00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','bc000000-0000-0000-0000-000000000001',
   'draft','Monthly Planned Maintenance — Standard','Scheduled PM for one unit.',
   '["250-hour PM service","Fluid + filter replacement","Safety inspection"]'::jsonb,
   '["Tires","Forks","Battery replacement"]'::jsonb,
   6, current_date + 7, 18000,1553,19553, 18900,1630,20530, 8625,'Nassau County, NY', null, null),
  ('bcf00000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','bc000000-0000-0000-0000-000000000002',
   'draft','Second unit plan',null,'[]'::jsonb,'[]'::jsonb,
   6, current_date + 7, 18000,1553,19553, 18900,1630,20530, 8625,'Nassau County, NY', null, null)
on conflict do nothing;

\echo ''
\echo '═══════ 1. OFFER SENT → EXACTLY-ONCE CUSTOMER EMAIL ═══════'
do $$
declare n int; before int; pl jsonb;
begin
  select count(*) into before from notification_outbox where event_type='service_plan_offer_sent';

  -- B1 a draft queues nothing
  select count(*) into n from notification_outbox
   where event_key='service_plan_offer_sent:bcf00000-0000-0000-0000-000000000001';
  raise notice '% B1  a draft offer queues no email', case when n=0 then 'PASS' else 'FAIL' end;

  -- B2 draft -> sent queues exactly one
  update service_plan_offers set status='sent', sent_at=now(), expires_at=now()+interval '30 days'
   where id='bcf00000-0000-0000-0000-000000000001';
  select count(*) into n from notification_outbox
   where event_key='service_plan_offer_sent:bcf00000-0000-0000-0000-000000000001';
  raise notice '% B2  sending the offer queues exactly one customer email', case when n=1 then 'PASS' else 'FAIL' end;

  -- B3 the payload carries both rail prices, so the email can show the choice
  select payload into pl from notification_outbox
   where event_key='service_plan_offer_sent:bcf00000-0000-0000-0000-000000000001';
  raise notice '% B3  payload carries both rails, unit and serial (%s ACH / %s card)',
    case when (pl->>'ach_total_cents')='19553' and (pl->>'card_total_cents')='20530'
          and (pl->>'unit_number')='FL-21' and (pl->>'serial_number')='BC-1001'
         then 'PASS' else 'FAIL' end,
    pl->>'ach_total_cents', pl->>'card_total_cents';

  -- B4 the email goes to the customer, not to whoever asked
  select count(*) into n from notification_outbox
   where event_key='service_plan_offer_sent:bcf00000-0000-0000-0000-000000000001'
     and recipient='buyer@acmewarehouse.com';
  raise notice '% B4  addressed to the owning customer', case when n=1 then 'PASS' else 'FAIL' end;

  -- B5 a redundant update does not queue a second copy
  update service_plan_offers set expires_at=now()+interval '31 days'
   where id='bcf00000-0000-0000-0000-000000000001';
  select count(*) into n from notification_outbox
   where event_key='service_plan_offer_sent:bcf00000-0000-0000-0000-000000000001';
  raise notice '% B5  touching the offer again does not duplicate the email', case when n=1 then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 2. SIGNING THROUGH THE ATOMIC RPC ═══════'
do $$
declare ok boolean; a service_plan_agreements; o service_plan_offers; n int;
begin
  -- C1 the browser cannot sign at the wrong rail's price: the RPC reads the
  --    price out of the offer, so asking for card gets the CARD price.
  a := accept_offer_and_sign_agreement(
        'bcf00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'card','APEX-MSP-2026-09-DRAFT','Dana Reyes','Operations Manager','Dana Reyes',
        true,true,true,true,'{"sections":[{"heading":"1. Parties","body":"…"}]}'::jsonb,'iphash','UA');
  raise notice '% C1  card selection is signed at the CARD price (% cents)',
    case when a.monthly_total_cents=20530 and a.selected_payment_method='card' then 'PASS' else 'FAIL' end,
    a.monthly_total_cents;

  -- C2 the database's own numbers are stamped into the stored snapshot
  raise notice '% C2  snapshot carries DB-authoritative pricing and both rail totals',
    case when (a.snapshot->'authoritative'->>'monthly_total_cents')='20530'
          and (a.snapshot->'authoritative'->>'offer_ach_total_cents')='19553'
          and (a.snapshot->'authoritative'->>'source')='database'
         then 'PASS' else 'FAIL' end;

  -- C3 the caller's contract body survives alongside it
  raise notice '% C3  the server-rendered contract body is preserved',
    case when jsonb_array_length(a.snapshot->'sections')=1 then 'PASS' else 'FAIL' end;

  -- C4 offer accepted in the same transaction
  select * into o from service_plan_offers where id='bcf00000-0000-0000-0000-000000000001';
  raise notice '% C4  the offer is accepted atomically with the signature',
    case when o.status='accepted' and o.accepted_at is not null then 'PASS' else 'FAIL' end;

  -- C5 agreement-signed emails: one to the customer, one to the admin
  select count(*) into n from notification_outbox
   where event_key in ('service_plan_agreement_signed:'||a.id,
                       'service_plan_agreement_signed:admin:'||a.id);
  raise notice '% C5  signing queues exactly two emails (customer + admin)', case when n=2 then 'PASS' else 'FAIL' end;

  -- C6 the signed email must NOT leak a PDF path or a durable link
  select count(*) into n from notification_outbox
   where event_key='service_plan_agreement_signed:'||a.id
     and (payload ? 'pdf_path' or payload::text ilike '%apex-agreements%');
  raise notice '% C6  the signed-agreement email carries no PDF path or bucket link',
    case when n=0 then 'PASS' else 'FAIL' end;

  -- C7 signing the same offer twice
  ok := false;
  begin
    perform accept_offer_and_sign_agreement(
      'bcf00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
      'ach','v1','Dana Reyes','Ops','Dana Reyes',true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% C7  the same offer cannot be signed twice', case when ok then 'PASS' else 'FAIL' end;

  -- C8 another customer cannot sign it
  ok := false;
  begin
    perform accept_offer_and_sign_agreement(
      'bcf00000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222',
      'ach','v1','Sam Vale','Ops','Sam Vale',true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% C8  a customer cannot sign another customer''s offer', case when ok then 'PASS' else 'FAIL' end;

  -- C9 an empty contract body is refused rather than synthesized
  update service_plan_offers set status='sent', sent_at=now(), expires_at=now()+interval '30 days'
   where id='bcf00000-0000-0000-0000-000000000002';
  ok := false;
  begin
    perform accept_offer_and_sign_agreement(
      'bcf00000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
      'ach','v1','Dana Reyes','Ops','Dana Reyes',true,true,true,true,null,null,null);
  exception when others then ok := true; end;
  raise notice '% C9  a missing contract body is refused', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 3. PDF ARTEFACTS ARE WRITE-ONCE ═══════'
do $$
declare ok boolean; agr uuid;
begin
  select id into agr from service_plan_agreements where offer_id='bcf00000-0000-0000-0000-000000000001';

  update service_plan_agreements
     set pdf_path='agreements/11111111-1111-1111-1111-111111111111/'||agr||'.pdf',
         document_sha256=repeat('a',64), snapshot_sha256=repeat('b',64), pdf_generated_at=now()
   where id=agr;
  raise notice 'PASS D1  the PDF path and both hashes can be written once';

  ok := false;
  begin update service_plan_agreements set document_sha256=repeat('c',64) where id=agr;
  exception when others then ok := true; end;
  raise notice '% D2  the document hash cannot be replaced', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_plan_agreements set pdf_path='agreements/attacker/swap.pdf' where id=agr;
  exception when others then ok := true; end;
  raise notice '% D3  the stored PDF cannot be swapped', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_plan_agreements set snapshot_sha256=repeat('d',64) where id=agr;
  exception when others then ok := true; end;
  raise notice '% D4  the snapshot hash cannot be replaced', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 4. PAYMENT-CHECKOUT GUARD (the column it reads) ═══════'
do $$
declare ok boolean; agr uuid; sub uuid; src text;
begin
  select id into agr from service_plan_agreements where offer_id='bcf00000-0000-0000-0000-000000000001';
  sub := (create_subscription_from_agreement(agr)).id;
  update service_subscriptions set status='method_verified' where id=sub;
  update service_subscriptions set status='active', provider_subscription_id=77001,
         provider_customer_code='CST9001', provider_verified_at=now() where id=sub;

  insert into invoices (id, customer_id, customer_email, customer_name, company, description,
    subtotal_cents, tax_cents, tax_rate_milli_pct, amount, status,
    invoice_source, subscription_id, billing_period_start, billing_period_end)
  values ('INV-BCRECUR0001','11111111-1111-1111-1111-111111111111','buyer@acmewarehouse.com','Dana Reyes',
    'Acme Warehouse','Monthly Service Plan — FL-21', 18900,1630,8625, 205.30,'unpaid',
    'recurring', sub, date '2026-11-01', date '2026-11-30');

  -- E1 payment-checkout selects invoice_source; it must exist and be readable.
  select invoice_source into src from invoices where id='INV-BCRECUR0001';
  raise notice '% E1  a recurring invoice reports invoice_source=recurring (guard input present)',
    case when src='recurring' then 'PASS' else 'FAIL' end;

  select invoice_source into src from invoices where id='INV-1A10E21B68';
  raise notice '% E2  the existing V23 invoice still reports one_time (guard lets it through)',
    case when src='one_time' then 'PASS' else 'FAIL' end;

  -- E3 a recurring invoice cannot masquerade as one_time
  ok := false;
  begin update invoices set invoice_source='one_time' where id='INV-BCRECUR0001';
  exception when others then ok := true; end;
  raise notice '% E3  a recurring invoice cannot be relabelled one_time to bypass the guard',
    case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 5. NOTHING RECURRING HAS BEEN ENABLED ═══════'
do $$
declare n int;
begin
  raise notice '% F1  recurring_billing_enabled is still false',
    case when cfg_bool('recurring_billing_enabled')=false then 'PASS' else 'FAIL' end;

  select count(*) into n from app_config where key='service_plan_contract_mode' and value='test';
  raise notice '% F2  contract mode is still test (PDFs stamped DRAFT)', case when n=1 then 'PASS' else 'FAIL' end;

  -- Phase C must not collect payment details or reach the provider.
  select count(*) into n from service_subscriptions where payment_method_verified_at is not null;
  raise notice '% F3  no payment method has been verified in Phase C', case when n=0 then 'PASS' else 'FAIL' end;

  select count(*) into n from payments where payment_source='recurring';
  raise notice '% F4  no recurring money row exists', case when n=0 then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 6. RLS — CUSTOMER SEES ONLY THEIR OWN, NEVER A DRAFT ═══════'
\t off
set role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","email":"buyer@acmewarehouse.com"}', false);

select case when count(*)=0 then 'PASS' else 'FAIL' end || ' G1 no draft offers are visible' as result
  from service_plan_offers where status='draft';
select case when count(*)>0 then 'PASS' else 'FAIL' end || ' G2 their own sent/accepted offers are visible' as result
  from service_plan_offers;
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' G3 another customer''s equipment is invisible' as result
  from customer_equipment where customer_id='22222222-2222-2222-2222-222222222222';
select case when count(*)=1 then 'PASS' else 'FAIL' end || ' G4 their own signed agreement is visible' as result
  from service_plan_agreements;

\echo '-- G5..G7: the browser cannot write any service plan table --'
insert into customer_equipment (customer_id, unit_number) values ('11111111-1111-1111-1111-111111111111','SELF-ADDED');
update service_plan_offers set ach_monthly_total_cents = 1 where customer_id='11111111-1111-1111-1111-111111111111';
update service_plan_agreements set monthly_total_cents = 1 where customer_id='11111111-1111-1111-1111-111111111111';

reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@apexliftsolutionsusa.com"}', false);

\echo ''
\echo '═══════ 7. EXISTING V23 ONE-TIME FLOW STILL INTACT ═══════'
select 'invoice ' || id || ' = ' || status || ' / ' || invoice_source as one_time
  from invoices where id='INV-1A10E21B68';
select 'net retained on the reversed invoice = ' ||
  (coalesce(sum(amount_cents) filter (where kind='payment' and status='succeeded'),0)
 - coalesce(sum(amount_cents) filter (where kind in ('refund','reversal') and status='succeeded'),0))
  || ' cents (0 = V23 retry still permitted)' as one_time
  from payments where invoice_id='INV-1A10E21B68';
select 'original one_time payments untouched: ' || count(*) as one_time
  from payments where payment_source='one_time' and subscription_id is null;
