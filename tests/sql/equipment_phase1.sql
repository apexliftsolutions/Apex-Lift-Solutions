-- =============================================================================
--  Equipment Phase 1 — database rule tests
--  Runs against a fresh DB migrated through 0011 with the local auth shim.
--  Fixtures go through the REAL production paths where one exists: the
--  customers trigger sets id from auth.uid(); the signed agreement is created by
--  accept_offer_and_sign_agreement(), the same RPC a customer's signature calls.
--  Run:  node tools/run-sql-tests.mjs   (or psql -f this file against apex11)
-- =============================================================================
\set QUIET on
\pset format unaligned
\pset tuples_only on
create or replace function _t(name text, sql text, expect_ok boolean, expect_msg text default null) returns text
language plpgsql as $$
declare msg text;
begin
  begin execute sql;
    if expect_ok then return 'PASS ' || name; else return 'FAIL ' || name || ' (succeeded, expected error)'; end if;
  exception when others then
    get stacked diagnostics msg = message_text;
    if not expect_ok and (expect_msg is null or msg like '%'||expect_msg||'%') then return 'PASS ' || name || '  <- ' || msg;
    elsif not expect_ok then return 'FAIL ' || name || ' (wrong error: ' || msg || ')';
    else return 'FAIL ' || name || ' (' || msg || ')'; end if;
  end;
end $$;

-- customers.id references auth.users(id): the auth user must exist first, as it
-- does in production (Supabase Auth creates it before the customers trigger runs).
insert into auth.users (id,email) values
 ('aaaaaaaa-0000-0000-0000-000000000001','a@t.io'),
 ('bbbbbbbb-0000-0000-0000-000000000002','b@t.io'),
 ('cccccccc-0000-0000-0000-000000000003','p@t.io');
-- customers are created the way signup does it: id comes from auth.uid()
set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated","email":"a@t.io"}';
insert into customers (email,name,status) values ('a@t.io','Customer A','active');
set request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated","email":"b@t.io"}';
insert into customers (email,name,status) values ('b@t.io','Customer B','active');
set request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated","email":"p@t.io"}';
insert into customers (email,name,status) values ('p@t.io','Pending P','pending');
reset request.jwt.claims;
select case when count(*)=3 then 'PASS F0 fixture customers exist (3)' else 'FAIL F0 fixture customers: '||count(*)||' of 3' end from customers where id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003');

