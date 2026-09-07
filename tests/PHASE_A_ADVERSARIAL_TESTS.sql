-- =============================================================================
-- PHASE A — REVISION 2 ADVERSARIAL TEST SUITE
-- Every block ATTEMPTS something that must be impossible and reports PASS only
-- when the database refused it. Positive-control tests report PASS only when
-- the legitimate operation SUCCEEDS.
-- =============================================================================
\set ON_ERROR_STOP off
\pset format aligned
\t on

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@apexliftsolutionsusa.com"}', false);

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into customer_equipment (id, customer_id, unit_number, make, model, serial_number, service_location) values
  ('e0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','FL-07','Toyota','8FGCU25','SER-12345','Bay 3 — Hicksville NY'),
  ('e0000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','FL-99','Hyster','H50XT','SER-99999','Elsewhere Ltd'),
  ('e0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','FL-08','Toyota','8FGCU25','SER-22222',null),
  ('e0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','FL-09','Crown','FC4500','SER-33333',null),
  ('e0000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','FL-10','Yale','GLC050','SER-44444',null),
  ('e0000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','FL-11','Clark','C25','SER-55555',null)
on conflict do nothing;

-- ACH $180.00 + 8.625% = $195.53 ; CARD $189.00 + 8.625% = $205.30
insert into service_plan_offers (id, customer_id, equipment_id, status, plan_name, included_services, exclusions,
  term_months, activation_date, ach_monthly_subtotal_cents, ach_monthly_tax_cents, ach_monthly_total_cents,
  card_monthly_subtotal_cents, card_monthly_tax_cents, card_monthly_total_cents,
  tax_rate_milli_pct, tax_jurisdiction, sent_at, expires_at) values
  -- offA1: the happy path
  ('f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001',
   'sent','Monthly Planned Maintenance — Standard',
   '["250-hour PM service","Fluid + filter replacement","Safety inspection"]'::jsonb,
   '["Tires","Forks","Battery replacement","Damage from misuse"]'::jsonb,
   6, current_date + 7, 18000, 1553, 19553, 18900, 1630, 20530, 8625, 'Nassau County, NY', now(), now() + interval '30 days'),
  -- offA2: an internal DRAFT
  ('f0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000003',
   'draft','INTERNAL DRAFT — not sent','[]'::jsonb,'[]'::jsonb,
   6, current_date + 7, 18000, 1553, 19553, 18900, 1630, 20530, 8625, 'Nassau County, NY', null, null),
  -- offA3: sent but EXPIRED
  ('f0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000004',
   'sent','Expired Offer','[]'::jsonb,'[]'::jsonb,
   6, current_date + 7, 18000, 1553, 19553, 18900, 1630, 20530, 8625, 'Nassau County, NY',
   now() - interval '40 days', now() - interval '10 days'),
  -- offA4: sent, used as the target of invalid signing attempts
  ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000005',
   'sent','Attack Target','[]'::jsonb,'[]'::jsonb,
   6, current_date + 7, 18000, 1553, 19553, 18900, 1630, 20530, 8625, 'Nassau County, NY', now(), now() + interval '30 days'),
  -- offA5: second full chain, for terminal-state tests
  ('f0000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000006',
   'sent','Terminal State Chain','[]'::jsonb,'[]'::jsonb,
   6, current_date + 7, 18000, 1553, 19553, 18900, 1630, 20530, 8625, 'Nassau County, NY', now(), now() + interval '30 days')
on conflict do nothing;

