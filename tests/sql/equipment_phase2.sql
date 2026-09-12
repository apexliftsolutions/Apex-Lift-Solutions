-- =============================================================================
--  Equipment Phase 2 — quote / invoice equipment linkage
--  Fresh DB through 0012 with the local auth shim. Fixtures use production
--  paths: quotes are inserted the way the admin browser inserts them, links go
--  through link_quote_equipment(), conversion through quote_to_invoice().
-- =============================================================================
\set QUIET on
\pset format unaligned
\pset tuples_only on

-- Mirror Supabase: service_role has full table access there. The local shim
-- creates the role but grants nothing, which would make the runtime tests fail
-- for a reason production does not have.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

create or replace function _t2(name text, sql text, expect_ok boolean, expect_msg text default null) returns text
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

-- Admin identity for the security-definer functions.
insert into auth.users (id,email) values
 ('11110000-0000-0000-0000-000000000001','p2a@t.io'),
 ('22220000-0000-0000-0000-000000000002','p2b@t.io'),
 ('99990000-0000-0000-0000-000000000099','admin@apexliftsolutionsusa.com');
set request.jwt.claims = '{"sub":"11110000-0000-0000-0000-000000000001","role":"authenticated","email":"p2a@t.io"}';
insert into customers (email,name,status) values ('p2a@t.io','P2 Customer A','active');
set request.jwt.claims = '{"sub":"22220000-0000-0000-0000-000000000002","role":"authenticated","email":"p2b@t.io"}';
insert into customers (email,name,status) values ('p2b@t.io','P2 Customer B','active');
reset request.jwt.claims;
-- is_admin() matches an EMAIL claim in the JWT, not a table. Discovered from
-- the shipped function rather than assumed.

-- Equipment: A-active, A-inactive, A-retired, B-active
insert into customer_equipment (id,customer_id,make,model,year,serial_number,unit_number,status) values
 ('ea000000-0000-0000-0000-00000000000a','11110000-0000-0000-0000-000000000001','Toyota','8FGCU25','2019','P2-SN-A','A-1','active'),
 ('ea000000-0000-0000-0000-00000000000b','11110000-0000-0000-0000-000000000001','Hyster','H50','2015','P2-SN-INACT','A-2','inactive'),
 ('eb000000-0000-0000-0000-00000000000c','22220000-0000-0000-0000-000000000002','Crown','FC','2020','P2-SN-B','B-1','active');
insert into customer_equipment (id,customer_id,make,model,serial_number,status) values
 ('ea000000-0000-0000-0000-00000000000d','11110000-0000-0000-0000-000000000001','Yale','GLP','P2-SN-RET','active');
update customer_equipment set status='retired' where id='ea000000-0000-0000-0000-00000000000d';

-- Quotes are inserted exactly as the admin browser inserts them today.
insert into quotes (id,customer_id,customer_email,customer_name,company,equipment,description,items,subtotal_cents,tax_cents,amount,status) values
 ('Q-P2-1','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','ACo','', 'Service','[]'::jsonb,10000,0,100.00,'pending'),
 ('Q-P2-2','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','ACo','', 'Service','[]'::jsonb,10000,0,100.00,'pending'),
 ('Q-P2-3','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','ACo','', 'Service','[]'::jsonb,10000,0,100.00,'pending'),
 ('Q-P2-4','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','ACo','', 'Service','[]'::jsonb,10000,0,100.00,'pending'),
 ('Q-P2-NOEQ','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','ACo','', 'Site visit','[]'::jsonb,5000,0,50.00,'pending');
-- A genuinely historical quote: free text only, no link. Predates Phase 2.
insert into quotes (id,customer_id,customer_email,customer_name,equipment,description,items,subtotal_cents,tax_cents,amount,status,invoiced) values
 ('Q-P2-OLD','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','Toyota 8FGCU25 (typed by hand)','Old job','[]'::jsonb,20000,0,200.00,'approved',false);

set request.jwt.claims = '{"sub":"99990000-0000-0000-0000-000000000099","role":"authenticated","email":"admin@apexliftsolutionsusa.com"}';

-- ── OWNERSHIP ──────────────────────────────────────────────────────────────
select _t2('P1 customer A quote + customer A active equipment succeeds',
  $q$select link_quote_equipment('Q-P2-1','ea000000-0000-0000-0000-00000000000a')$q$, true);
select _t2('P2 customer A quote + customer B equipment REJECTED',
  $q$select link_quote_equipment('Q-P2-2','eb000000-0000-0000-0000-00000000000c')$q$, false, 'equipment_not_owned');
select _t2('P3 direct SQL cross-customer link rejected by the composite FK (not just the function)',
  $q$update quotes set equipment_id='eb000000-0000-0000-0000-00000000000c', equipment_snapshot='{}'::jsonb where id='Q-P2-2'$q$,
  false, 'fk_quote_equipment_same_customer');
select _t2('P4 cross-customer INVOICE equipment rejected by the FK',
  $q$insert into invoices (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status,equipment_id,equipment_snapshot)
     values ('INV-P2-X','11110000-0000-0000-0000-000000000001','p2a@t.io','A','x','[]'::jsonb,100,0,1.00,'unpaid','eb000000-0000-0000-0000-00000000000c',jsonb_build_object('id','x'))$q$,
  false, 'fk_invoice_equipment_same_customer');

-- ── ACTIVE STATUS ──────────────────────────────────────────────────────────
select _t2('P5 INACTIVE equipment rejected',
  $q$select link_quote_equipment('Q-P2-2','ea000000-0000-0000-0000-00000000000b')$q$, false, 'equipment_not_active');
