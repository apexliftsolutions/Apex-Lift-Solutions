-- =============================================================================
--  0012_equipment_links.sql
--  Phase 2 — quotes and invoices carry a real link to customer_equipment plus a
--  FROZEN identity snapshot of the machine at the moment the document was made.
--
--  Additive only. Migrations 0001–0011 are untouched. No backfill: historical
--  rows keep equipment_id NULL and their free-text `equipment` label, because
--  matching "Toyota 8FGCU25" to a unit would fabricate a relationship.
--
--  Both quotes.id and invoices.id are TEXT; customer_id is uuid on both, which
--  is what the composite FK needs.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. COLUMNS
--    The legacy `equipment text` column stays on both tables and keeps being
--    populated. Email templates, CSV export, print output, search and every
--    historical row read it; removing it would break all of them.
-- ─────────────────────────────────────────────────────────────────────────────
alter table quotes
  add column if not exists equipment_id       uuid,
  add column if not exists equipment_snapshot jsonb;

alter table invoices
  add column if not exists equipment_id       uuid,
  add column if not exists equipment_snapshot jsonb,
  -- invoices has never had the free-text column quotes has. It is added here so
  -- inheritance has somewhere to land and invoice display gets the same
  -- fallback quotes already have.
  add column if not exists equipment          text;

comment on column quotes.equipment_id         is 'customer_equipment.id. NULL for historical rows and for deliberate no-forklift quotes.';
comment on column quotes.equipment_snapshot   is 'Frozen identity of the unit when the quote was created. Never rewritten when the live unit changes.';
comment on column invoices.equipment_id       is 'Inherited verbatim from the quote. Never re-derived.';
comment on column invoices.equipment_snapshot is 'Inherited verbatim from the quote snapshot, so the invoice names the machine the customer approved.';
comment on column invoices.equipment         is 'Human-readable label copied from the quote. Display fallback for rows with no snapshot.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. OWNERSHIP, ENFORCED BY THE DATABASE
--    Same composite-key pattern service_plan_offers already uses: the FK is on
--    (equipment_id, customer_id), so a quote for customer A physically cannot
--    reference customer B's forklift. Dropdown filtering is a convenience, not
--    a guarantee.
--    ON DELETE RESTRICT is belt-and-braces — 0011 forbids equipment deletes
--    outright — but it keeps the intent explicit at the schema level.
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_quote_equipment_same_customer') then
    alter table quotes add constraint fk_quote_equipment_same_customer
      foreign key (equipment_id, customer_id)
      references customer_equipment (id, customer_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'fk_invoice_equipment_same_customer') then
    alter table invoices add constraint fk_invoice_equipment_same_customer
      foreign key (equipment_id, customer_id)
      references customer_equipment (id, customer_id) on delete restrict;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SNAPSHOT CONSISTENCY