\echo ''
\echo '═══════ 1. CROSS-ENTITY / CROSS-CUSTOMER INTEGRITY ═══════'
do $$
declare ok boolean;
begin
  -- X1 Customer A's offer pointing at Customer B's forklift
  ok := false;
  begin
    insert into service_plan_offers (customer_id, equipment_id, plan_name,
      ach_monthly_subtotal_cents, ach_monthly_tax_cents, ach_monthly_total_cents,
      card_monthly_subtotal_cents, card_monthly_tax_cents, card_monthly_total_cents)
    values ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000002',
            'A''s plan on B''s forklift', 18000,1553,19553, 18900,1630,20530);
  exception when others then ok := true; end;
  raise notice '% X1  offer cannot reference another customer''s equipment', case when ok then 'PASS' else 'FAIL' end;

  -- X2 agreement whose customer is not the offer's customer
  ok := false;
  begin
    insert into service_plan_agreements (offer_id, customer_id, equipment_id, agreement_version,
      selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
      term_months, activation_date, snapshot, signer_name, signature_typed,
      consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel)
    values ('f0000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222',
            'e0000000-0000-0000-0000-000000000005','v1','ach',18000,1553,19553,6,current_date+7,
            '{"x":1}'::jsonb,'Sam Vale','Sam Vale',true,true,true,true);
  exception when others then ok := true; end;
  raise notice '% X2  agreement customer must be the offer''s customer', case when ok then 'PASS' else 'FAIL' end;

  -- X3 agreement pointing at different equipment than the offer
  ok := false;
  begin
    insert into service_plan_agreements (offer_id, customer_id, equipment_id, agreement_version,
      selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
      term_months, activation_date, snapshot, signer_name, signature_typed,
      consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel)
    values ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000003','v1','ach',18000,1553,19553,6,current_date+7,
            '{"x":1}'::jsonb,'Dana Reyes','Dana Reyes',true,true,true,true);
  exception when others then ok := true; end;
  raise notice '% X3  agreement equipment must be the offer''s equipment', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 2. AGREEMENT INSERT VALIDATION ═══════'
do $$
declare ok boolean; a service_plan_agreements; o service_plan_offers;
begin
  -- A1 right rail, wrong amount
  ok := false;
  begin
    insert into service_plan_agreements (offer_id, customer_id, equipment_id, agreement_version,
      selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
      term_months, activation_date, snapshot, signer_name, signature_typed,
      consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel)
    values ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000005','v1','ach', 9000, 776, 9776, 6, current_date+7,
            '{"x":1}'::jsonb,'Dana Reyes','Dana Reyes',true,true,true,true);
  exception when others then ok := true; end;
  raise notice '% A1  agreement price mismatch refused', case when ok then 'PASS' else 'FAIL' end;

  -- A2 selects CARD but carries the ACH price (the cheap-rail attack)
  ok := false;
  begin
    insert into service_plan_agreements (offer_id, customer_id, equipment_id, agreement_version,
      selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
      term_months, activation_date, snapshot, signer_name, signature_typed,
      consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel)
    values ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000005','v1','card', 18000, 1553, 19553, 6, current_date+7,
            '{"x":1}'::jsonb,'Dana Reyes','Dana Reyes',true,true,true,true);
  exception when others then ok := true; end;
  raise notice '% A2  card rail cannot be signed at the ACH price', case when ok then 'PASS' else 'FAIL' end;

  -- A3 against a DRAFT offer
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000002',
      '11111111-1111-1111-1111-111111111111','ach','v1','Dana Reyes','Ops','Dana Reyes',
      true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% A3  a draft offer cannot be signed', case when ok then 'PASS' else 'FAIL' end;

  -- A4 against an EXPIRED offer
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000003',
      '11111111-1111-1111-1111-111111111111','ach','v1','Dana Reyes','Ops','Dana Reyes',
      true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% A4  an expired offer cannot be signed', case when ok then 'PASS' else 'FAIL' end;

  -- A5 wrong term
  ok := false;
  begin
    insert into service_plan_agreements (offer_id, customer_id, equipment_id, agreement_version,
      selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
      term_months, activation_date, snapshot, signer_name, signature_typed,
      consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel)
    values ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000005','v1','ach', 18000,1553,19553, 24, current_date+7,
            '{"x":1}'::jsonb,'Dana Reyes','Dana Reyes',true,true,true,true);
  exception when others then ok := true; end;
  raise notice '% A5  agreement term must match the offer', case when ok then 'PASS' else 'FAIL' end;

  -- A6 wrong activation date
  ok := false;
  begin
    insert into service_plan_agreements (offer_id, customer_id, equipment_id, agreement_version,
      selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
      term_months, activation_date, snapshot, signer_name, signature_typed,
      consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel)
    values ('f0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000005','v1','ach', 18000,1553,19553, 6, current_date,
            '{"x":1}'::jsonb,'Dana Reyes','Dana Reyes',true,true,true,true);
  exception when others then ok := true; end;
  raise notice '% A6  agreement activation date must match the offer', case when ok then 'PASS' else 'FAIL' end;

  -- A7 a missing consent
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000004',
      '11111111-1111-1111-1111-111111111111','ach','v1','Dana Reyes','Ops','Dana Reyes',
      true,false,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% A7  all four consents required', case when ok then 'PASS' else 'FAIL' end;

  -- A8 empty snapshot
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000004',
      '11111111-1111-1111-1111-111111111111','ach','v1','Dana Reyes','Ops','Dana Reyes',
      true,true,true,true,null,null,null);
  exception when others then ok := true; end;
  raise notice '% A8  snapshot must be a non-empty object', case when ok then 'PASS' else 'FAIL' end;

  -- A9 blank signature
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000004',
      '11111111-1111-1111-1111-111111111111','ach','v1','Dana Reyes','Ops','   ',
      true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% A9  signature cannot be blank', case when ok then 'PASS' else 'FAIL' end;

  -- A10 another customer signing A's offer
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000004',
      '22222222-2222-2222-2222-222222222222','ach','v1','Sam Vale','Ops','Sam Vale',
      true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% A10 another customer cannot sign this offer', case when ok then 'PASS' else 'FAIL' end;

  -- A11 POSITIVE CONTROL — the legitimate signature must succeed, atomically
  ok := false;
  begin
    a := accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000001',
      '11111111-1111-1111-1111-111111111111','ach','APEX-MSP-2026-09-DRAFT',
      'Dana Reyes','Operations Manager','Dana Reyes',
      true,true,true,true,
      '{"plan":"Monthly Planned Maintenance — Standard"}'::jsonb,'hash','UA');
    select * into o from service_plan_offers where id = 'f0000000-0000-0000-0000-000000000001';
    ok := (a.monthly_total_cents = 19553 and a.selected_payment_method = 'ach'
           and o.status = 'accepted' and a.term_months = 6
           and (a.snapshot -> 'authoritative' ->> 'monthly_total_cents') = '19553');
  exception when others then ok := false; end;
  raise notice '% A11 legitimate signing succeeds; offer accepted atomically; DB-authoritative amount stamped into snapshot',
    case when ok then 'PASS' else 'FAIL' end;

  -- A12 signing the same offer twice
  ok := false;
  begin
    perform accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000001',
      '11111111-1111-1111-1111-111111111111','card','v1','Dana Reyes','Ops','Dana Reyes',
      true,true,true,true,'{"x":1}'::jsonb,null,null);
  exception when others then ok := true; end;
  raise notice '% A12 an accepted offer cannot be signed again', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 3. SUBSCRIPTION INSERT VALIDATION ═══════'