select _t2('P6 RETIRED equipment rejected',
  $q$select link_quote_equipment('Q-P2-2','ea000000-0000-0000-0000-00000000000d')$q$, false, 'equipment_not_active');

-- ── SNAPSHOT CONTENT ───────────────────────────────────────────────────────
select case when equipment_id is not null and equipment_snapshot is not null
       then 'PASS P7 linked quote has BOTH equipment_id and snapshot' else 'FAIL P7' end from quotes where id='Q-P2-1';
select case when equipment_snapshot->>'serial_number'='P2-SN-A' and equipment_snapshot->>'make'='Toyota'
       then 'PASS P8 snapshot captured the live identity' else 'FAIL P8: '||coalesce(equipment_snapshot::text,'null') end from quotes where id='Q-P2-1';
select case when equipment = '2019 Toyota 8FGCU25 · #A-1 · SN P2-SN-A'
       then 'PASS P9 legacy free-text label written for existing readers' else 'FAIL P9: '||coalesce(equipment,'null') end from quotes where id='Q-P2-1';
select case when (select count(*) from jsonb_object_keys(equipment_snapshot))=8
       then 'PASS P10 snapshot uses the 0011 format (8 identity keys)' else 'FAIL P10' end from quotes where id='Q-P2-1';

-- ── PAIR CONSTRAINT ────────────────────────────────────────────────────────
select _t2('P11 id without snapshot rejected',
  $q$update quotes set equipment_id='ea000000-0000-0000-0000-00000000000a' where id='Q-P2-3'$q$, false, 'ck_quote_equipment_snapshot_pair');
select _t2('P12 snapshot without id rejected',
  $q$update quotes set equipment_snapshot=jsonb_build_object('id','x') where id='Q-P2-3'$q$, false, 'ck_quote_equipment_snapshot_pair');

-- ── SNAPSHOT IS FROZEN ─────────────────────────────────────────────────────
update customer_equipment set nickname='Renamed after the quote', service_location='Moved', unit_number='A-99'
 where id='ea000000-0000-0000-0000-00000000000a';
select case when equipment_snapshot->>'unit_number'='A-1' and equipment_snapshot->>'nickname' is null
       then 'PASS P13 editing the live forklift did NOT rewrite the quote snapshot'
       else 'FAIL P13 snapshot drifted: '||equipment_snapshot::text end from quotes where id='Q-P2-1';
select _t2('P14 snapshot cannot be rewritten directly',
  $q$update quotes set equipment_snapshot=jsonb_build_object('id','tampered') where id='Q-P2-1'$q$, false, 'document_snapshot_frozen');
select _t2('P15 snapshot cannot be cleared',
  $q$update quotes set equipment_snapshot=null, equipment_id=null where id='Q-P2-1'$q$, false, 'document_snapshot_frozen');

-- ── QUOTE LIFECYCLE ────────────────────────────────────────────────────────
update quotes set status='approved', responded_at=now() where id='Q-P2-1';
select _t2('P16 equipment cannot be changed once the customer responded',
  $q$select link_quote_equipment('Q-P2-1','ea000000-0000-0000-0000-00000000000a')$q$, false, 'quote_not_pending');
select _t2('P17 a PENDING quote may still be linked (draft edit)',
  $q$select link_quote_equipment('Q-P2-4','ea000000-0000-0000-0000-00000000000a')$q$, true);

-- ── QUOTE -> INVOICE ───────────────────────────────────────────────────────
select quote_to_invoice('Q-P2-1');
select case when count(*)=1 then 'PASS P18 quote_to_invoice created one invoice' else 'FAIL P18' end from invoices where quote_id='Q-P2-1';
select case when i.equipment_id = q.equipment_id then 'PASS P19 invoice inherited the SAME equipment_id' else 'FAIL P19' end
  from invoices i join quotes q on q.id=i.quote_id where i.quote_id='Q-P2-1';
select case when i.equipment_snapshot = q.equipment_snapshot then 'PASS P20 invoice snapshot is byte-identical to the quote snapshot' else 'FAIL P20' end
  from invoices i join quotes q on q.id=i.quote_id where i.quote_id='Q-P2-1';
select case when i.equipment = q.equipment then 'PASS P21 legacy label copied too' else 'FAIL P21' end
  from invoices i join quotes q on q.id=i.quote_id where i.quote_id='Q-P2-1';
select case when i.equipment_snapshot->>'unit_number'='A-1'
       then 'PASS P22 invoice names the machine the customer APPROVED, not the live record (now A-99)'
       else 'FAIL P22: '|| (i.equipment_snapshot->>'unit_number') end from invoices i where i.quote_id='Q-P2-1';
select _t2('P23 invoice snapshot is frozen too',
  $q$update invoices set equipment_snapshot=jsonb_build_object('id','tampered') where quote_id='Q-P2-1'$q$, false, 'document_snapshot_frozen');

-- ── NO-EQUIPMENT QUOTES ────────────────────────────────────────────────────
select case when equipment_id is null and equipment_snapshot is null
       then 'PASS P24 a quote with no forklift is valid (site visit / travel work)' else 'FAIL P24' end from quotes where id='Q-P2-NOEQ';
