-- =============================================================================
-- V24.6 — recurring admin operations tests
-- LOCAL / STAGING ONLY. Creates fake customers, equipment, offers, agreements,
-- subscriptions, invoices and payments.
-- =============================================================================
\set ON_ERROR_STOP off
\pset format aligned
\t on

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@apexliftsolutionsusa.com"}', false);

-- ── Fixtures: a live subscription with three billed cycles ─────────────────
insert into customer_equipment (id, customer_id, unit_number, year, make, model, serial_number, service_location)
values ('99000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'FL-31','2020','Toyota','8FGCU25','V246-001','Bay 1') on conflict do nothing;

insert into service_plan_offers (id, customer_id, equipment_id, status, plan_name, included_services, exclusions,
  term_months, activation_date, ach_monthly_subtotal_cents, ach_monthly_tax_cents, ach_monthly_total_cents,
  card_monthly_subtotal_cents, card_monthly_tax_cents, card_monthly_total_cents,
  tax_rate_milli_pct, sent_at, expires_at)
values ('99f00000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
  '99000000-0000-0000-0000-000000000001','sent','V24.6 Plan','[]'::jsonb,'[]'::jsonb,
  6, current_date + 7, 15000,1294,16294, 15750,1358,17108, 8625, now(), now()+interval '30 days')
on conflict do nothing;

do $$
declare agr uuid; sub uuid; pay uuid;
begin
  agr := (accept_offer_and_sign_agreement('99f00000-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111','ach','v1','Dana Reyes','Ops','Dana Reyes',
          true,true,true,true,'{"sections":[{"heading":"1","body":"x"}]}'::jsonb,null,null)).id;
  sub := (create_subscription_from_agreement(agr)).id;
  update service_subscriptions set status='method_verified' where id=sub;
  update service_subscriptions set status='active', provider_subscription_id=88001,
         provider_customer_code='CST8801', provider_payment_plan_id=6395,
         provider_verified_at=now(), activated_at=now(), times_billed=3,
         next_billing_date=current_date+30 where id=sub;

  -- Three recurring cycles through the EXISTING ledger.
  for i in 1..3 loop
    insert into invoices (id, customer_id, customer_email, customer_name, company, description,
      subtotal_cents, tax_cents, tax_rate_milli_pct, amount, status,
      invoice_source, subscription_id, billing_period_start, billing_period_end)
    values ('INV-V246CYC'||i,'11111111-1111-1111-1111-111111111111','buyer@acmewarehouse.com',
      'Dana Reyes','Acme Warehouse','Monthly Service Plan — FL-31',
      15000,1294,8625,162.94,'unpaid','recurring', sub,
      (date '2026-10-01' + ((i-1)||' month')::interval)::date,
      (date '2026-10-31' + ((i-1)||' month')::interval)::date);

    insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
      payment_source, subscription_id, billing_period_start, billing_period_end,
      provider_subscription_payment_id, provider_payment_number, provider_transaction_id, approved_at)
    values ('INV-V246CYC'||i,'11111111-1111-1111-1111-111111111111','helcim','payment','ach',
      16294, case when i=3 then 'failed' else 'succeeded' end,
      'recurring', sub,
      (date '2026-10-01' + ((i-1)||' month')::interval)::date,
      (date '2026-10-31' + ((i-1)||' month')::interval)::date,
      95000+i, i, '7200000'||i, now());
  end loop;
end $$;