--    A linked document must carry its snapshot. An unlinked one must carry
--    neither. Historical rows satisfy this automatically (both NULL).
--    NOT VALID: existing rows are not re-checked, so the migration cannot fail
--    on legacy data; every future insert and update IS checked.
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_quote_equipment_snapshot_pair') then
    alter table quotes add constraint ck_quote_equipment_snapshot_pair
      check ((equipment_id is null) = (equipment_snapshot is null)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_invoice_equipment_snapshot_pair') then
    alter table invoices add constraint ck_invoice_equipment_snapshot_pair
      check ((equipment_id is null) = (equipment_snapshot is null)) not valid;
  end if;
end $$;

create index if not exists idx_quotes_equipment   on quotes (equipment_id)   where equipment_id is not null;
create index if not exists idx_invoices_equipment on invoices (equipment_id) where equipment_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. THE SNAPSHOT IS FROZEN
--    Editing a forklift's nickname must never rewrite a document the customer
--    already saw. Once a snapshot is set it cannot be changed or cleared; the
--    only permitted transition is NULL -> a value (linking a draft quote).
--    equipment_id may change while the snapshot is still NULL; a linked quote
--    that switches units goes through the same path and gets a NEW snapshot,
--    which this trigger allows only because the snapshot moves with it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function document_equipment_snapshot_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.equipment_snapshot is not null
     and new.equipment_snapshot is distinct from old.equipment_snapshot then
    raise exception 'document_snapshot_frozen'
      using errcode = 'check_violation',
            detail  = format('%s already records the equipment it was issued for; that identity cannot be rewritten.', tg_table_name);
  end if;
  return new;
end;
$$;

revoke all on function document_equipment_snapshot_frozen() from public, anon, authenticated;

drop trigger if exists trg_quote_snapshot_frozen   on quotes;
drop trigger if exists trg_invoice_snapshot_frozen on invoices;
create trigger trg_quote_snapshot_frozen   before update on quotes
  for each row execute function document_equipment_snapshot_frozen();
create trigger trg_invoice_snapshot_frozen before update on invoices
  for each row execute function document_equipment_snapshot_frozen();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. LINKING A QUOTE — the server-authoritative path
--    The admin browser currently inserts quotes straight through PostgREST, so
--    it cannot be trusted to supply a snapshot. This function is the only way
--    to attach equipment: it verifies ownership and active status itself and
--    generates the snapshot from the live row with 0011's equipment_snapshot().
--    A caller cannot pass a snapshot in.
--
--    security definer, service_role-only. Authentication of the human admin
--    happens in admin-action before the service-role client is used.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function link_quote_equipment(p_quote_id text, p_equipment_id uuid)
returns quotes
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare q quotes; eq customer_equipment; snap jsonb; out_row quotes;
begin
  -- NO is_admin() here, deliberately. This RPC is granted to service_role ONLY
  -- (see the revoke/grant below), and a service-role call carries no end-user
  -- JWT — so auth.jwt()->>'email' is null and an is_admin() check would reject
  -- the only caller that can reach it. admin-action authenticates the browser
  -- admin BEFORE it uses the service-role client; that is where the human
  -- identity is verified. Keeping a second, incompatible check here made the
  -- real runtime path fail while a hand-set request.jwt.claims made the test
  -- pass.

  select * into q from quotes where id = p_quote_id for update;
  if not found then raise exception 'quote_not_found'; end if;

  -- Ownership is checked here AND by the composite FK. This check exists to
  -- return a clear error instead of a raw constraint violation.
  select * into eq from customer_equipment
   where id = p_equipment_id and customer_id = q.customer_id;
  if not found then
    raise exception 'equipment_not_owned'
      using errcode = 'check_violation',
            detail  = 'That forklift does not belong to this customer.';
  end if;

  if eq.status <> 'active' then
    raise exception 'equipment_not_active'
      using errcode = 'check_violation',
            detail  = format('This forklift is %s and cannot be used on a new quote.', eq.status);
  end if;

  -- An already-invoiced quote is history; its equipment must not move.
  if q.invoiced then
    raise exception 'quote_already_invoiced'
      using errcode = 'check_violation',
            detail  = 'This quote has been invoiced. Its equipment can no longer be changed.';
  end if;
  -- Once the customer has responded, the identity they saw is the record.
  if q.status <> 'pending' then
    raise exception 'quote_not_pending'
      using errcode = 'check_violation',
            detail  = format('This quote is %s. Equipment can only be set while it is pending.', q.status);
  end if;

  snap := equipment_snapshot(p_equipment_id);

  -- The legacy free-text column keeps being written so every existing reader —
  -- email templates, CSV, print, search — keeps working unchanged.
  update quotes
     set equipment_id       = p_equipment_id,
         equipment_snapshot = snap,
         equipment          = equipment_label(snap)
   where id = p_quote_id
  returning * into out_row;

  return out_row;
end;
$$;

revoke all on function link_quote_equipment(text, uuid) from public, anon, authenticated;
grant  execute on function link_quote_equipment(text, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. QUOTE -> INVOICE now carries the equipment across
--    Replaces the 0004 definition. The three equipment columns are COPIED from
--    the quote; equipment_snapshot() is deliberately NOT called again. The
--    invoice must describe the machine the customer approved, not whatever the
--    live record looks like at invoicing time.
--    Everything else — the approved/invoiced checks, the
--    tax copying, the 30-day due date — is unchanged from 0004.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function quote_to_invoice(p_quote_id text)
returns invoices language plpgsql security definer set search_path = public, pg_temp as $$
declare q quotes; inv invoices;
begin
  -- service_role ONLY (revoke/grant below). Same reasoning as
  -- link_quote_equipment: a service-role call carries no user JWT, so an
  -- is_admin() email check here would reject its only legitimate caller.
  -- admin-action verifies the human admin before calling.
  --
  -- FOR UPDATE + the invoiced check below are what serialise two near
  -- simultaneous Convert clicks: the second waits on the row lock, then sees
  -- invoiced = true and raises. Exactly one invoice can exist per quote.
  select * into q from quotes where id = p_quote_id for update;
  if not found then raise exception 'quote_not_found'; end if;
  if q.status <> 'approved' then raise exception 'quote_not_approved'; end if;
  if q.invoiced then raise exception 'quote_already_invoiced'; end if;

  insert into invoices (
    customer_id, customer_email, customer_name, company, description, items,
    subtotal_cents, tax_cents, tax_rate_milli_pct, tax_exempt, tax_jurisdiction,
    amount, status, quote_id, due,
    equipment, equipment_id, equipment_snapshot
  ) values (
    q.customer_id, q.customer_email, q.customer_name, q.company,
    coalesce(q.description, 'Forklift Service'), q.items,
    q.subtotal_cents, q.tax_cents, q.tax_rate_milli_pct, q.tax_exempt, q.tax_jurisdiction,
    q.amount, 'unpaid', q.id, now() + interval '30 days',
    q.equipment, q.equipment_id, q.equipment_snapshot   -- inherited verbatim
  ) returning * into inv;

  update quotes set invoiced = true where id = p_quote_id;
  return inv;
end $$;
revoke all on function quote_to_invoice(text) from public, anon, authenticated;
grant  execute on function quote_to_invoice(text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ATOMIC EQUIPMENT ON QUOTE INSERT
--    notify_on_quote() is an AFTER INSERT trigger that reads new.equipment and
--    enqueues the quote_created payload. A two-step "insert then link" therefore
--    shipped an EMPTY equipment label in every customer email, permanently —
--    and left a customer-visible quote behind if the link then failed.
--
--    This BEFORE INSERT trigger resolves the equipment inside the same
--    statement, so by the time the AFTER trigger runs the label is already
--    correct. A rejected unit aborts the INSERT: no quote row, no outbox row.
--
--    The browser supplies equipment_id ONLY. Any snapshot or label it sends is
--    overwritten here, so it can never be trusted into the record.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function quote_equipment_before_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare eq customer_equipment; snap jsonb;
begin
  if new.equipment_id is null then
    -- Explicit "No specific forklift": a real Apex quote type (site visit,
    -- travel). Anything the client sent in the other two columns is discarded.
    new.equipment_snapshot := null;
    new.equipment := coalesce(nullif(new.equipment, ''), '');
    return new;
  end if;

  select * into eq from customer_equipment
   where id = new.equipment_id and customer_id = new.customer_id;
  if not found then
    raise exception 'equipment_not_owned'
      using errcode = 'check_violation',
            detail  = 'That forklift does not belong to this customer.';
  end if;
  if eq.status <> 'active' then
    raise exception 'equipment_not_active'
      using errcode = 'check_violation',
            detail  = format('This forklift is %s and cannot be used on a new quote.', eq.status);
  end if;

  snap := equipment_snapshot(new.equipment_id);
  new.equipment_snapshot := snap;              -- server-generated, always
  new.equipment          := equipment_label(snap);
  return new;
end;
$$;

revoke all on function quote_equipment_before_insert() from public, anon, authenticated;

drop trigger if exists trg_quote_equipment_before_insert on quotes;
-- BEFORE, so it runs ahead of trg_notify_quote (AFTER INSERT).
create trigger trg_quote_equipment_before_insert before insert on quotes
  for each row execute function quote_equipment_before_insert();