update quotes set status='approved' where id='Q-P2-NOEQ';
select quote_to_invoice('Q-P2-NOEQ');
select case when count(*)=1 then 'PASS P25 an unlinked quote still converts' else 'FAIL P25' end from invoices where quote_id='Q-P2-NOEQ';
select case when equipment_id is null and equipment_snapshot is null
       then 'PASS P26 its invoice stays unlinked, not fabricated' else 'FAIL P26' end from invoices where quote_id='Q-P2-NOEQ';

-- ── HISTORICAL ROWS ────────────────────────────────────────────────────────
select case when equipment_id is null and equipment_snapshot is null and equipment='Toyota 8FGCU25 (typed by hand)'
       then 'PASS P27 historical quote untouched: no link, free text intact' else 'FAIL P27' end from quotes where id='Q-P2-OLD';
select quote_to_invoice('Q-P2-OLD');
select case when count(*)=1 then 'PASS P28 historical quote still converts' else 'FAIL P28' end from invoices where quote_id='Q-P2-OLD';
select case when equipment='Toyota 8FGCU25 (typed by hand)' and equipment_id is null
       then 'PASS P29 its invoice carries the free text and stays unlinked' else 'FAIL P29: '||coalesce(equipment,'null') end
  from invoices where quote_id='Q-P2-OLD';

-- ── AUTHORISATION ──────────────────────────────────────────────────────────
reset request.jwt.claims;
set request.jwt.claims = '{"sub":"11110000-0000-0000-0000-000000000001","role":"authenticated"}';
-- SUPERSEDED. This used to assert an in-function is_admin() check, which was
-- incompatible with the only role that can call the RPC (service_role carries
-- no user JWT). The real guarantee is the EXECUTE privilege, asserted as RT3-RT5
-- below, plus admin-action authenticating the human before it uses the
-- service-role client.
select case when not has_function_privilege('authenticated','link_quote_equipment(text,uuid)','EXECUTE')
       then 'PASS P30 a normal authenticated user has no EXECUTE on the link RPC' else 'FAIL P30' end;
select case when not has_function_privilege('authenticated','link_quote_equipment(text,uuid)','EXECUTE')
       then 'PASS P31 authenticated has no EXECUTE on link_quote_equipment' else 'FAIL P31' end;
-- Customer isolation is the existing quote RLS policy, unchanged by 0012.
-- Asserting the policy is the honest check here: this harness role has no table
-- grant, so a zero-row read would prove nothing.
select case when exists (select 1 from pg_policies where tablename='quotes' and qual like '%auth.uid()%')
       then 'PASS P32 customer quote isolation policy still present and uses auth.uid()' else 'FAIL P32' end;
select case when exists (select 1 from pg_policies where tablename='invoices' and qual like '%auth.uid()%')
       then 'PASS P33 customer invoice isolation policy still present' else 'FAIL P33' end;
reset request.jwt.claims;

-- =============================================================================
--  RUNTIME INTEGRATION (v25.2 correction)
--  These reproduce the ACTUAL Edge -> service-role shape: a service_role call
--  carries NO end-user JWT. The earlier tests hand-set an admin email claim,
--  which is why a broken authority model passed them.
-- =============================================================================
reset request.jwt.claims;

-- A / C: service-role with NO admin email must succeed.
insert into customer_equipment (id,customer_id,make,model,serial_number) values
 ('ea000000-0000-0000-0000-0000000000f1','11110000-0000-0000-0000-000000000001','Toyota','RT','P2-SN-RT');
insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status)
 values ('Q-P2-RT','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','Runtime','[]'::jsonb,10000,0,100.00,'pending');
set role service_role;
set request.jwt.claims = '{"role":"service_role"}';   -- no email claim, as in production
select case when (select equipment_id from link_quote_equipment('Q-P2-RT','ea000000-0000-0000-0000-0000000000f1')) is not null
       then 'PASS RT1 (A) link RPC works as service_role with NO admin email claim' else 'FAIL RT1' end;
update quotes set status='approved' where id='Q-P2-RT';
select quote_to_invoice('Q-P2-RT');
select case when count(*)=1 then 'PASS RT2 (C) quote_to_invoice works as service_role with NO admin email claim' else 'FAIL RT2' end
  from invoices where quote_id='Q-P2-RT';
reset role; reset request.jwt.claims;

-- B: a normal authenticated customer has no EXECUTE on either RPC.
select case when not has_function_privilege('authenticated','link_quote_equipment(text,uuid)','EXECUTE')
       then 'PASS RT3 (B) authenticated cannot execute link_quote_equipment' else 'FAIL RT3' end;
select case when not has_function_privilege('authenticated','quote_to_invoice(text)','EXECUTE')
       then 'PASS RT4 authenticated cannot execute quote_to_invoice' else 'FAIL RT4' end;
select case when not has_function_privilege('anon','link_quote_equipment(text,uuid)','EXECUTE')
       then 'PASS RT5 anon cannot execute it either' else 'FAIL RT5' end;
-- The RPC bodies must not carry a browser-JWT check that service_role can never satisfy.
select case when regexp_replace(prosrc,'--[^\n]*','','g') not like '%is_admin%'
       then 'PASS RT6 '||proname||' has no is_admin() check incompatible with its only caller'
       else 'FAIL RT6 '||proname||' still gates on is_admin()' end
  from pg_proc where proname in ('link_quote_equipment','quote_to_invoice') order by proname;

-- D / E: a NEW linked quote is atomic and the notification sees the equipment.
insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status,equipment_id)
 values ('Q-P2-ATOM','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','Atomic','[]'::jsonb,10000,0,100.00,'pending','ea000000-0000-0000-0000-0000000000f1');
