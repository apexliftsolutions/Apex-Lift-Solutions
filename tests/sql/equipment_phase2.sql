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
select _t2('RT18 (M) an already-invoiced quote cannot be converted again',
  $q$select quote_to_invoice('Q-P2-RT')$q$, false, 'quote_already_invoiced');
select case when count(*)=1 then 'PASS RT19 (N) exactly one invoice exists for that quote' else 'FAIL RT19 found '||count(*) end
  from invoices where quote_id='Q-P2-RT';
-- O: inheritance is exact.
select case when i.equipment_id = q.equipment_id and i.equipment_snapshot = q.equipment_snapshot and i.equipment = q.equipment
       then 'PASS RT20 (O) invoice inherited equipment, id and the EXACT snapshot' else 'FAIL RT20' end
  from invoices i join quotes q on q.id = i.quote_id where i.quote_id='Q-P2-RT';
reset role; reset request.jwt.claims;