\echo ''
\echo '═══════ 1. RECONCILIATION HEALTH ═══════'
do $$
declare h recurring_sync_health; n int;
begin
  select count(*) into n from recurring_sync_health;
  raise notice '% H1  exactly one health row exists (not a log table)', case when n=1 then 'PASS' else 'FAIL' end;

  perform record_sync_health('cron', true, null, 4, 1, 2, 1, 0, 0);
  select * into h from recurring_sync_health;
  raise notice '% H2  a successful run stamps last_success_at and clears the failure streak',
    case when h.last_success_at is not null and h.consecutive_failures=0 and h.subscriptions_scanned=4
         then 'PASS' else 'FAIL' end;

  perform record_sync_health('cron', false, 'provider unreachable');
  perform record_sync_health('cron', false, 'provider unreachable');
  select * into h from recurring_sync_health;
  raise notice '% H3  failures accumulate (%) and the last success is retained',
    case when h.consecutive_failures=2 and h.last_success_at is not null then 'PASS' else 'FAIL' end,
    h.consecutive_failures;

  raise notice '% H4  a failed run does NOT overwrite the last good counters',
    case when h.subscriptions_scanned=4 then 'PASS' else 'FAIL' end;

  perform record_sync_health('admin', true, null, 1, 0, 0, 1, 0, 0);
  select * into h from recurring_sync_health;
  raise notice '% H5  a success resets the streak and records the source (%)',
    case when h.consecutive_failures=0 and h.last_run_source='admin' then 'PASS' else 'FAIL' end, h.last_run_source;

  -- The failure mode this whole feature exists for.
  perform record_sync_forbidden();
  select * into h from recurring_sync_health;
  raise notice '% H6  a rejected worker key is recorded, so a silently-403ing cron job is visible',
    case when h.last_forbidden_at is not null and h.last_error ilike '%RECONCILE_WORKER_KEY%'
         then 'PASS' else 'FAIL' end;

  raise notice '% H7  health is still ONE row after all of that', 
    case when (select count(*) from recurring_sync_health)=1 then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 2. BILLING HISTORY COMES FROM THE EXISTING LEDGER ═══════'
do $$
declare sub uuid; n int; orig bigint; refunded bigint;
begin
  select id into sub from service_subscriptions where provider_subscription_id=88001;

  select count(*) into n from invoices where subscription_id=sub and invoice_source='recurring';
  raise notice '% B1  three recurring invoices exist, one per cycle', case when n=3 then 'PASS' else 'FAIL' end;

  select count(*) into n from payments where subscription_id=sub and kind='payment';
  raise notice '% B2  three ledger charges exist, one per cycle', case when n=3 then 'PASS' else 'FAIL' end;

  select count(*) into n from payments where subscription_id=sub and payment_source<>'recurring';
  raise notice '% B3  every cycle row is classified recurring', case when n=0 then 'PASS' else 'FAIL' end;

  -- Partial refund of cycle 1 through the append-only pattern.
  insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
    payment_source, subscription_id, refund_of, provider_transaction_id, notes, approved_at)
  select 'INV-V246CYC1', p.customer_id, 'helcim','refund','ach', 5000,'succeeded',
    'recurring', sub, p.id, '73000001','Missed PM visit — goodwill credit', now()
  from payments p where p.subscription_id=sub and p.provider_payment_number=1 and p.kind='payment';

  select amount_cents into orig from payments where subscription_id=sub and provider_payment_number=1 and kind='payment';
  select coalesce(sum(amount_cents),0) into refunded from payments
   where subscription_id=sub and kind in ('refund','reversal') and status='succeeded';
  raise notice '% B4  net retained on cycle 1 = % cents (16294 - 5000)',
    case when orig-refunded=11294 then 'PASS' else 'FAIL' end, orig-refunded;

  -- The original charge is never mutated.
  select count(*) into n from payments where subscription_id=sub and provider_payment_number=1
    and kind='payment' and amount_cents=16294 and status='succeeded';
  raise notice '% B5  the original charge row is untouched by the refund', case when n=1 then 'PASS' else 'FAIL' end;

  -- A second partial refund must still be possible (cycle-uniqueness must not block corrections).
  begin
    insert into payments (invoice_id, customer_id, provider, kind, method, amount_cents, status,
      payment_source, subscription_id, refund_of, provider_transaction_id, notes, approved_at)
    select 'INV-V246CYC1', p.customer_id,'helcim','refund','ach', 2000,'succeeded',
      'recurring', sub, p.id, '73000002','Second partial credit', now()
    from payments p where p.subscription_id=sub and p.provider_payment_number=1 and p.kind='payment';
    raise notice 'PASS B6  a SECOND partial refund of the same cycle is allowed';
  exception when others then raise notice 'FAIL B6  second partial refund blocked: %', sqlerrm;
  end;

  -- Refunding a month must not touch subscription state.
  raise notice '% B7  refunding a cycle did NOT cancel or alter the subscription',
    case when (select status from service_subscriptions where id=sub)='active' then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 3. RETRY ELIGIBILITY + AUDIT ═══════'