select case when equipment_snapshot is not null and equipment = '2019 Toyota RT · SN P2-SN-RT' or equipment like '%Toyota RT%'
       then 'PASS RT7 (D) snapshot and label established by the INSERT itself' else 'FAIL RT7: '||coalesce(equipment,'null') end
  from quotes where id='Q-P2-ATOM';
select case when payload->>'equipment' = (select equipment from quotes where id='Q-P2-ATOM') and payload->>'equipment' <> ''
       then 'PASS RT8 (E) quote_created outbox payload carries the equipment label'
       else 'FAIL RT8 payload equipment = '||coalesce(payload->>'equipment','<null>') end
  from notification_outbox where event_key = 'quote_created:Q-P2-ATOM';

-- F / G: a rejected forklift leaves NO quote row and NO outbox row.
select _t2('RT9 (F) inactive unit aborts the INSERT',
  $q$insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status,equipment_id)
     values ('Q-P2-DEAD','11110000-0000-0000-0000-000000000001','p2a@t.io','A','x','[]'::jsonb,100,0,1.00,'pending','ea000000-0000-0000-0000-00000000000b')$q$,
  false, 'equipment_not_active');
select case when count(*)=0 then 'PASS RT10 (F) zero quote rows created' else 'FAIL RT10' end from quotes where id='Q-P2-DEAD';
select case when count(*)=0 then 'PASS RT11 (G) zero outbox rows created' else 'FAIL RT11' end from notification_outbox where event_key='quote_created:Q-P2-DEAD';
select _t2('RT12 (F) another customer''s unit aborts the INSERT',
  $q$insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status,equipment_id)
     values ('Q-P2-XCUST','11110000-0000-0000-0000-000000000001','p2a@t.io','A','x','[]'::jsonb,100,0,1.00,'pending','eb000000-0000-0000-0000-00000000000c')$q$,
  false, 'equipment_not_owned');
select case when count(*)=0 then 'PASS RT13 zero rows for the cross-customer attempt' else 'FAIL RT13' end from quotes where id='Q-P2-XCUST';

-- A client-supplied snapshot/label is overwritten, never trusted.
insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status,equipment_id,equipment,equipment_snapshot)
 values ('Q-P2-SPOOF','11110000-0000-0000-0000-000000000001','p2a@t.io','A','x','[]'::jsonb,100,0,1.00,'pending','ea000000-0000-0000-0000-0000000000f1','TOTALLY FAKE',jsonb_build_object('make','FAKE'));
select case when equipment <> 'TOTALLY FAKE' and equipment_snapshot->>'make' = 'Toyota'
       then 'PASS RT14 a client-supplied label and snapshot are discarded by the trigger' else 'FAIL RT14' end
  from quotes where id='Q-P2-SPOOF';

-- No-equipment quote: payload equipment blank, as intended.
insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status)
 values ('Q-P2-NONE2','11110000-0000-0000-0000-000000000001','p2a@t.io','A','Site visit','[]'::jsonb,100,0,1.00,'pending');
select case when coalesce(payload->>'equipment','')='' then 'PASS RT15 no-forklift quote sends a blank equipment, as intended' else 'FAIL RT15' end
  from notification_outbox where event_key='quote_created:Q-P2-NONE2';

-- L / M / N: conversion lifecycle and double-convert protection.
set role service_role; set request.jwt.claims = '{"role":"service_role"}';
select _t2('RT16 (L) a PENDING quote cannot be converted',
  $q$select quote_to_invoice('Q-P2-ATOM')$q$, false, 'quote_not_approved');
update quotes set status='declined' where id='Q-P2-NONE2';
select _t2('RT17 (L) a DECLINED quote cannot be converted',
  $q$select quote_to_invoice('Q-P2-NONE2')$q$, false, 'quote_not_approved');
-- SUPERSEDED by Phase 2.2. Conversion is now idempotent: a repeat attempt
-- returns the EXISTING invoice instead of raising, because the raise is what
-- the admin browser swallowed silently. The guarantee is unchanged and is
-- asserted directly: no second invoice is ever created.
select quote_to_invoice('Q-P2-RT');
select case when count(*)=1 then 'PASS RT18 (M) a repeat conversion still leaves exactly one invoice' else 'FAIL RT18 count='||count(*) end
  from invoices where quote_id='Q-P2-RT';
select case when count(*)=1 then 'PASS RT19 (N) exactly one invoice exists for that quote' else 'FAIL RT19 found '||count(*) end
  from invoices where quote_id='Q-P2-RT';
-- O: inheritance is exact.
select case when i.equipment_id = q.equipment_id and i.equipment_snapshot = q.equipment_snapshot and i.equipment = q.equipment
       then 'PASS RT20 (O) invoice inherited equipment, id and the EXACT snapshot' else 'FAIL RT20' end
  from invoices i join quotes q on q.id = i.quote_id where i.quote_id='Q-P2-RT';
reset role; reset request.jwt.claims;

-- =============================================================================
--  PHASE 2.1 — INVOICE DELIVERY STATE
-- =============================================================================
set request.jwt.claims = '{"sub":"99990000-0000-0000-0000-000000000099","role":"authenticated","email":"admin@apexliftsolutionsusa.com"}';

-- EXACTLY ONCE: one invoice, one invoice_created row.
select case when count(*)=1 then 'PASS DL1 one invoice_created row for INV from Q-P2-1' else 'FAIL DL1 count='||count(*) end
  from notification_outbox where event_key = 'invoice_created:' || (select id from invoices where quote_id='Q-P2-1');