-- serial contract
select _t('S1 real serial accepted', $q$insert into customer_equipment (id,customer_id,make,model,year,serial_number) values ('e0000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Toyota','8FGCU25','2019','SN-100')$q$, true);
select _t('S2 duplicate normalized serial same customer rejected', $q$insert into customer_equipment (customer_id,make,serial_number) values ('aaaaaaaa-0000-0000-0000-000000000001','X',' sn-100 ')$q$, false, 'uq_equipment_serial');
select _t('S3 same serial different customer allowed', $q$insert into customer_equipment (id,customer_id,make,serial_number) values ('e0000000-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002','X','SN-100')$q$, true);
select _t('S4 blank serial rejected',   $q$insert into customer_equipment (customer_id,make,serial_number) values ('aaaaaaaa-0000-0000-0000-000000000001','X','   ')$q$, false, 'serial_not_blank');
select _t('S5 N/A rejected',     $q$insert into customer_equipment (customer_id,make,serial_number) values ('aaaaaaaa-0000-0000-0000-000000000001','X','n/a')$q$, false, 'placeholder');
select _t('S6 UNKNOWN rejected', $q$insert into customer_equipment (customer_id,make,serial_number) values ('aaaaaaaa-0000-0000-0000-000000000001','X','Unknown')$q$, false, 'placeholder');
select _t('S7 NONE rejected',    $q$insert into customer_equipment (customer_id,make,serial_number) values ('aaaaaaaa-0000-0000-0000-000000000001','X','NONE')$q$, false, 'placeholder');
select _t('S8 TBD rejected',     $q$insert into customer_equipment (customer_id,make,serial_number) values ('aaaaaaaa-0000-0000-0000-000000000001','X','tbd')$q$, false, 'placeholder');
select _t('S9 NULL serial allowed', $q$insert into customer_equipment (id,customer_id,make) values ('e0000000-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','NoSerial')$q$, true);
-- new columns
select _t('C1 power_type enum enforced', $q$insert into customer_equipment (customer_id,make,power_type) values ('aaaaaaaa-0000-0000-0000-000000000001','X','nuclear')$q$, false, 'power_type');
select _t('C2 capacity must be > 0',     $q$insert into customer_equipment (customer_id,make,capacity_lbs) values ('aaaaaaaa-0000-0000-0000-000000000001','X',0)$q$, false, 'capacity');
select _t('C3 valid power/capacity/nickname ok', $q$insert into customer_equipment (id,customer_id,make,model,power_type,capacity_lbs,nickname) values ('e0000000-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','Hyster','H50','electric',5000,'Dock 3')$q$, true);
-- ownership / delete
select _t('O1 customer_id update rejected', $q$update customer_equipment set customer_id='bbbbbbbb-0000-0000-0000-000000000002' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'customer_immutable');
select _t('D1 DELETE rejected even with no references', $q$delete from customer_equipment where id='e0000000-0000-0000-0000-000000000003'$q$, false, 'delete_forbidden');
-- signed agreement via the REAL signing RPC
insert into service_plan_offers (id,customer_id,equipment_id,plan_name,term_months,activation_date,status,expires_at,
  ach_monthly_subtotal_cents,ach_monthly_tax_cents,ach_monthly_total_cents,card_monthly_subtotal_cents,card_monthly_tax_cents,card_monthly_total_cents)
 values ('0f000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001','Monthly PM',6,current_date+1,'sent',now()+interval '7 days',10000,0,10000,10350,0,10350);
select case when count(*)=1 then 'PASS F1 offer fixture exists' else 'FAIL F1 offer fixture missing' end from service_plan_offers where id='0f000000-0000-0000-0000-000000000001';
select accept_offer_and_sign_agreement(
  '0f000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','ach','TEST','Customer A','Owner','Customer A',
  true,true,true,true, jsonb_build_object('plan_name','Monthly PM','term_months',6), 'iphash', 'ua');
select 'PASS F2 production signing RPC executed';
select case when count(*)=1 then 'PASS F3 agreement is signed' else 'FAIL F3 no signed agreement' end from service_plan_agreements where offer_id='0f000000-0000-0000-0000-000000000001' and status='signed';
select _t('L1 signed: serial change rejected (direct SQL, no Edge Function involved)', $q$update customer_equipment set serial_number='SN-999' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'under_signed_agreement');
select _t('L2 signed: make change rejected',  $q$update customer_equipment set make='Other' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'under_signed_agreement');
select _t('L3 signed: model change rejected', $q$update customer_equipment set model='Z' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'under_signed_agreement');
select _t('L4 signed: year change rejected',  $q$update customer_equipment set year='2020' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'under_signed_agreement');
select _t('L5 signed: descriptive fields still editable', $q$update customer_equipment set nickname='Bay 1', unit_number='TRK-7', service_location='Yard B', notes='ok', capacity_lbs=6000, power_type='lp' where id='e0000000-0000-0000-0000-000000000001'$q$, true);
select _t('L6 unsigned unit: identity change allowed', $q$update customer_equipment set make='Changed' where id='e0000000-0000-0000-0000-000000000004'$q$, true);