do $$
declare ok boolean; s service_subscriptions; agr uuid;
begin
  select id into agr from service_plan_agreements where offer_id = 'f0000000-0000-0000-0000-000000000001';

  -- S1 amount different from the signed agreement
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months)
    values (agr,'f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000001','ach', 50000, 4313, 54313, current_date+7, 6);
  exception when others then ok := true; end;
  raise notice '% S1  subscription amount must equal the signed agreement', case when ok then 'PASS' else 'FAIL' end;

  -- S2 rail different from the signed rail
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months)
    values (agr,'f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000001','card', 18000, 1553, 19553, current_date+7, 6);
  exception when others then ok := true; end;
  raise notice '% S2  subscription rail must equal the signed rail', case when ok then 'PASS' else 'FAIL' end;

  -- S3 different equipment than the agreement
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months)
    values (agr,'f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000003','ach', 18000, 1553, 19553, current_date+7, 6);
  exception when others then ok := true; end;
  raise notice '% S3  subscription equipment must equal the agreement equipment', case when ok then 'PASS' else 'FAIL' end;

  -- S4 different customer than the agreement
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months)
    values (agr,'f0000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222',
            'e0000000-0000-0000-0000-000000000001','ach', 18000, 1553, 19553, current_date+7, 6);
  exception when others then ok := true; end;
  raise notice '% S4  subscription customer must equal the agreement customer', case when ok then 'PASS' else 'FAIL' end;

  -- S5 provider id supplied at creation
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months,
      provider_subscription_id)
    values (agr,'f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000001','ach', 18000, 1553, 19553, current_date+7, 6, 99999);
  exception when others then ok := true; end;
  raise notice '% S5  provider_subscription_id cannot be supplied at creation', case when ok then 'PASS' else 'FAIL' end;

  -- S6 born active
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months, status)
    values (agr,'f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000001','ach', 18000, 1553, 19553, current_date+7, 6, 'active');
  exception when others then ok := true; end;
  raise notice '% S6  a subscription cannot be created already active', case when ok then 'PASS' else 'FAIL' end;

  -- S7 max_cycles disagreeing with the signed term
  ok := false;
  begin
    insert into service_subscriptions (agreement_id, offer_id, customer_id, equipment_id, payment_method,
      recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents, activation_date, term_months, max_cycles)
    values (agr,'f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
            'e0000000-0000-0000-0000-000000000001','ach', 18000, 1553, 19553, current_date+7, 6, 60);
  exception when others then ok := true; end;
  raise notice '% S7  max_cycles must equal the signed term', case when ok then 'PASS' else 'FAIL' end;

  -- S8 POSITIVE CONTROL — copy from the agreement
  ok := false;
  begin
    s := create_subscription_from_agreement(agr);
    ok := (s.recurring_total_cents = 19553 and s.payment_method = 'ach'
           and s.max_cycles = 6 and s.status = 'setup_pending'
           and s.provider_subscription_id is null);
  exception when others then ok := false; end;
  raise notice '% S8  subscription copies the signed agreement exactly (19553c / ach / 6 cycles / setup_pending)',
    case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 4. LIFECYCLE TRANSITIONS ═══════'
