-- =============================================================================
--  0014_quote_invoice_integrity.sql
--  Phase 2.2 — exactly one invoice per quote, and conversion that is safe to
--  attempt twice.
--
--  Migrations 0001–0013 are NOT edited.
--
--  ROOT CAUSE this migration addresses (database half):
--    * Nothing stopped two invoices carrying the same quote_id.
--    * quote_to_invoice() RAISED when the quote was already invoiced. The admin
--      browser turned that raise into an unhandled exception, so the admin saw
--      nothing at all and clicked again. Conversion is now IDEMPOTENT: a second
--      attempt returns the invoice that already exists instead of failing.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ONE QUOTE -> AT MOST ONE INVOICE
--    Partial: historical invoices with a NULL quote_id (direct/recurring) are
--    unaffected and can coexist freely.
--
--    FAILS SAFELY on existing duplicates: CREATE UNIQUE INDEX aborts the whole
--    migration and names the conflict. It deletes nothing. Financial history is
--    never removed automatically — the preflight in internal-docs lists any
--    duplicates so a human decides.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare dup record; n int;
begin
  select count(*) into n from (
    select quote_id from invoices where quote_id is not null
    group by quote_id having count(*) > 1) d;
  if n > 0 then
    for dup in select quote_id, count(*) c, string_agg(id, ', ' order by created_at) ids
                 from invoices where quote_id is not null
                group by quote_id having count(*) > 1 loop
      raise warning 'quote % already has % invoices: %', dup.quote_id, dup.c, dup.ids;
    end loop;
    raise exception 'duplicate_invoices_exist'
      using detail = format('%s quote(s) already have more than one invoice. Nothing was changed. '
                            'Review them with internal-docs/PREFLIGHT_0014_quote_invoice.sql and '
                            'Voiding one is NOT enough: a voided invoice keeps its quote_id and the unique '
                            'index still rejects it. Send the section C-D output before changing anything.', n);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. OWNERSHIP AND ORPHAN GUARDS — the migration must fail closed too, not
--     rely on a human reading the preflight output.
--
--     Both abort before anything is created or updated. Neither rewrites a
--     financial record: an invoice's owner and a quote's consumed state are
--     decisions for the owner, not side effects of a schema change.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare r record; n int;
begin
  -- A. Linked invoice owned by the wrong customer, or by nobody. The customer
  --    portal reads `customer_id = auth.uid()`, so these invoices are invisible
  --    to the customer who approved the quote. Marking such a quote INVOICED
  --    would cement exactly the symptom this phase exists to fix.
  select count(*) into n
    from invoices i join quotes q on q.id = i.quote_id
   where i.customer_id is null or i.customer_id is distinct from q.customer_id;
  if n > 0 then
    for r in select i.id inv, i.quote_id, i.customer_id inv_cust, q.customer_id quote_cust
               from invoices i join quotes q on q.id = i.quote_id
              where i.customer_id is null or i.customer_id is distinct from q.customer_id loop
      raise warning 'invoice % (quote %) owner % does not match quote owner %', r.inv, r.quote_id, r.inv_cust, r.quote_cust;
    end loop;
    raise exception 'invoice_owner_mismatch'
      using detail = format('%s linked invoice(s) have a wrong or missing customer_id. Those customers cannot see their invoice. '
                            'Nothing was changed. Review section C-C of internal-docs/PREFLIGHT_0014_quote_invoice.sql; '
                            'rewriting the owner of a financial record is an owner decision, not a migration step.', n);
  end if;

  -- B. Quote flagged invoiced with no invoice behind it. Could be a deleted
  --    invoice or historical drift; the correct repair differs, so refuse.
  select count(*) into n
    from quotes q
   where q.invoiced = true
     and not exists (select 1 from invoices i where i.quote_id = q.id);
  if n > 0 then
    for r in select q.id, q.customer_email, q.amount from quotes q
              where q.invoiced = true
                and not exists (select 1 from invoices i where i.quote_id = q.id) loop
      raise warning 'quote % (%) is flagged invoiced but has no invoice', r.id, r.customer_email;
    end loop;
    raise exception 'invoiced_flag_without_invoice'
      using detail = format('%s quote(s) are flagged invoiced with no linked invoice. Nothing was changed. '
                            'Resetting the flag makes them convertible again; leaving it treats them as consumed. '
                            'See section C-B of the preflight and decide before re-running.', n);
  end if;