-- ── identity lock survives the agreement's later lifecycle ─────────────────
-- Unit 5 gets its own agreement so its status can be walked to cancelled and
-- superseded without disturbing the subscription tests above.
insert into customer_equipment (id,customer_id,make,model,year,serial_number) values ('e0000000-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','Clark','C25','2018','SN-500');
insert into service_plan_offers (id,customer_id,equipment_id,plan_name,term_months,activation_date,status,expires_at,
  ach_monthly_subtotal_cents,ach_monthly_tax_cents,ach_monthly_total_cents,card_monthly_subtotal_cents,card_monthly_tax_cents,card_monthly_total_cents)
 values ('0f000000-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000005','Monthly PM',6,current_date+1,'sent',now()+interval '7 days',10000,0,10000,10350,0,10350);
select accept_offer_and_sign_agreement('0f000000-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','ach','TEST','Customer A','Owner','Customer A',true,true,true,true,jsonb_build_object('plan_name','Monthly PM','term_months',6,'equipment','2018 Clark C25 SN-500'),'h','ua');
select case when count(*)=1 then 'PASS L6b unit-5 agreement exists and is signed' else 'FAIL L6b agreement fixture missing' end from service_plan_agreements where offer_id='0f000000-0000-0000-0000-000000000005' and status='signed';
select _t('L7 (A) signed: identity change rejected', $q$update customer_equipment set make='Other' where id='e0000000-0000-0000-0000-000000000005'$q$, false, 'under_signed_agreement');
update service_plan_agreements set status='cancelled' where offer_id='0f000000-0000-0000-0000-000000000005';
select case when count(*)=1 then 'PASS L8 agreement moved to cancelled' else 'FAIL L8' end from service_plan_agreements where offer_id='0f000000-0000-0000-0000-000000000005' and status='cancelled';
select _t('L9 (B) CANCELLED agreement: identity change STILL rejected', $q$update customer_equipment set serial_number='SN-501' where id='e0000000-0000-0000-0000-000000000005'$q$, false, 'under_signed_agreement');
-- cancelled is TERMINAL in the agreement state machine, so superseded gets its
-- own unit and goes there directly from signed (the only real path).
insert into customer_equipment (id,customer_id,make,model,year,serial_number) values ('e0000000-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001','Yale','GLP050','2017','SN-600');
insert into service_plan_offers (id,customer_id,equipment_id,plan_name,term_months,activation_date,status,expires_at,
  ach_monthly_subtotal_cents,ach_monthly_tax_cents,ach_monthly_total_cents,card_monthly_subtotal_cents,card_monthly_tax_cents,card_monthly_total_cents)
 values ('0f000000-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000006','Monthly PM',6,current_date+1,'sent',now()+interval '7 days',10000,0,10000,10350,0,10350);
select accept_offer_and_sign_agreement('0f000000-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001','ach','TEST','Customer A','Owner','Customer A',true,true,true,true,jsonb_build_object('plan_name','Monthly PM','equipment','2017 Yale GLP050 SN-600'),'h','ua');
update service_plan_agreements set status='superseded' where offer_id='0f000000-0000-0000-0000-000000000006';
select case when count(*)=1 then 'PASS L10 agreement moved signed -> superseded' else 'FAIL L10' end from service_plan_agreements where offer_id='0f000000-0000-0000-0000-000000000006' and status='superseded';
select _t('L11 (C) SUPERSEDED agreement: identity change STILL rejected', $q$update customer_equipment set model='GLP060' where id='e0000000-0000-0000-0000-000000000006'$q$, false, 'under_signed_agreement');
select _t('L12 (D) descriptive fields still editable after cancel/supersede', $q$update customer_equipment set nickname='Spare', service_location='Lot C', capacity_lbs=4000 where id='e0000000-0000-0000-0000-000000000005'$q$, true);
select case when make='Clark' and model='C25' and serial_number='SN-500' then 'PASS L13 identity unchanged across all attempts' else 'FAIL L13 identity drifted' end from customer_equipment where id='e0000000-0000-0000-0000-000000000005';
select _t('L14 (E) never-agreed unit still edits identity', $q$update customer_equipment set serial_number='SN-200-NEW' where id='e0000000-0000-0000-0000-000000000002'$q$, true);
select case when snapshot->>'equipment' = '2018 Clark C25 SN-500' then 'PASS L15 historical agreement snapshot untouched' else 'FAIL L15 snapshot changed: '||coalesce(snapshot->>'equipment','null') end from service_plan_agreements where offer_id='0f000000-0000-0000-0000-000000000005';
-- live subscription -> retire guard, using the REAL status enum
-- Creation exactly as the system does it: setup_pending, no provider id (the
-- production guard forbids setting it here). setup_pending is itself LIVE.
insert into service_subscriptions (id,agreement_id,offer_id,customer_id,equipment_id,activation_date,term_months,max_cycles,recurring_subtotal_cents,recurring_total_cents,payment_method)
 select '5a000000-0000-0000-0000-000000000001', a.id, a.offer_id, a.customer_id, a.equipment_id, a.activation_date, a.term_months, a.term_months, a.monthly_subtotal_cents, a.monthly_total_cents, a.selected_payment_method
 from service_plan_agreements a where a.offer_id='0f000000-0000-0000-0000-000000000001';