-- Updating the invoice must not enqueue a second creation email.
update invoices set description = description || ' (edited)' where quote_id='Q-P2-1';
select case when count(*)=1 then 'PASS DL2 updating the invoice enqueues no second creation email' else 'FAIL DL2 count='||count(*) end
  from notification_outbox where event_key = 'invoice_created:' || (select id from invoices where quote_id='Q-P2-1');
-- The unique key itself: a manual re-enqueue is a no-op.
select enqueue_notification('invoice_created:' || (select id from invoices where quote_id='Q-P2-1'),
  'invoice_created','someone-else@example.com','invoice','x','{}'::jsonb);
select case when count(*)=1 then 'PASS DL3 re-enqueueing the same event_key creates no second row' else 'FAIL DL3 count='||count(*) end
  from notification_outbox where event_key = 'invoice_created:' || (select id from invoices where quote_id='Q-P2-1');
select case when recipient = 'p2a@t.io' then 'PASS DL4 the original recipient is preserved, not overwritten' else 'FAIL DL4 '||recipient end
  from notification_outbox where event_key = 'invoice_created:' || (select id from invoices where quote_id='Q-P2-1');

-- Transport state is untouched by 0013.
select case when pg_get_constraintdef(oid) like '%pending%processing%sent%failed%'
       then 'PASS DL5 outbox status check constraint unchanged' else 'FAIL DL5' end
  from pg_constraint where conrelid='notification_outbox'::regclass and pg_get_constraintdef(oid) like '%pending%';

-- ── PROVIDER DELIVERY EVENTS ───────────────────────────────────────────────
update notification_outbox set status='sent', sent_at=now(), provider_msg_id='resend-msg-AAA'
 where event_key = 'invoice_created:' || (select id from invoices where quote_id='Q-P2-1');
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:OTHER-INV','invoice_created','other@t.io','invoice','OTHER-INV','sent','resend-msg-BBB',now());

set role service_role; set request.jwt.claims = '{"role":"service_role"}';
select case when (apply_delivery_event('svix-1','resend-msg-AAA','email.delivered', now(), null)->>'applied')::boolean
       then 'PASS DL6 a delivered event applies to the matching message' else 'FAIL DL6' end;
select case when delivery_status='delivered' and delivered_at is not null
       then 'PASS DL7 delivery_status and delivered_at set' else 'FAIL DL7' end
  from notification_outbox where provider_msg_id='resend-msg-AAA';
select case when status='sent' then 'PASS DL8 transport status still sent, not overwritten' else 'FAIL DL8 '||status end
  from notification_outbox where provider_msg_id='resend-msg-AAA';
-- Only the matching message moved.
select case when delivery_status is null then 'PASS DL9 the other invoice was NOT touched' else 'FAIL DL9' end
  from notification_outbox where provider_msg_id='resend-msg-BBB';

-- Duplicate webhook delivery is harmless.
select case when (apply_delivery_event('svix-1','resend-msg-AAA','email.delivered', now(), null)->>'reason') = 'duplicate_event'
       then 'PASS DL10 a replayed webhook is a no-op' else 'FAIL DL10' end;
select case when count(*)=1 then 'PASS DL11 only one delivery event row recorded' else 'FAIL DL11 count='||count(*) end
  from notification_delivery_events where provider_event_id='svix-1';

-- Unknown provider message id must not update anything.
select case when (apply_delivery_event('svix-2','resend-msg-NOBODY','email.delivered', now(), null)->>'reason') = 'unknown_provider_msg_id'
       then 'PASS DL12 an unknown provider message id applies to nothing' else 'FAIL DL12' end;
select case when count(*)=0 then 'PASS DL13 and no other row was changed by it' else 'FAIL DL13' end
  from notification_outbox where provider_msg_id='resend-msg-BBB' and delivery_status is not null;

-- Bounce on the second message only.
select case when (apply_delivery_event('svix-3','resend-msg-BBB','email.bounced', now(), 'Permanent / Suppressed')->>'applied')::boolean
       then 'PASS DL14 a bounce applies to its own message' else 'FAIL DL14' end;
select case when delivery_status='bounced' and bounced_at is not null and delivery_detail like '%Suppressed%'
       then 'PASS DL15 bounce recorded with a safe detail' else 'FAIL DL15' end
  from notification_outbox where provider_msg_id='resend-msg-BBB';
select case when delivery_status='delivered' then 'PASS DL16 the delivered message is still delivered' else 'FAIL DL16' end
  from notification_outbox where provider_msg_id='resend-msg-AAA';
-- A late 'delivered' must not erase a bounce.
-- The reason code changed when the model became history-based; the BEHAVIOUR is
-- what matters and is asserted on the row itself by DL18 below.
select apply_delivery_event('svix-4','resend-msg-BBB','email.delivered', now(), null);
select case when delivery_status='bounced' then 'PASS DL17 a late delivered does not overwrite a bounce' else 'FAIL DL17 '||coalesce(delivery_status,'null') end
  from notification_outbox where provider_msg_id='resend-msg-BBB';
select case when delivery_status='bounced' then 'PASS DL18 it is still bounced' else 'FAIL DL18' end
  from notification_outbox where provider_msg_id='resend-msg-BBB';
-- Unmapped event types are recorded, not acted on.
select case when (apply_delivery_event('svix-5','resend-msg-AAA','email.opened', now(), null)->>'reason') = 'unmapped_event_type'
       then 'PASS DL19 an open event changes no delivery state (we do not track opens)' else 'FAIL DL19' end;
