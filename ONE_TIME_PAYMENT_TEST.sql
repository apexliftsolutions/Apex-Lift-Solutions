-- =============================================================================
-- APEX — ONE-TIME CARD PAYMENT: END-TO-END VERIFICATION   (READ-ONLY)
--
-- Nothing here modifies data. Run section A before paying, B and C after.
-- Replace INV-XXXXX in all three sections with your test invoice id.
--
-- Use a SMALL real amount ($1–$5). Do not pay the same invoice twice.
-- =============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION A — BEFORE. Run this after creating the invoice, before paying.
-- Record the output. Everything should read "unpaid / no payments yet".
-- ═════════════════════════════════════════════════════════════════════════════
select 'BEFORE' phase, i.id, i.status, i.amount,
       i.subtotal_cents, i.tax_cents, i.paid_at, i.paid_via, i.payment_id,
       i.customer_id is not null as has_portal_link,
       (coalesce(i.subtotal_cents,0)+coalesce(i.tax_cents,0)) = round(i.amount*100)::bigint as tax_reconciles
from invoices i where i.id = 'INV-XXXXX';

select 'BEFORE' phase, count(*) as payment_rows from payments where invoice_id = 'INV-XXXXX';

-- Baseline the outbox so section C can tell new mail from old.
select 'BEFORE' phase, count(*) as outbox_rows from notification_outbox;

-- Preconditions that must ALL be true or the test cannot pass.
select 'PRECONDITION' k, x.item, x.ok from (
  values
   ('pg_cron installed (else no email will ever send)',
     exists(select 1 from pg_extension where extname='pg_cron')),
   ('pg_net installed',
     exists(select 1 from pg_extension where extname='pg_net')),
   ('outbox cron job scheduled',
     exists(select 1 from cron.job where command ilike '%outbox-worker%')),
   ('admin_notification_email configured',
     exists(select 1 from app_config where key='admin_notification_email' and value <> '')),
   ('recalc_invoice_status exists',
     exists(select 1 from pg_proc where proname='recalc_invoice_status')),
   ('invoice is linked to a portal account',
     exists(select 1 from invoices where id='INV-XXXXX' and customer_id is not null)),
   ('invoice is unpaid',
     exists(select 1 from invoices where id='INV-XXXXX' and status='unpaid'))
) as x(item, ok);


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION B — AFTER. Run once the card has been approved in Helcim.
-- ═════════════════════════════════════════════════════════════════════════════
select 'AFTER' phase, id, status, amount, paid_at, paid_via, payment_id
from invoices where id = 'INV-XXXXX';

select 'AFTER' phase, id, status, kind, method, method_display,
       amount_cents, fee_cents, total_charged_cents,
       provider_transaction_id, failure_category,
       initiated_at, approved_at, settled_at, completed_at
from payments where invoice_id = 'INV-XXXXX' order by created_at desc;

-- The trail. persist_failed / invoice_status_inconsistent / verify_deferred
-- carry the exact Postgres or Helcim error in `detail`.
select 'AFTER' phase, event, source, detail, created_at
from payment_events where invoice_id = 'INV-XXXXX' order by created_at;

select 'AFTER' phase, event_key, event_type, recipient, status,
       attempt_count, last_error, sent_at
from notification_outbox
where entity_id in (select id::text from payments where invoice_id = 'INV-XXXXX')
   or entity_id = 'INV-XXXXX'
order by created_at;


-- ═════════════════════════════════════════════════════════════════════════════
-- SECTION C — VERDICT. One row per checkpoint. Every row must read PASS.
-- ═════════════════════════════════════════════════════════════════════════════
with inv as (select * from invoices where id = 'INV-XXXXX'),
     pay as (select * from payments where invoice_id = 'INV-XXXXX'
              and kind='payment' order by created_at desc limit 1),
     nb  as (select event_type, recipient, status from notification_outbox
              where entity_id in (select id::text from payments where invoice_id='INV-XXXXX'))