select case when count(*)=1 then 'PASS F4 subscription created as setup_pending (live)' else 'FAIL F4 subscription fixture missing' end from service_subscriptions where id='5a000000-0000-0000-0000-000000000001' and status='setup_pending';
select _t('R0 retire rejected while setup_pending (live)', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'live_subscription');
-- Activate the way the system does, honouring the state machine:
-- setup_pending -> method_verified (verify step) -> active (activate writes the provider id).
update service_subscriptions set status='method_verified' where id='5a000000-0000-0000-0000-000000000001';
select _t('R0b retire rejected while method_verified (live)', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'live_subscription');
update service_subscriptions set provider_subscription_id='999', status='active' where id='5a000000-0000-0000-0000-000000000001';
select case when count(*)=1 then 'PASS F5 subscription activated' else 'FAIL F5 activation failed' end from service_subscriptions where id='5a000000-0000-0000-0000-000000000001' and status='active';
select _t('R1 retire rejected while active', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'live_subscription');
update service_subscriptions set status='paused' where id='5a000000-0000-0000-0000-000000000001';
select _t('R2 retire rejected while paused (live)', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'live_subscription');
update service_subscriptions set status='cancel_requested' where id='5a000000-0000-0000-0000-000000000001';
select _t('R3 retire rejected while cancel_requested (live)', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'live_subscription');
update service_subscriptions set status='cancelled' where id='5a000000-0000-0000-0000-000000000001';
select _t('R4 retire succeeds once cancelled', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000001'$q$, true);
select case when retired_at is not null then 'PASS R5 retired_at set server-side' else 'FAIL R5 retired_at null' end from customer_equipment where id='e0000000-0000-0000-0000-000000000001';
select _t('R6 retired is terminal', $q$update customer_equipment set status='active' where id='e0000000-0000-0000-0000-000000000001'$q$, false, 'retired_is_terminal');
select _t('R7 retire with no plan succeeds', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000003'$q$, true);
-- snapshot / label
select case when (select string_agg(k,',' order by k) from jsonb_object_keys(equipment_snapshot('e0000000-0000-0000-0000-000000000004')) k) = 'captured_at,id,make,model,nickname,serial_number,unit_number,year' then 'PASS N1 snapshot has exactly the 8 identity keys' else 'FAIL N1 snapshot keys wrong' end;
select case when equipment_snapshot('e0000000-0000-0000-0000-000000000004') ? 'notes' or equipment_snapshot('e0000000-0000-0000-0000-000000000004') ? 'customer_id' then 'FAIL N1b snapshot leaks non-identity fields' else 'PASS N1b snapshot excludes notes/customer_id/status' end;
select 'PASS N2 label full: '  || equipment_label('{"year":"2019","make":"Toyota","model":"8FGCU25","unit_number":"TRK-7","serial_number":"12345"}');
select 'PASS N3 label nick: '  || equipment_label('{"nickname":"Dock 3 truck","make":"Hyster","model":"H50"}');
select 'PASS N4 label empty: ' || equipment_label('{}');
select case when equipment_label('{"make":null,"model":null,"year":""}') !~ 'null|undefined|N/A' then 'PASS N5 no null/undefined/N/A leakage' else 'FAIL N5' end;
-- grants + RLS (unchanged by 0011)
select case when not has_table_privilege('authenticated','customer_equipment','INSERT') then 'PASS G1 authenticated has no INSERT (direct browser insert denied)' else 'FAIL G1' end;
select case when not has_table_privilege('authenticated','customer_equipment','UPDATE') then 'PASS G2 authenticated has no UPDATE (direct browser update denied)' else 'FAIL G2' end;
select case when has_table_privilege('authenticated','customer_equipment','SELECT') then 'PASS G3 authenticated keeps SELECT' else 'FAIL G3' end;
set role authenticated; set request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}';
select case when count(*)=0 then 'PASS X1 customer B cannot read customer A''s equipment' else 'FAIL X1 saw '||count(*) end from customer_equipment where customer_id='aaaaaaaa-0000-0000-0000-000000000001';
select case when count(*)=1 then 'PASS X2 customer B reads own unit' else 'FAIL X2 saw '||count(*) end from customer_equipment where customer_id='bbbbbbbb-0000-0000-0000-000000000002';
reset role; reset request.jwt.claims;

-- =============================================================================
--  LIFECYCLE: only ACTIVE equipment may enter or continue an unsigned offer
-- =============================================================================
-- Unit 7: sent offer must block retirement; cancelling it must unblock.
insert into customer_equipment (id,customer_id,make,model) values ('e0000000-0000-0000-0000-000000000007','aaaaaaaa-0000-0000-0000-000000000001','Crown','FC');
insert into service_plan_offers (id,customer_id,equipment_id,plan_name,term_months,activation_date,status,expires_at,
  ach_monthly_subtotal_cents,ach_monthly_tax_cents,ach_monthly_total_cents,card_monthly_subtotal_cents,card_monthly_tax_cents,card_monthly_total_cents)
 values ('0f000000-0000-0000-0000-000000000007','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000007','PM',6,current_date+1,'sent',now()+interval '7 days',10000,0,10000,10350,0,10350);
select case when count(*)=1 then 'PASS O1 sent-offer fixture exists' else 'FAIL O1' end from service_plan_offers where id='0f000000-0000-0000-0000-000000000007' and status='sent';
select _t('O2 SENT offer blocks retirement', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000007'$q$, false, 'equipment_has_open_offer');
select _t('O3 inactive is still allowed while an offer is open (only retire is blocked)', $q$update customer_equipment set status='inactive' where id='e0000000-0000-0000-0000-000000000007'$q$, true);
update customer_equipment set status='active' where id='e0000000-0000-0000-0000-000000000007';
update service_plan_offers set status='cancelled' where id='0f000000-0000-0000-0000-000000000007';
select _t('O4 retire allowed once the sent offer is cancelled', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000007'$q$, true);

-- Unit 8: a DRAFT offer must not block retirement.
insert into customer_equipment (id,customer_id,make,model) values ('e0000000-0000-0000-0000-000000000008','aaaaaaaa-0000-0000-0000-000000000001','Raymond','R40');
insert into service_plan_offers (id,customer_id,equipment_id,plan_name,term_months,activation_date,status,
  ach_monthly_subtotal_cents,ach_monthly_tax_cents,ach_monthly_total_cents,card_monthly_subtotal_cents,card_monthly_tax_cents,card_monthly_total_cents)
 values ('0f000000-0000-0000-0000-000000000008','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000008','PM',6,current_date+1,'draft',10000,0,10000,10350,0,10350);
select _t('O5 DRAFT offer does not block retirement', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000008'$q$, true);
select case when status='retired' then 'PASS O6 unit 8 retired with a draft offer outstanding' else 'FAIL O6' end from customer_equipment where id='e0000000-0000-0000-0000-000000000008';
select case when status='draft' then 'PASS O7 that draft is still draft — send-offer must now refuse it (backend, not DB)' else 'FAIL O7' end from service_plan_offers where id='0f000000-0000-0000-0000-000000000008';

-- Unit 9: an ended subscription with no sent offer retires cleanly.
insert into customer_equipment (id,customer_id,make,model,serial_number) values ('e0000000-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','Komatsu','FG25','SN-900');
insert into service_plan_offers (id,customer_id,equipment_id,plan_name,term_months,activation_date,status,expires_at,
  ach_monthly_subtotal_cents,ach_monthly_tax_cents,ach_monthly_total_cents,card_monthly_subtotal_cents,card_monthly_tax_cents,card_monthly_total_cents)
 values ('0f000000-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000009','PM',6,current_date+1,'sent',now()+interval '7 days',10000,0,10000,10350,0,10350);
select accept_offer_and_sign_agreement('0f000000-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','ach','TEST','Customer A','Owner','Customer A',true,true,true,true,jsonb_build_object('plan_name','PM'),'h','ua');
insert into service_subscriptions (id,agreement_id,offer_id,customer_id,equipment_id,activation_date,term_months,max_cycles,recurring_subtotal_cents,recurring_total_cents,payment_method)
 select '5a000000-0000-0000-0000-000000000009', a.id, a.offer_id, a.customer_id, a.equipment_id, a.activation_date, a.term_months, a.term_months, a.monthly_subtotal_cents, a.monthly_total_cents, a.selected_payment_method
 from service_plan_agreements a where a.offer_id='0f000000-0000-0000-0000-000000000009';
update service_subscriptions set status='method_verified' where id='5a000000-0000-0000-0000-000000000009';
update service_subscriptions set provider_subscription_id='777', status='active' where id='5a000000-0000-0000-0000-000000000009';
select _t('O8 live subscription still blocks retirement', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000009'$q$, false, 'live_subscription');
update service_subscriptions set status='cancelled' where id='5a000000-0000-0000-0000-000000000009';
select case when status='accepted' then 'PASS O9 signing moved the offer out of sent' else 'FAIL O9 offer is '||status end from service_plan_offers where id='0f000000-0000-0000-0000-000000000009';
select _t('O10 ended subscription + no sent offer: retire allowed', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-000000000009'$q$, true);
select case when make='Komatsu' and serial_number='SN-900' then 'PASS O11 identity intact through the whole lifecycle' else 'FAIL O11' end from customer_equipment where id='e0000000-0000-0000-0000-000000000009';

-- =============================================================================
--  STATE MATRIX: inactive is an ADMIN state, not a customer one
--  (the customer-facing refusal lives in equipment-customer; the database
--   allows admin transitions and is asserted here.)
-- =============================================================================
insert into customer_equipment (id,customer_id,make,model) values ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','Nissan','P25');
select _t('M1 admin may mark a unit inactive', $q$update customer_equipment set status='inactive' where id='e0000000-0000-0000-0000-00000000000a'$q$, true);
select _t('M2 admin may return it to active', $q$update customer_equipment set status='active' where id='e0000000-0000-0000-0000-00000000000a'$q$, true);
select _t('M3 inactive -> retired allowed when nothing is open', $q$update customer_equipment set status='retired' where id='e0000000-0000-0000-0000-00000000000a'$q$, true);
select case when retired_at is not null then 'PASS M4 retired_at stamped on the inactive->retired path' else 'FAIL M4' end from customer_equipment where id='e0000000-0000-0000-0000-00000000000a';
select _t('M5 retired -> inactive still refused', $q$update customer_equipment set status='inactive' where id='e0000000-0000-0000-0000-00000000000a'$q$, false, 'retired_is_terminal');