do $$
declare ok boolean; agr5 uuid; sub1 uuid; sub5 uuid;
begin
  -- build the second chain for terminal-state tests
  agr5 := (accept_offer_and_sign_agreement('f0000000-0000-0000-0000-000000000005',
            '11111111-1111-1111-1111-111111111111','card','v1','Dana Reyes','Ops','Dana Reyes',
            true,true,true,true,'{"chain":2}'::jsonb,null,null)).id;
  sub5 := (create_subscription_from_agreement(agr5)).id;
  select id into sub1 from service_subscriptions where offer_id = 'f0000000-0000-0000-0000-000000000001';

  -- L1 accepted offer resurrected
  ok := false;
  begin update service_plan_offers set status='sent' where id='f0000000-0000-0000-0000-000000000001';
  exception when others then ok := true; end;
  raise notice '% L1  accepted offer cannot return to sent', case when ok then 'PASS' else 'FAIL' end;

  -- L2 declined offer resurrected
  update service_plan_offers set status='declined', declined_at=now() where id='f0000000-0000-0000-0000-000000000003';
  ok := false;
  begin update service_plan_offers set status='sent' where id='f0000000-0000-0000-0000-000000000003';
  exception when others then ok := true; end;
  raise notice '% L2  declined offer cannot return to sent', case when ok then 'PASS' else 'FAIL' end;

  -- L3 draft -> accepted, skipping sent
  ok := false;
  begin update service_plan_offers set status='accepted' where id='f0000000-0000-0000-0000-000000000002';
  exception when others then ok := true; end;
  raise notice '% L3  a draft cannot jump straight to accepted', case when ok then 'PASS' else 'FAIL' end;

  -- L4 subscription skipping method verification
  ok := false;
  begin update service_subscriptions set status='active' where id=sub1;
  exception when others then ok := true; end;
  raise notice '% L4  setup_pending cannot jump straight to active', case when ok then 'PASS' else 'FAIL' end;

  -- L5 POSITIVE CONTROL — the legitimate activation path
  ok := false;
  begin
    update service_subscriptions set status='method_verified', payment_method_verified_at=now(),
           payment_method_display='Bank ····6789' where id=sub1;
    update service_subscriptions set status='active', provider_subscription_id=19980,
           provider_customer_code='CST1044', provider_payment_plan_id=6395,
           provider_verified_at=now(), activated_at=now() where id=sub1;
    ok := true;
  exception when others then ok := false; end;
  raise notice '% L5  setup_pending -> method_verified -> active succeeds', case when ok then 'PASS' else 'FAIL' end;

  -- L6 cancelled subscription resurrected
  update service_subscriptions set status='method_verified' where id=sub5;
  update service_subscriptions set status='cancelled', cancelled_at=now() where id=sub5;
  ok := false;
  begin update service_subscriptions set status='active' where id=sub5;
  exception when others then ok := true; end;
  raise notice '% L6  a cancelled subscription cannot be reactivated', case when ok then 'PASS' else 'FAIL' end;

  -- L7 completed subscription resurrected
  update service_subscriptions set status='completed' where id=sub1;
  ok := false;
  begin update service_subscriptions set status='active' where id=sub1;
  exception when others then ok := true; end;
  raise notice '% L7  a completed subscription cannot be reactivated', case when ok then 'PASS' else 'FAIL' end;
  update service_subscriptions set status='completed' where id=sub1;  -- leave terminal

  -- L8 agreement superseded then resurrected
  update service_plan_agreements set status='superseded' where id=agr5;
  ok := false;
  begin update service_plan_agreements set status='signed' where id=agr5;
  exception when others then ok := true; end;
  raise notice '% L8  a superseded agreement cannot return to signed', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 5. DURABILITY — WHAT MAY NEVER BE DELETED ═══════'