do $$
declare sub uuid; ok boolean; n int;
begin
  select id into sub from service_subscriptions where provider_subscription_id=88001;

  select count(*) into n from payments where subscription_id=sub and status='failed' and provider_payment_number=3;
  raise notice '% R1  cycle 3 is failed and therefore retry-eligible', case when n=1 then 'PASS' else 'FAIL' end;

  select count(*) into n from payments where subscription_id=sub and status='succeeded' and kind='payment';
  raise notice '% R2  succeeded cycles are NOT retry-eligible (% of them)', case when n=2 then 'PASS' else 'FAIL' end, n;

  -- Retry audit never mutates the money.
  update payments set retry_attempted_at=now(), retry_attempt_count=retry_attempt_count+1
   where subscription_id=sub and provider_payment_number=3 and kind='payment';
  select count(*) into n from payments
   where subscription_id=sub and provider_payment_number=3 and amount_cents=16294 and retry_attempt_count=1;
  raise notice '% R3  a retry attempt is recorded without changing the amount', case when n=1 then 'PASS' else 'FAIL' end;

  -- guard_payment still forbids editing a recurring amount.
  ok := false;
  begin update payments set amount_cents=1 where subscription_id=sub and provider_payment_number=3;
  exception when others then ok := true; end;
  raise notice '% R4  the ledger amount is still immutable under guard_payment', case when ok then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 4. LIFECYCLE NOTIFICATIONS ═══════'
do $$
declare sub uuid; n int; before int;
begin
  select id into sub from service_subscriptions where provider_subscription_id=88001;

  select count(*) into n from notification_outbox where event_type='subscription_activated';
  raise notice '% L1  activation queued a customer notice when the subscription went active',
    case when n>=1 then 'PASS' else 'FAIL' end;

  select count(*) into n from notification_outbox where event_type='subscription_activated_admin';
  raise notice '% L2  activation also queued an admin notice', case when n>=1 then 'PASS' else 'FAIL' end;

  -- A non-status update must not queue anything.
  select count(*) into before from notification_outbox;
  update service_subscriptions set next_billing_date=current_date+31 where id=sub;
  select count(*) into n from notification_outbox;
  raise notice '% L3  a non-status update queues nothing', case when n=before then 'PASS' else 'FAIL' end;

  -- Terminal transition.
  update service_subscriptions set status='completed' where id=sub;
  select count(*) into n from notification_outbox
   where event_key='subscription_term_ended:cust:'||sub||':completed';
  raise notice '% L4  term end queues exactly one customer notice', case when n=1 then 'PASS' else 'FAIL' end;

  -- Replay safety: repeating the same transition cannot duplicate.
  select count(*) into before from notification_outbox;
  update service_subscriptions set updated_at=now() where id=sub;
  select count(*) into n from notification_outbox;
  raise notice '% L5  touching a completed subscription does not duplicate the notice',
    case when n=before then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 5. NOTHING RECURRING WAS ENABLED ═══════'
do $$
declare n int;
begin
  raise notice '% G1  recurring_billing_enabled is still false',
    case when cfg_bool('recurring_billing_enabled')=false then 'PASS' else 'FAIL' end;
  select count(*) into n from service_subscriptions where paused_at is not null or resumed_at is not null;
  raise notice '% G2  no pause/resume has occurred (provider PATCH still blocked)',
    case when n=0 then 'PASS' else 'FAIL' end;
  select count(*) into n from service_subscriptions where term_changed_at is not null;
  raise notice '% G3  no term change has occurred', case when n=0 then 'PASS' else 'FAIL' end;
end $$;

\echo ''
\echo '═══════ 6. EXISTING V23 ONE-TIME FLOW STILL INTACT ═══════'
\t off
select 'invoice ' || id || ' = ' || status || ' / ' || invoice_source as one_time
  from invoices where id='INV-1A10E21B68';
select 'net retained on the reversed invoice = ' ||
  (coalesce(sum(amount_cents) filter (where kind='payment' and status='succeeded'),0)
 - coalesce(sum(amount_cents) filter (where kind in ('refund','reversal') and status='succeeded'),0))
  || ' cents (0 = V23 retry still permitted)' as one_time
  from payments where invoice_id='INV-1A10E21B68';
select 'one_time payments carrying no recurring metadata: ' || count(*) as one_time
  from payments where payment_source='one_time' and subscription_id is null
    and provider_subscription_payment_id is null;