reset role; reset request.jwt.claims;

-- ── LEAST PRIVILEGE ────────────────────────────────────────────────────────
select case when not has_function_privilege('authenticated','apply_delivery_event(text,text,text,timestamptz,text)','EXECUTE')
       then 'PASS DL20 authenticated cannot execute apply_delivery_event' else 'FAIL DL20' end;
select case when not has_table_privilege('authenticated','notification_outbox','INSERT')
       and not has_table_privilege('authenticated','notification_outbox','UPDATE')
       then 'PASS DL21 browsers cannot insert or update the outbox' else 'FAIL DL21' end;
select case when exists (select 1 from pg_policies where tablename='notification_outbox' and policyname='outbox_admin_read')
       then 'PASS DL22 admin-only read policy still in place' else 'FAIL DL22' end;
select case when not exists (select 1 from pg_policies where tablename='notification_delivery_events' and qual like '%auth.uid()%')
       then 'PASS DL23 no customer policy exists on the delivery events table' else 'FAIL DL23' end;

-- =============================================================================
--  PHASE 2.1 RELIABILITY — event-time ordering and the provider-id race
--  Resend documents that webhook delivery order is NOT guaranteed and that the
--  payload created_at should be used when ordering matters.
-- =============================================================================
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:ORD-1','invoice_created','ord@t.io','invoice','ORD-1','sent','resend-ord-1',now());

-- ORDERED NORMALLY: delayed 10:00 then delivered 10:01 -> Delivered.
select apply_delivery_event('ev-o1','resend-ord-1','email.delivery_delayed','2026-09-12T10:00:00Z',null);
select apply_delivery_event('ev-o2','resend-ord-1','email.delivered',        '2026-09-12T10:01:00Z',null);
select case when delivery_status='delivered' then 'PASS OR1 delayed@10:00 then delivered@10:01 -> Delivered' else 'FAIL OR1 '||coalesce(delivery_status,'null') end
  from notification_outbox where provider_msg_id='resend-ord-1';

-- OUT OF ORDER: the older delayed event ARRIVES LAST and must not regress.
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:ORD-2','invoice_created','ord2@t.io','invoice','ORD-2','sent','resend-ord-2',now());
select apply_delivery_event('ev-o3','resend-ord-2','email.delivered',        '2026-09-12T10:01:00Z',null);
select apply_delivery_event('ev-o4','resend-ord-2','email.delivery_delayed','2026-09-12T10:00:00Z',null);
select case when delivery_status='delivered' then 'PASS OR2 a stale delayed arriving LAST does not regress Delivered' else 'FAIL OR2 regressed to '||coalesce(delivery_status,'null') end
  from notification_outbox where provider_msg_id='resend-ord-2';
select case when delivered_at = '2026-09-12T10:01:00Z' then 'PASS OR3 delivered_at is the provider event time' else 'FAIL OR3' end
  from notification_outbox where provider_msg_id='resend-ord-2';

-- A STALE DELIVERED must not erase a NEWER bounce.
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:ORD-3','invoice_created','ord3@t.io','invoice','ORD-3','sent','resend-ord-3',now());
select apply_delivery_event('ev-o5','resend-ord-3','email.bounced',  '2026-09-12T11:00:00Z','Permanent');
select apply_delivery_event('ev-o6','resend-ord-3','email.delivered','2026-09-12T10:00:00Z',null);
select case when delivery_status='bounced' then 'PASS OR4 a stale delivered does not erase a newer bounce' else 'FAIL OR4 '||coalesce(delivery_status,'null') end
  from notification_outbox where provider_msg_id='resend-ord-3';
-- Nor does a LATER delivered, because a rejected message was not delivered.
select apply_delivery_event('ev-o7','resend-ord-3','email.delivered','2026-09-12T12:00:00Z',null);
select case when delivery_status='bounced' then 'PASS OR5 even a later delivered cannot undo a bounce' else 'FAIL OR5' end
  from notification_outbox where provider_msg_id='resend-ord-3';

-- A LATER COMPLAINT supersedes delivered.
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:ORD-4','invoice_created','ord4@t.io','invoice','ORD-4','sent','resend-ord-4',now());
select apply_delivery_event('ev-o8','resend-ord-4','email.delivered', '2026-09-12T10:00:00Z',null);
select apply_delivery_event('ev-o9','resend-ord-4','email.complained','2026-09-12T13:00:00Z',null);
select case when delivery_status='complained' then 'PASS OR6 a later complaint supersedes delivered' else 'FAIL OR6 '||coalesce(delivery_status,'null') end
  from notification_outbox where provider_msg_id='resend-ord-4';
select case when delivered_at is null and bounced_at is not null then 'PASS OR7 timestamps follow the winning state' else 'FAIL OR7' end
  from notification_outbox where provider_msg_id='resend-ord-4';

-- email.failed maps to a failure outcome.
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:ORD-5','invoice_created','ord5@t.io','invoice','ORD-5','sent','resend-ord-5',now());
select apply_delivery_event('ev-o10','resend-ord-5','email.failed','2026-09-12T10:00:00Z','Provider failure');
select case when delivery_status='failed' then 'PASS OR8 email.failed maps to failed' else 'FAIL OR8' end
  from notification_outbox where provider_msg_id='resend-ord-5';