do $$
declare ok boolean; agr uuid; sub1 uuid;
begin
  select id into agr from service_plan_agreements where offer_id='f0000000-0000-0000-0000-000000000001';
  select id into sub1 from service_subscriptions where offer_id='f0000000-0000-0000-0000-000000000001';

  ok := false;
  begin delete from service_plan_agreements where id = agr;
  exception when others then ok := true; end;
  raise notice '% D1  a signed agreement cannot be deleted (service_role included)', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_plan_events set detail = '{"tampered":true}'::jsonb where id = (select min(id) from service_plan_events);
  exception when others then ok := true; end;
  raise notice '% D2  service_plan_events cannot be UPDATEd', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin delete from service_plan_events where id = (select min(id) from service_plan_events);
  exception when others then ok := true; end;
  raise notice '% D3  service_plan_events cannot be DELETEd', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin delete from service_subscriptions where id = sub1;
  exception when others then ok := true; end;
  raise notice '% D4  a provider-bound subscription cannot be deleted', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 6. IMMUTABILITY ═══════'
do $$
declare ok boolean; agr uuid; sub1 uuid;
begin
  select id into agr  from service_plan_agreements where offer_id='f0000000-0000-0000-0000-000000000001';
  select id into sub1 from service_subscriptions   where offer_id='f0000000-0000-0000-0000-000000000001';

  ok := false;
  begin update service_plan_agreements set monthly_total_cents=100 where id=agr;
  exception when others then ok := true; end;
  raise notice '% M1  signed agreement amount is immutable', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_plan_agreements set selected_payment_method='card' where id=agr;
  exception when others then ok := true; end;
  raise notice '% M2  signed rail is immutable', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_plan_agreements set snapshot='{"tampered":true}'::jsonb where id=agr;
  exception when others then ok := true; end;
  raise notice '% M3  contract snapshot is immutable', case when ok then 'PASS' else 'FAIL' end;

  update service_plan_agreements set pdf_path='agreements/a/x.pdf', document_sha256=repeat('a',64),
         pdf_generated_at=now() where id=agr;
  ok := false;
  begin update service_plan_agreements set pdf_path='agreements/attacker/swap.pdf' where id=agr;
  exception when others then ok := true; end;
  raise notice '% M4  agreement PDF is write-once', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_plan_offers set ach_monthly_total_cents=1, ach_monthly_subtotal_cents=1,
        ach_monthly_tax_cents=0 where id='f0000000-0000-0000-0000-000000000004';
  exception when others then ok := true; end;
  raise notice '% M5  a SENT offer''s pricing is frozen', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_subscriptions set recurring_total_cents=999999 where id=sub1;
  exception when others then ok := true; end;
  raise notice '% M6  subscription authorized amount is frozen', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update service_subscriptions set provider_subscription_id=20001 where id=sub1;
  exception when others then ok := true; end;
  raise notice '% M7  provider subscription binding is permanent', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin
    update service_subscriptions set times_billed=3 where id=sub1;
    update service_subscriptions set times_billed=1 where id=sub1;
  exception when others then ok := true; end;
  raise notice '% M8  times_billed cannot decrease', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 7. DOUBLE-CHARGE PROTECTION ═══════'