select * from (
  values
  ( 6, 'payments.status = succeeded',
        (select status from pay), 'succeeded'),
  ( 7, 'provider_transaction_id stored',
        (select case when provider_transaction_id is not null and provider_transaction_id <> ''
                then 'stored' else 'MISSING' end from pay), 'stored'),
  ( 8, 'no persist_failed event',
        (select case when count(*)=0 then 'clean' else 'FAILURES LOGGED' end
           from payment_events where invoice_id='INV-XXXXX'
            and event in ('persist_failed','invoice_status_inconsistent')), 'clean'),
  ( 9, 'invoices.status = paid',
        (select status from inv), 'paid'),
  (10, 'invoices.paid_at populated',
        (select case when paid_at is not null then 'set' else 'NULL' end from inv), 'set'),
  (11, 'ledger settles the invoice total',
        (select case when coalesce((select sum(amount_cents) from payments
                                     where invoice_id='INV-XXXXX' and kind='payment'
                                       and status='succeeded'),0)
                        >= round((select amount from inv)*100)::bigint
                then 'covered' else 'SHORT' end), 'covered'),
  (13, 'customer payment email queued',
        (select case when count(*)>0 then 'queued' else 'MISSING' end
           from nb where event_type='payment_received'), 'queued'),
  (14, 'Apex admin payment email queued',
        (select case when count(*)>0 then 'queued' else 'MISSING' end
           from nb where event_type='payment_received_admin'), 'queued'),
  (17, 'all payment emails actually sent',
        (select case when count(*) filter (where status <> 'sent') = 0 and count(*) > 0
                then 'sent' else 'NOT SENT' end from nb), 'sent'),
  (18, 'approved event recorded',
        (select case when count(*)>0 then 'recorded' else 'MISSING' end
           from payment_events where invoice_id='INV-XXXXX' and event='approved'), 'recorded'),
  (20, 'no manual payment was recorded',
        (select case when count(*)=0 then 'automatic' else 'MANUAL USED' end
           from payments where invoice_id='INV-XXXXX' and provider='manual'), 'automatic'),
  (99, 'exactly ONE succeeded payment (no double charge)',
        (select count(*)::text from payments where invoice_id='INV-XXXXX'
           and kind='payment' and status='succeeded'), '1'),
  (98, 'exactly ONE customer email (no duplicate)',
        (select count(*)::text from nb where event_type='payment_received'), '1'),
  (97, 'exactly ONE admin email (no duplicate)',
        (select count(*)::text from nb where event_type='payment_received_admin'), '1'),
  (96, 'fee + base = total charged',
        (select case when coalesce(total_charged_cents, amount_cents)
                       = amount_cents + coalesce(fee_cents,0)
                then 'consistent' else 'MISMATCH' end from pay), 'consistent'),
  (95, 'tax breakdown still reconciles',
        (select case when (coalesce(subtotal_cents,0)+coalesce(tax_cents,0))
                        = round(amount*100)::bigint
                then 'reconciles' else 'BROKEN' end from inv), 'reconciles')
) as t(step, checkpoint, actual, expected)
order by step;
-- Add a verdict column mentally: actual = expected -> PASS.


-- ═════════════════════════════════════════════════════════════════════════════
-- ABANDONED CHECKOUT TEST (separate invoice — do not reuse the paid one)
-- Open checkout, close without paying, then run:
-- ═════════════════════════════════════════════════════════════════════════════
select 'ABANDONED' phase, i.status as invoice_status,
       p.status as payment_status, p.failure_category, p.initiated_at
from invoices i left join payments p on p.invoice_id = i.id
where i.id = 'INV-YYYYY' order by p.created_at desc;
-- Immediately after closing : invoice may read payment_pending, payment 'initiated'.
-- After clicking Pay again  : the stale row becomes 'voided' and a new one opens.
-- After ~90 min or one      : payment-reconcile sweeps it to 'voided' and recalcs.
--   reconcile run             invoice returns to 'unpaid'.
-- MUST NOT appear: any payment_received email for this invoice.
select 'ABANDONED' phase, count(*) as false_emails
from notification_outbox
where event_type like 'payment_received%'
  and entity_id in (select id::text from payments where invoice_id = 'INV-YYYYY');
-- Expect 0.