-- Opens and clicks remain untracked.
select apply_delivery_event('ev-o11','resend-ord-5','email.opened','2026-09-12T14:00:00Z',null);
select case when delivery_status='failed' then 'PASS OR9 an open event changes nothing (we do not track reads)' else 'FAIL OR9' end
  from notification_outbox where provider_msg_id='resend-ord-5';

-- ── THE RACE: a verified event arrives BEFORE provider_msg_id is committed ──
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status)
 values ('invoice_created:RACE-1','invoice_created','race@t.io','invoice','RACE-1','processing');
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id)
 values ('invoice_created:RACE-OTHER','invoice_created','other@t.io','invoice','RACE-OTHER','sent','resend-other-9');
-- 1-2: the event is retained and touches nothing.
select case when (apply_delivery_event('ev-r1','resend-race-1','email.delivered','2026-09-12T15:00:00Z',null)->>'retained')::boolean
       then 'PASS RC1 an event for an unknown provider id is RETAINED, not dropped' else 'FAIL RC1' end;
select case when count(*)=1 and (select outbox_id from notification_delivery_events where provider_event_id='ev-r1') is null
       then 'PASS RC2 it is stored unattached' else 'FAIL RC2' end from notification_delivery_events where provider_event_id='ev-r1';
select case when delivery_status is null then 'PASS RC3 no unrelated invoice was changed' else 'FAIL RC3' end
  from notification_outbox where provider_msg_id='resend-other-9';
-- 3-5: the worker commits the id; the retained event reconciles.
update notification_outbox set status='sent', sent_at=now(), provider_msg_id='resend-race-1'
 where event_key='invoice_created:RACE-1';
select case when delivery_status='delivered' and delivered_at='2026-09-12T15:00:00Z'
       then 'PASS RC4 the retained event reconciled the moment the id landed' else 'FAIL RC4 '||coalesce(delivery_status,'null') end
  from notification_outbox where event_key='invoice_created:RACE-1';
select case when outbox_id is not null then 'PASS RC5 the event was attached to the correct row' else 'FAIL RC5' end
  from notification_delivery_events where provider_event_id='ev-r1';
-- 6: nothing else moved.
select case when delivery_status is null then 'PASS RC6 other invoices remain untouched' else 'FAIL RC6' end
  from notification_outbox where provider_msg_id='resend-other-9';
-- 7: replaying the same webhook is still harmless.
select case when (apply_delivery_event('ev-r1','resend-race-1','email.delivered','2026-09-12T15:00:00Z',null)->>'reason')='duplicate_event'
       then 'PASS RC7 replaying the raced webhook is harmless' else 'FAIL RC7' end;
select case when count(*)=1 then 'PASS RC8 still exactly one recorded event' else 'FAIL RC8 count='||count(*) end
  from notification_delivery_events where provider_event_id='ev-r1';
select case when delivery_status='delivered' then 'PASS RC9 state unchanged by the replay' else 'FAIL RC9' end
  from notification_outbox where event_key='invoice_created:RACE-1';
reset role; reset request.jwt.claims;

-- ── TIMESTAMP HARDENING ────────────────────────────────────────────────────
-- The whole model is ordered by the provider's event time, so an event without
-- one cannot be ordered and must never decide state. It is still retained.
set role service_role; set request.jwt.claims = '{"role":"service_role"}';
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:TS-1','invoice_created','ts@t.io','invoice','TS-1','sent','resend-ts-1',now());
select apply_delivery_event('ts-a','resend-ts-1','email.delivered','2026-09-12T10:01:00Z',null);
select case when delivery_status='delivered' then 'PASS TS1 a timestamped delivered wins normally' else 'FAIL TS1' end
  from notification_outbox where provider_msg_id='resend-ts-1';
select apply_delivery_event('ts-b','resend-ts-1','email.delivery_delayed',null,null);
select case when delivery_status='delivered' then 'PASS TS2 an event with NO provider timestamp cannot regress Delivered' else 'FAIL TS2 regressed to '||coalesce(delivery_status,'null') end
  from notification_outbox where provider_msg_id='resend-ts-1';
select case when count(*)=1 then 'PASS TS3 but it is still retained for diagnosis' else 'FAIL TS3' end
  from notification_delivery_events where provider_event_id='ts-b';

-- An untimed event as the FIRST event must not fabricate a state.
insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status,provider_msg_id,sent_at)
 values ('invoice_created:TS-2','invoice_created','ts2@t.io','invoice','TS-2','sent','resend-ts-2',now());
select apply_delivery_event('ts-c','resend-ts-2','email.delivered',null,null);
select case when delivery_status is null then 'PASS TS4 an untimed first event does not fabricate Delivered' else 'FAIL TS4 '||delivery_status end
  from notification_outbox where provider_msg_id='resend-ts-2';
select case when delivered_at is null then 'PASS TS5 and no delivered_at is invented' else 'FAIL TS5' end
  from notification_outbox where provider_msg_id='resend-ts-2';
-- A properly timed event afterwards still works.
select apply_delivery_event('ts-d','resend-ts-2','email.delivered','2026-09-12T12:00:00Z',null);
select case when delivery_status='delivered' and delivered_at='2026-09-12T12:00:00Z'
       then 'PASS TS6 a later timestamped event still applies normally' else 'FAIL TS6' end
  from notification_outbox where provider_msg_id='resend-ts-2';
select case when delivery_event_wins('delivered','2026-09-12T10:00:00Z','bounced',null) = false
       then 'PASS TS7 delivery_event_wins rejects a NULL provider timestamp outright' else 'FAIL TS7' end;
reset role; reset request.jwt.claims;

