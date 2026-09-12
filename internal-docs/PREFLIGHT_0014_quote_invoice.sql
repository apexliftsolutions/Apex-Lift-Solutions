-- =============================================================================
--  READ-ONLY PREFLIGHT for 0014_quote_invoice_integrity.sql
--  Run in the Supabase SQL editor BEFORE applying 0014. Changes nothing.
--
--  0014 adds a UNIQUE index on invoices.quote_id and will ABORT (deleting
--  nothing) if any quote already has two invoices. Section D finds those.
-- =============================================================================

-- ── A. Recent approved quotes and their conversion state ────────────────────
select 'A. approved quotes' as section, q.id as quote_id, q.customer_id, q.customer_email,
       q.status, q.invoiced, q.equipment_id, q.created_at, q.responded_at
  from quotes q
 where q.status = 'approved'
 order by q.created_at desc
 limit 50;

-- ── B. Invoices linked to a quote ───────────────────────────────────────────
select 'B. linked invoices' as section, i.id as invoice_id, i.quote_id,
       i.customer_id, i.status, i.amount, i.created_at
  from invoices i
 where i.quote_id is not null
 order by i.created_at desc
 limit 50;

-- ── C. BROKEN STATES ────────────────────────────────────────────────────────
-- A: quote says not invoiced, but an invoice exists  (the reported symptom:
--    admin keeps seeing the Create Invoice button). 0014 repairs these.
select 'C-A flag says false but invoice exists' as problem, q.id as quote_id,
       i.id as invoice_id, q.customer_id as quote_customer, i.customer_id as invoice_customer
  from quotes q join invoices i on i.quote_id = q.id
 where q.invoiced = false;

-- B: quote says invoiced, but no invoice exists (a lost or deleted invoice).
select 'C-B flag says true but NO invoice' as problem, q.id as quote_id,
       q.customer_id, q.customer_email, q.amount, q.responded_at
  from quotes q
 where q.invoiced = true
   and not exists (select 1 from invoices i where i.quote_id = q.id);

-- C: invoice linked to a quote but with a missing or MISMATCHED owner. These
--    are invisible to the customer portal and unpayable.
select 'C-C invoice owner wrong or null' as problem, i.id as invoice_id, i.quote_id,
       i.customer_id as invoice_customer, q.customer_id as quote_customer,
       case when i.customer_id is null then 'NULL owner — customer cannot see or pay it'
            else 'owner differs from the quote' end as detail
  from invoices i join quotes q on q.id = i.quote_id
 where i.customer_id is null or i.customer_id is distinct from q.customer_id;

-- D: MORE THAN ONE INVOICE FOR ONE QUOTE. 0014 refuses to run while any exist.
--    STOP and inspect all duplicate invoices manually. Do not delete, void as a
--    supposed uniqueness repair, null quote_id, move payments, or rewrite
--    ownership until the repair is agreed from the actual records below.
--    (Voiding an invoice for genuine accounting reasons is fine — it just does
--    not clear the duplicate quote_id, so it does not unblock this migration.)
select 'C-D duplicate invoices for one quote' as problem, i.quote_id,
       count(*) as invoice_count, string_agg(i.id, ', ' order by i.created_at) as invoice_ids,
       string_agg(i.status, ', ' order by i.created_at) as statuses,
       sum(case when exists (select 1 from payments p where p.invoice_id = i.id) then 1 else 0 end) as with_payments
  from invoices i
 where i.quote_id is not null
 group by i.quote_id
having count(*) > 1;

-- E: approved quote with no invoice and no conversion state — never converted.
select 'C-E approved, never converted' as problem, q.id as quote_id, q.customer_id,
       q.customer_email, q.amount, q.responded_at
  from quotes q
 where q.status = 'approved' and q.invoiced = false
   and not exists (select 1 from invoices i where i.quote_id = q.id)
 order by q.responded_at desc nulls last;

-- ── D. CURRENT PRODUCTION DEFINITIONS ───────────────────────────────────────
select 'D. current quote_to_invoice source' as section,
       pg_get_functiondef(oid) as definition
  from pg_proc where proname = 'quote_to_invoice';

select 'D. indexes on invoices' as section, indexname, indexdef
  from pg_indexes where tablename = 'invoices';

select 'D. constraints involving quote_id' as section, conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid = 'invoices'::regclass
   and pg_get_constraintdef(oid) ilike '%quote_id%';

select 'D. customer SELECT RLS on invoices' as section, policyname, cmd, qual
  from pg_policies where tablename = 'invoices';

-- ── E. GO / NO-GO ───────────────────────────────────────────────────────────
--  GO requires ALL THREE integrity blockers to be clear:
--    C-B  quote flagged invoiced with no invoice  -> a lost invoice; 0014 must
--         not consume the flag on a guess.
--    C-C  linked invoice owned by the wrong (or no) customer -> THE reported
--         symptom. Admin sees INVOICED, the customer sees nothing. A verdict
--         that ignored this could say GO while the customer is still blind.
--    C-D  duplicate invoices for one quote -> the unique index would reject.
--
--  C-A is NOT a blocker: 0014 repairs it deliberately.
--  C-E is NOT a blocker: an approved quote simply not invoiced yet is normal.
with b as (
  select count(*) n from quotes q
   where q.invoiced = true
     and not exists (select 1 from invoices i where i.quote_id = q.id)),
c as (
  select count(*) n from invoices i join quotes q on q.id = i.quote_id
   where i.customer_id is null or i.customer_id is distinct from q.customer_id),
d as (
  select count(*) n from (select quote_id from invoices
          where quote_id is not null group by quote_id having count(*) > 1) x)
select case
  when b.n > 0 or c.n > 0 or d.n > 0 then
    'STOP — ' ||
    concat_ws('; ',
      case when b.n > 0 then b.n || ' quote(s) flagged invoiced with NO invoice (C-B)' end,
      case when c.n > 0 then c.n || ' invoice(s) with wrong or missing customer_id (C-C) — these customers CANNOT see their invoice' end,
      case when d.n > 0 then d.n || ' quote(s) with duplicate invoices (C-D)' end)
    || '. 0014 will abort and change nothing. See the sections above, then read the guidance below.'
  else 'GO — integrity checks clean (C-B, C-C and C-D are all zero); 0014 can be applied'
  end as verdict
from b, c, d;

-- ── F. WHAT TO DO WITH EACH BLOCKER ─────────────────────────────────────────
--
--  C-D  DUPLICATE INVOICES
--       Voiding the surplus invoice is NOT enough. A voided invoice keeps its
--       quote_id, so `unique (quote_id) where quote_id is not null` still
--       rejects it. Section C-D lists id, status, amount and whether payments
--       exist. Send that output before changing anything.
--       Do NOT, without agreeing the repair first:
--         * delete an invoice
--         * null out its quote_id
--         * move payments between invoices
--         * rewrite invoice ownership
--       An invoice with payment history is financial record; the repair depends
--       on which one the customer actually paid.
--
--  C-C  OWNERSHIP MISMATCH
--       The customer portal reads invoices by `customer_id = auth.uid()`, so an
--       invoice with the wrong owner is invisible to the customer who approved
--       the quote — and visible to whoever it was wrongly assigned to.
--       Rewriting the owner of an existing financial record is a decision, not
--       a migration step. Report the ids.
--
--  C-B  FLAG WITHOUT AN INVOICE
--       Either the invoice was deleted, or the flag was set without one. The
--       right repair differs: resetting `invoiced` to false makes the quote
--       convertible again; leaving it true treats the quote as consumed.
--       0014 refuses to choose.
