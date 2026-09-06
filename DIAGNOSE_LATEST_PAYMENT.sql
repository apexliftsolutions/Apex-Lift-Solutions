-- =============================================================================
-- APEX — WHICH CHECKPOINT DID THE LATEST PAYMENT REACH?   (READ-ONLY)
-- Run this as-is. It finds the newest Helcim attempt automatically.
-- =============================================================================

-- 1. The newest Helcim attempt and its invoice.
select p.created_at, p.invoice_id, p.status as payment_status, p.method,
       p.amount_cents, p.fee_cents, p.total_charged_cents,
       p.provider_transaction_id, p.failure_category,
       i.status as invoice_status, i.paid_at, i.paid_via
from payments p join invoices i on i.id = p.invoice_id
where p.provider = 'helcim' and p.kind = 'payment'
order by p.created_at desc limit 3;

-- 2. Its full event trail, newest attempt only.
select e.created_at, e.event, e.source, e.detail
from payment_events e
where e.payment_id = (select id from payments
                       where provider='helcim' and kind='payment'
                       order by created_at desc limit 1)
order by e.created_at;

-- 3. WHICH CODE VERSION RAN?  This is the question that keeps costing us tests.
--    fn_version     = the deployed Edge Function
--    client_version = the deployed portal-customer.js
--    They should match. A missing fn_version means the Edge Function is OLDER
--    than the frontend -- git push publishes the site automatically, but
--    Edge Functions only deploy when you run `npx supabase functions deploy`.
select e.created_at,
       e.detail ->> 'fn_version'     as edge_function_version,
       e.detail ->> 'client_version' as frontend_version,
       e.detail ->> 'wrapper'        as response_wrapper,
       e.detail ->> 'transactionIdFound' as txn_id_found,
       e.detail ->> 'hashFound'          as hash_found
from payment_events e
where e.event = 'validation_started'
order by e.created_at desc limit 5;

-- 4. Checkpoint verdict for the newest attempt.
with p as (select id, invoice_id from payments
            where provider='helcim' and kind='payment'
            order by created_at desc limit 1),
     ev as (select event from payment_events where payment_id = (select id from p))
select step, checkpoint,
       case when reached then 'REACHED' else '<-- STOPPED HERE' end as verdict
from (values
  (1,'checkout_created',                (select bool_or(event='checkout_created') from ev)),
  (2,'validation_started',              (select bool_or(event='validation_started') from ev)),
  (3,'transaction_response_normalized', (select bool_or(event='transaction_response_normalized') from ev)),
  (4,'provider_lookup_started',         (select bool_or(event='provider_lookup_started') from ev)),
  (5,'provider_lookup_succeeded',       (select bool_or(event='provider_lookup_succeeded') from ev)),
  (6,'provider_approved',               (select bool_or(event='provider_approved') from ev)),
  (7,'payment_persisted',               (select bool_or(event='payment_persisted') from ev)),
  (8,'invoice_paid',                    (select bool_or(event='invoice_paid') from ev))
) t(step, checkpoint, reached)
order by step;

-- 5. Emails for that invoice.
select event_key, event_type, recipient, status, attempt_count, last_error, sent_at
from notification_outbox
where entity_id in (select id::text from payments
                     where provider='helcim' and kind='payment'
                     order by created_at desc limit 1)
order by created_at;

-- 6. Is the outbox worker even running?
select extname from pg_extension where extname in ('pg_cron','pg_net');
select count(*) filter (where status='pending') as pending,
       count(*) filter (where status='sent')    as sent,
       count(*) filter (where status='failed')  as failed
from notification_outbox;
