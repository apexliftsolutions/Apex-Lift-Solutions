-- =============================================================================
-- APEX — PAYMENT / EMAIL DIAGNOSTIC   (READ-ONLY, nothing is modified)
-- Replace INV-XXXXX with the invoice you paid.
-- =============================================================================

-- 1. Where did it stop?
select id, status, amount, subtotal_cents, tax_cents, paid_at, paid_via, payment_id
from invoices where id = 'INV-XXXXX';

select id, status, kind, method, amount_cents, fee_cents, total_charged_cents,
       provider_transaction_id, failure_category,
       initiated_at, approved_at, settled_at, completed_at
from payments where invoice_id = 'INV-XXXXX' order by created_at desc;

-- 2. The step-by-step trail. Look for persist_failed / invoice_status_inconsistent
--    / verify_deferred / amount_mismatch — detail contains the exact DB error.
select event, source, detail, created_at
from payment_events where invoice_id = 'INV-XXXXX' order by created_at desc;

/*  READ THE RESULTS LIKE THIS
    payment=initiated,  invoice=unpaid            -> validate never persisted; check payment_events
    payment=unknown                               -> found the txn but could not reconcile; detail says why
    payment=succeeded,  invoice=unpaid            -> recalc_invoice_status failed (usually a trigger raised)
    payment=succeeded,  invoice=paid              -> backend fine; problem is display/cache
    no payments row at all                        -> checkout never created one
*/

-- 3. If payment=succeeded but invoice is not paid, this shows what recalc sees.
select i.id, i.amount, round(i.amount*100)::bigint as total_c,
       coalesce(sum(p.amount_cents) filter (where p.kind='payment'  and p.status='succeeded'),0) as paid_c,
       coalesce(sum(p.amount_cents) filter (where p.kind in ('refund','reversal') and p.status='succeeded'),0) as refund_c,
       coalesce(sum(p.amount_cents) filter (where p.kind='payment'  and p.status in ('initiated','pending')),0) as pending_c,
       i.subtotal_cents, i.tax_cents,
       (coalesce(i.subtotal_cents,0)+coalesce(i.tax_cents,0)) = round(i.amount*100)::bigint as tax_reconciles
from invoices i left join payments p on p.invoice_id = i.id
where i.id = 'INV-XXXXX'
group by i.id, i.amount, i.subtotal_cents, i.tax_cents;
-- tax_reconciles = false means guard_tax_totals will RAISE and block every
-- update to this invoice, including recalc_invoice_status.

-- 4. Run recalc manually and see the real error, if any.
-- select recalc_invoice_status('INV-XXXXX');
-- select id, status, paid_at from invoices where id = 'INV-XXXXX';

-- =============================================================================
-- EMAIL
-- =============================================================================
select key, value from app_config
where key in ('admin_notification_email','service_notification_email');

select id, event_key, event_type, recipient, status, attempt_count,
       last_error, created_at, sent_at
from notification_outbox
where event_key like 'payment_received:%' or event_key like 'ach_submitted:%'
order by created_at desc limit 20;

/*  no row            -> payment never transitioned to succeeded (see section 1)
    status=pending    -> the outbox worker is not running; check pg_cron below
    status=failed     -> last_error has the Resend message
    sent, wrong to    -> update app_config.admin_notification_email
    sent, right to    -> check Resend dashboard + spam; verify SPF/DKIM      */

-- Is the worker actually scheduled?
-- NOTE: cron.job_run_details has no `jobname` column -- only `jobid`. Join to
-- cron.job to get the name. If pg_cron was never enabled, both of these error
-- with "relation cron.job does not exist", which is itself the answer.
select jobid, jobname, schedule, active, command from cron.job order by jobid;

select j.jobname,
       d.status,
       d.return_message,
       d.start_time,
       d.end_time
from cron.job_run_details d
left join cron.job j on j.jobid = d.jobid
order by d.start_time desc
limit 10;

-- If the two queries above error, pg_cron is not enabled. Check with:
select extname, extversion from pg_extension where extname in ('pg_cron','pg_net');
-- Nothing returned = the outbox worker has never run, so no email was ever
-- sent regardless of whether the payment succeeded. Enable pg_cron and pg_net
-- under Database -> Extensions, then schedule the jobs from the commented
-- block at the end of PRODUCTION_UPGRADE.sql.

-- Manual one-off drain, to test the worker without waiting for cron:
--   curl -X POST https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1/outbox-worker \
--        -H "x-outbox-key: <OUTBOX_WORKER_KEY>"
-- Expect {"sent":N,"failed":0}.

-- To change where payment emails go (no redeploy needed):
-- update app_config set value = 'apexliftsolutions1@gmail.com'
--  where key = 'admin_notification_email';