end $$;

create unique index if not exists uq_invoice_quote_id
  on invoices (quote_id) where quote_id is not null;

comment on index uq_invoice_quote_id is
  'One quote converts to at most one invoice. Partial so direct and recurring invoices (quote_id null) are unaffected.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. IDEMPOTENT CONVERSION
--    Replaces the 0012 definition. Same authority model: service_role only, no
--    in-function is_admin() (a service-role call carries no user JWT).
--
--    Returns jsonb rather than an invoices row so a repeat attempt can report
--    "already invoiced, here it is" instead of raising.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function quote_to_invoice_v2(p_quote_id text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare q quotes; existing invoices; inv invoices;
begin
  -- FOR UPDATE serialises two simultaneous conversions: the second waits here,
  -- then sees the invoice the first created and returns it.
  select * into q from quotes where id = p_quote_id for update;
  if not found then
    raise exception 'quote_not_found' using errcode = 'no_data_found';
  end if;

  -- Invoice existence is checked BEFORE the status rule, so a quote whose
  -- status later changed can still report its invoice rather than erroring.
  select * into existing from invoices where quote_id = q.id limit 1;
  if found then
    -- Self-heal a quote whose flag never persisted. This is the exact state
    -- that made the admin button reappear and invite a second click.
    if not q.invoiced then
      update quotes set invoiced = true where id = q.id;
    end if;
    return jsonb_build_object(
      'already_invoiced', true, 'created', false,
      'invoice_id', existing.id, 'quote_id', q.id,
      'customer_id', existing.customer_id, 'amount', existing.amount,
      'status', existing.status, 'repaired_flag', not q.invoiced);
  end if;

  if q.status <> 'approved' then
    raise exception 'quote_not_approved' using errcode = 'check_violation';
  end if;

  insert into invoices (
    customer_id, customer_email, customer_name, company, description, items,
    subtotal_cents, tax_cents, tax_rate_milli_pct, tax_exempt, tax_jurisdiction,
    amount, status, quote_id, due,
    equipment, equipment_id, equipment_snapshot
  ) values (
    -- customer_id comes from the QUOTE and nowhere else. The browser cannot
    -- supply an owner: without this the invoice is invisible to the customer
    -- and unpayable while still showing in admin.
    q.customer_id, q.customer_email, q.customer_name, q.company,
    coalesce(q.description, 'Forklift Service'), q.items,
    q.subtotal_cents, q.tax_cents, q.tax_rate_milli_pct, q.tax_exempt, q.tax_jurisdiction,
    q.amount, 'unpaid', q.id, now() + interval '30 days',
    q.equipment, q.equipment_id, q.equipment_snapshot   -- inherited verbatim, never re-derived
  ) returning * into inv;

  update quotes set invoiced = true where id = q.id;

  return jsonb_build_object(
    'already_invoiced', false, 'created', true,
    'invoice_id', inv.id, 'quote_id', q.id,
    'customer_id', inv.customer_id, 'amount', inv.amount,
    'status', inv.status, 'repaired_flag', false);
end;
$$;

revoke all on function quote_to_invoice_v2(text) from public, anon, authenticated;
grant  execute on function quote_to_invoice_v2(text) to service_role;

-- The 0012 signature stays callable so nothing breaks mid-deploy, but it now
-- delegates: one implementation, one set of rules.
create or replace function quote_to_invoice(p_quote_id text)
returns invoices language plpgsql security definer set search_path = public, pg_temp as $$
declare res jsonb; inv invoices;
begin
  res := quote_to_invoice_v2(p_quote_id);
  select * into inv from invoices where id = res->>'invoice_id';
  return inv;
end $$;
revoke all on function quote_to_invoice(text) from public, anon, authenticated;
grant  execute on function quote_to_invoice(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. REPAIR EXISTING DRIFT
--    Any quote that already has an invoice but never got its flag set is the
--    live symptom. Fixing the data is safe and additive: it only sets a boolean
--    that the invoice's existence already proves.
-- ─────────────────────────────────────────────────────────────────────────────
update quotes q set invoiced = true
 where not q.invoiced
   and exists (select 1 from invoices i where i.quote_id = q.id);