do $$
declare ok boolean; sub1 uuid; pay1 uuid;
begin
  select id into sub1 from service_subscriptions where offer_id='f0000000-0000-0000-0000-000000000001';

  insert into invoices (id, customer_id, customer_email, customer_name, company, description,
    subtotal_cents, tax_cents, tax_rate_milli_pct, amount, status,
    invoice_source, subscription_id, billing_period_start, billing_period_end)
  values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','buyer@acmewarehouse.com','Dana Reyes',
    'Acme Warehouse','Monthly Service Plan — FL-07', 18000, 1553, 8625, 195.53, 'unpaid',
    'recurring', sub1, date '2026-10-01', date '2026-10-31');

  insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
    payment_source, subscription_id, billing_period_start, billing_period_end,
    provider_subscription_payment_id, provider_payment_number, provider_transaction_id, approved_at)
  values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','helcim','payment','ach',19553,'succeeded',
    'recurring', sub1, date '2026-10-01', date '2026-10-31', 90116, 1, '61000001', now())
  returning id into pay1;

  ok := false;
  begin
    insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
      payment_source, subscription_id, billing_period_start, billing_period_end,
      provider_subscription_payment_id, provider_payment_number, provider_transaction_id)
    values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','helcim','payment','ach',19553,'succeeded',
      'recurring', sub1, date '2026-10-01', date '2026-10-31', 90116, 1, '61000002');
  exception when others then ok := true; end;
  raise notice '% P1  a replayed billing cycle cannot create a second money row', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin
    insert into invoices (customer_id, customer_email, customer_name, description, subtotal_cents, tax_cents,
      amount, status, invoice_source, subscription_id, billing_period_start, billing_period_end)
    values ('11111111-1111-1111-1111-111111111111','buyer@acmewarehouse.com','Dana Reyes','dup',
      18000,1553,195.53,'unpaid','recurring', sub1, date '2026-10-01', date '2026-10-31');
  exception when others then ok := true; end;
  raise notice '% P2  one Apex invoice per billing period', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin
    insert into payments (invoice_id, customer_id, provider, kind, amount_cents, status, payment_source, subscription_id)
    values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','helcim','payment',19553,'succeeded','recurring', sub1);
  exception when others then ok := true; end;
  raise notice '% P3  a recurring charge must name its billing period', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin
    insert into payments (invoice_id, customer_id, provider, kind, amount_cents, status,
      payment_source, subscription_id, provider_payment_number)
    values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','helcim','payment',100,'succeeded',
      'one_time', null, 7);
  exception when others then ok := true; end;
  raise notice '% P4  a one_time row cannot carry recurring metadata', case when ok then 'PASS' else 'FAIL' end;

  ok := false;
  begin update payments set amount_cents=1 where id=pay1;
  exception when others then ok := true; end;
  raise notice '% P5  recurring amounts immutable (existing guard_payment)', case when ok then 'PASS' else 'FAIL' end;

  -- POSITIVE CONTROLS: corrections against a recurring cycle must still work
  ok := false;
  begin
    insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
      payment_source, subscription_id, refund_of, provider_transaction_id, notes, approved_at)
    values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','helcim','refund','ach',5000,'succeeded',
      'recurring', sub1, pay1, '61000003','Goodwill credit — missed PM visit', now());
    insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
      payment_source, subscription_id, refund_of, provider_transaction_id, notes, approved_at)
    values ('INV-RECUR000001','11111111-1111-1111-1111-111111111111','helcim','refund','ach',2000,'succeeded',
      'recurring', sub1, pay1, '61000004','Second partial credit', now());
    ok := true;
  exception when others then ok := false; end;
  raise notice '% P6  TWO partial refunds of one recurring cycle are allowed (correction flexibility preserved)',
    case when ok then 'PASS' else 'FAIL' end;

  raise notice '% P7  recurring_billing_enabled is false',
    case when cfg_bool('recurring_billing_enabled') = false then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 8. VERIFY-SESSION LIFECYCLE ═══════'