-- =============================================================================
--  PHASE 2.2 — ONE QUOTE, ONE INVOICE, VISIBLE TO THE RIGHT CUSTOMER
-- =============================================================================
insert into auth.users (id,email) values ('cc000000-0000-0000-0000-00000000000b','cb@t.io');
set request.jwt.claims = '{"sub":"cc000000-0000-0000-0000-00000000000b","role":"authenticated","email":"cb@t.io"}';
insert into customers (email,name,status) values ('cb@t.io','Customer B2','active');
reset request.jwt.claims;
insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status)
 values ('Q-22A','11110000-0000-0000-0000-000000000001','p2a@t.io','P2 Customer A','Job A','[]'::jsonb,20000,0,200.00,'approved');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

select case when (quote_to_invoice_v2('Q-22A')->>'created')::boolean then 'PASS Q1 first conversion creates the invoice' else 'FAIL Q1' end;
select case when count(*)=1 then 'PASS Q2 exactly one invoice' else 'FAIL Q2 count='||count(*) end from invoices where quote_id='Q-22A';
select case when invoiced then 'PASS Q3 quote permanently marked invoiced' else 'FAIL Q3' end from quotes where id='Q-22A';
select case when customer_id='11110000-0000-0000-0000-000000000001' then 'PASS Q4 invoice customer_id EQUALS the quote customer_id' else 'FAIL Q4' end
  from invoices where quote_id='Q-22A';
select case when count(*)=1 then 'PASS Q5 exactly one invoice_created outbox row' else 'FAIL Q5 count='||count(*) end
  from notification_outbox where event_key='invoice_created:'||(select id from invoices where quote_id='Q-22A');

-- SECOND ATTEMPT: must return the existing invoice, not create or notify again.
select case when (quote_to_invoice_v2('Q-22A')->>'already_invoiced')::boolean
       and (quote_to_invoice_v2('Q-22A')->>'created')::boolean = false
       then 'PASS Q6 a repeat attempt reports already_invoiced and creates nothing' else 'FAIL Q6' end;
select case when count(*)=1 then 'PASS Q7 still exactly one invoice' else 'FAIL Q7 count='||count(*) end from invoices where quote_id='Q-22A';
select case when count(*)=1 then 'PASS Q8 still exactly one invoice_created notification' else 'FAIL Q8 count='||count(*) end
  from notification_outbox where event_key='invoice_created:'||(select id from invoices where quote_id='Q-22A');

-- THE UNIQUE INDEX is the real guarantee, independent of the function.
select _t2('Q9 a second invoice for the same quote is refused by the database',
  $q$insert into invoices (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status,quote_id)
     values ('INV-DUP','11110000-0000-0000-0000-000000000001','p2a@t.io','A','dup','[]'::jsonb,100,0,1.00,'unpaid','Q-22A')$q$,
  false, 'uq_invoice_quote_id');

-- SELF-HEAL: the exact production symptom — invoice exists, flag says false.
update quotes set invoiced = false where id='Q-22A';
select case when (quote_to_invoice_v2('Q-22A')->>'repaired_flag')::boolean then 'PASS Q10 a drifted invoiced flag is repaired, not re-converted' else 'FAIL Q10' end;
select case when invoiced then 'PASS Q11 the flag is true again' else 'FAIL Q11' end from quotes where id='Q-22A';
select case when count(*)=1 then 'PASS Q12 and still exactly one invoice' else 'FAIL Q12' end from invoices where quote_id='Q-22A';

-- A non-approved quote still cannot be converted.
insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status)
 values ('Q-22P','11110000-0000-0000-0000-000000000001','p2a@t.io','A','Pending','[]'::jsonb,100,0,1.00,'pending');
select _t2('Q13 a pending quote cannot be converted', $q$select quote_to_invoice_v2('Q-22P')$q$, false, 'quote_not_approved');
select _t2('Q14 an unknown quote id is reported, not guessed', $q$select quote_to_invoice_v2('Q-NOPE')$q$, false, 'quote_not_found');
reset role; reset request.jwt.claims;

-- ── CUSTOMER VISIBILITY: real RLS, by ownership not email ──────────────────
-- Supabase grants authenticated SELECT on these tables; the local shim does not.
grant select on invoices, quotes to authenticated;
select case when exists (
    select 1 from pg_policies where tablename='invoices' and qual like '%auth.uid()%' and qual not like '%email%')
  then 'PASS Q15 customer invoice RLS uses auth.uid() ownership, not email matching' else 'FAIL Q15' end;
set role authenticated;
set request.jwt.claims = '{"sub":"11110000-0000-0000-0000-000000000001","role":"authenticated","email":"p2a@t.io"}';
select case when count(*)=1 then 'PASS Q16 Customer A CAN see the invoice from their quote' else 'FAIL Q16 saw '||count(*) end
  from invoices where quote_id='Q-22A';
set request.jwt.claims = '{"sub":"cc000000-0000-0000-0000-00000000000b","role":"authenticated","email":"cb@t.io"}';
select case when count(*)=0 then 'PASS Q17 Customer B CANNOT see it' else 'FAIL Q17 saw '||count(*) end
  from invoices where quote_id='Q-22A';
set request.jwt.claims = '{"sub":"99990000-0000-0000-0000-000000000099","role":"authenticated","email":"admin@apexliftsolutionsusa.com"}';
select case when count(*)=1 then 'PASS Q18 admin CAN see it' else 'FAIL Q18' end from invoices where quote_id='Q-22A';
reset role; reset request.jwt.claims;
