-- =============================================================================
-- APEX LIFT SOLUTIONS — ORPHANED QUOTE / INVOICE REPAIR  (NON-DESTRUCTIVE)
--
-- Symptom this fixes: an invoice is visible in the admin portal but the customer
-- cannot see it under My Invoices and cannot pay it.
--
-- Cause: the row has customer_id NULL (or pointing at a customers row that is
-- not the customer's portal account). customer_id is the ONLY ownership link
-- used by the customer portal query, by RLS, and by payment-checkout. Email is
-- deliberately NOT a security boundary and is never used for matching access.
--
-- This file DIAGNOSES first. The repair step is written to relink ONLY where the
-- match is unambiguous, and it never guesses.
--
-- No DROP TABLE. No TRUNCATE. No DELETE. Read STEP 1 before running STEP 2.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1 — DIAGNOSE (read-only, run this first)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. Invoices no customer can see
select i.id, i.customer_email, i.company, i.amount, i.status, i.created_at,
       case
         when i.customer_id is null then 'NULL customer_id'
         when c.id is null          then 'customer_id points at a missing customers row'
         else 'ok'
       end as problem
from invoices i
left join customers c on c.id = i.customer_id
where i.customer_id is null or c.id is null
order by i.created_at desc;

-- 1b. Same for quotes
select q.id, q.customer_email, q.company, q.amount, q.status, q.created_at,
       case when q.customer_id is null then 'NULL customer_id'
            when c.id is null          then 'missing customers row'
            else 'ok' end as problem
from quotes q
left join customers c on c.id = q.customer_id
where q.customer_id is null or c.id is null
order by q.created_at desc;

-- 1c. Preview of what STEP 2 would relink. Only rows where exactly ONE active
--     customer account matches the stored email are eligible.
select i.id as invoice_id, i.customer_email, c.id as would_link_to, c.name, c.status
from invoices i
join customers c on lower(c.email) = lower(i.customer_email)
where i.customer_id is null
  and (select count(*) from customers c2 where lower(c2.email) = lower(i.customer_email)) = 1;

-- 1d. Invoices stuck at payment_pending with no live payment behind them.
--     These were locked by an abandoned checkout.
select i.id, i.status, i.amount,
       (select count(*) from payments p
         where p.invoice_id = i.id and p.status in ('initiated','pending')) as live_attempts
from invoices i
where i.status = 'payment_pending'
order by i.created_at desc;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2 — REPAIR
-- Review STEP 1c output first. Uncomment and run only if the matches are right.
-- ─────────────────────────────────────────────────────────────────────────────

-- begin;
--
-- -- Relink invoices whose stored email matches exactly one customers row.
-- update invoices i
--    set customer_id = c.id
--   from customers c
--  where i.customer_id is null
--    and lower(c.email) = lower(i.customer_email)
--    and (select count(*) from customers c2 where lower(c2.email) = lower(i.customer_email)) = 1;
--
-- update quotes q
--    set customer_id = c.id
--   from customers c
--  where q.customer_id is null
--    and lower(c.email) = lower(q.customer_email)
--    and (select count(*) from customers c2 where lower(c2.email) = lower(q.customer_email)) = 1;
--
-- commit;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 — UNSTICK payment_pending INVOICES
-- Voids abandoned checkout attempts older than 90 minutes and re-derives the
-- invoice status. Never touches a succeeded payment.
-- ─────────────────────────────────────────────────────────────────────────────

-- begin;
--
-- update payments
--    set status = 'voided', failure_category = 'abandoned', completed_at = now()
--  where provider = 'helcim'
--    and kind     = 'payment'
--    and status   = 'initiated'
--    and initiated_at < now() - interval '90 minutes';
--
-- do $$
-- declare r record;
-- begin
--   for r in select distinct invoice_id from payments
--             where status = 'voided' and failure_category = 'abandoned'
--   loop
--     perform recalc_invoice_status(r.invoice_id);
--   end loop;
-- end $$;
--
-- commit;


-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4 — PREVENT RECURRENCE (run only after STEP 1 shows zero orphans)
-- The admin portal now refuses to create a quote without a portal-linked
-- customer. This makes the database enforce it too.
-- ─────────────────────────────────────────────────────────────────────────────

-- alter table quotes   alter column customer_id set not null;
-- alter table invoices alter column customer_id set not null;