do $$
declare ok boolean; agr uuid; r record; n int;
begin
  select id into agr from service_plan_agreements where offer_id='f0000000-0000-0000-0000-000000000001';

  perform create_verify_session('CKT-LIVE','SEC-LIVE', agr, '11111111-1111-1111-1111-111111111111','ach');
  select count(*) into n from read_verify_session('CKT-LIVE');
  raise notice '% V1  a live verify session reads back', case when n=1 then 'PASS' else 'FAIL' end;

  ok := false;
  begin perform create_verify_session('CKT-LIVE','SEC-OTHER', agr,'22222222-2222-2222-2222-222222222222','card');
  exception when others then ok := true; end;
  raise notice '% V2  a token cannot be rebound to a different customer/rail', case when ok then 'PASS' else 'FAIL' end;

  select count(*) into n from consume_verify_session('CKT-LIVE');
  raise notice '% V3  first consume returns the secret', case when n=1 then 'PASS' else 'FAIL' end;

  select count(*) into n from consume_verify_session('CKT-LIVE');
  raise notice '% V4  second consume returns nothing (single-use)', case when n=0 then 'PASS' else 'FAIL' end;

  select count(*) into n from read_verify_session('CKT-LIVE');
  raise notice '% V5  a consumed session no longer reads back', case when n=0 then 'PASS' else 'FAIL' end;

  perform create_verify_session('CKT-OLD','SEC-OLD', agr,'11111111-1111-1111-1111-111111111111','card');
  update private.helcim_verify_session set expires_at = now() - interval '1 minute' where checkout_token='CKT-OLD';
  select count(*) into n from read_verify_session('CKT-OLD');
  raise notice '% V6  an expired session never validates', case when n=0 then 'PASS' else 'FAIL' end;
  select count(*) into n from consume_verify_session('CKT-OLD');
  raise notice '% V7  an expired session cannot be consumed', case when n=0 then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 9. RLS AS TWO REAL AUTHENTICATED CUSTOMERS ═══════'
\t off
set role authenticated;
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222","email":"other@elsewhere.com"}', false);
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' R1 customer B sees none of A''s offers'        as result from service_plan_offers     where customer_id='11111111-1111-1111-1111-111111111111';
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' R2 customer B sees none of A''s agreements'    as result from service_plan_agreements where customer_id='11111111-1111-1111-1111-111111111111';
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' R3 customer B sees none of A''s subscriptions' as result from service_subscriptions   where customer_id='11111111-1111-1111-1111-111111111111';
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' R4 customer B sees none of A''s equipment'     as result from customer_equipment      where customer_id='11111111-1111-1111-1111-111111111111';

select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111","email":"buyer@acmewarehouse.com"}', false);
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' R5 internal draft offers are invisible to the customer' as result from service_plan_offers where status='draft';
select case when count(*)>0 then 'PASS' else 'FAIL' end || ' R6 customer A does see their own non-draft offers'      as result from service_plan_offers;
select case when count(*)=0 then 'PASS' else 'FAIL' end || ' R7 service_plan_events are admin-only'                  as result from service_plan_events;

\echo '-- R8..R11: PostgREST writes must be refused at privilege level --'
insert into service_plan_offers (customer_id, equipment_id, plan_name, ach_monthly_subtotal_cents,
  ach_monthly_tax_cents, ach_monthly_total_cents, card_monthly_subtotal_cents, card_monthly_tax_cents, card_monthly_total_cents)
values ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001','self-serve discount',1,0,1,1,0,1);
update service_plan_agreements set monthly_total_cents=1 where customer_id='11111111-1111-1111-1111-111111111111';
update service_subscriptions   set recurring_total_cents=1 where customer_id='11111111-1111-1111-1111-111111111111';
delete from service_plan_agreements where customer_id='11111111-1111-1111-1111-111111111111';

\echo '-- R12: the reminder toggle is the only customer write, and only on their own row --'
select set_subscription_reminder((select id from service_subscriptions limit 1), false) as reminder_now;
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222","email":"other@elsewhere.com"}', false);
select set_subscription_reminder('00000000-0000-0000-0000-000000000000', true);

reset role;
select set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@apexliftsolutionsusa.com"}', false);

\echo ''
\echo '═══════ 10. EXISTING V23 ONE-TIME FLOW STILL INTACT ═══════'
select 'invoice ' || id || ' = ' || status || ' (reversed invoice must still be unpaid and payable)' as one_time
  from invoices where id='INV-1A10E21B68';
select 'net retained on reversed invoice = ' ||
  (coalesce(sum(amount_cents) filter (where kind='payment' and status='succeeded'),0)
 - coalesce(sum(amount_cents) filter (where kind in ('refund','reversal') and status='succeeded'),0))
  || ' cents (must be 0 for the V23 retry to be permitted)' as one_time
  from payments where invoice_id='INV-1A10E21B68';
select 'original one_time payments untouched: ' || count(*) as one_time
  from payments where payment_source='one_time' and subscription_id is null;
