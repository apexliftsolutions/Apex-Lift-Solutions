-- =============================================================================
--  0011_equipment_core.sql
--  Equipment Phase 1 — customer_equipment becomes the canonical forklift record
--  for the rest of Apex.
--
--  Additive only. Does not edit 0001–0010. No backfill: no row is invented and
--  no serial is fabricated. Every protection here is a DATABASE rule so that it
--  holds regardless of which Edge Function, RPC or migration performs a write.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. NEW DESCRIPTIVE COLUMNS (all nullable; no existing row changes)
-- ─────────────────────────────────────────────────────────────────────────────
alter table customer_equipment
  add column if not exists nickname     text,
  add column if not exists power_type   text,
  add column if not exists capacity_lbs integer,
  add column if not exists retired_at   timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_equipment_power_type') then
    alter table customer_equipment add constraint ck_equipment_power_type
      check (power_type is null or power_type in ('electric','lp','diesel','gas','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_equipment_capacity_positive') then
    alter table customer_equipment add constraint ck_equipment_capacity_positive
      check (capacity_lbs is null or capacity_lbs > 0);
  end if;
end $$;

comment on column customer_equipment.nickname     is 'What the customer calls it ("Dock 3 truck"). Optional.';
comment on column customer_equipment.power_type   is 'electric | lp | diesel | gas | other. Optional.';
comment on column customer_equipment.capacity_lbs is 'Rated capacity in pounds. Optional, must be > 0 when set.';
comment on column customer_equipment.retired_at   is 'Set by trigger the first time status becomes retired. Never cleared.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. SERIAL NUMBER CONTRACT
--    Nullable stays nullable. A blank string is rejected rather than silently
--    stored: callers must send NULL for "unknown". Placeholder words are
--    rejected so a fake serial can never collide with a real one under the
--    existing per-customer unique index.
-- ─────────────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_equipment_serial_not_blank') then
    alter table customer_equipment add constraint ck_equipment_serial_not_blank
      check (serial_number is null or length(trim(serial_number)) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_equipment_serial_not_placeholder') then
    alter table customer_equipment add constraint ck_equipment_serial_not_placeholder
      check (serial_number is null
             or upper(trim(serial_number)) not in ('N/A','NA','UNKNOWN','NONE','TBD','NULL','-'));
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SNAPSHOT + LABEL
--    Used by future quote / invoice / service-request linking. Not wired to
--    those tables in this migration. Contains only document-safe identity —
--    nothing financial, nothing internal.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function equipment_snapshot(p_equipment_id uuid)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',            e.id,
    'unit_number',   e.unit_number,
    'nickname',      e.nickname,
    'year',          e.year,
    'make',          e.make,
    'model',         e.model,
    'serial_number', e.serial_number,
    'captured_at',   now()
  )
  from customer_equipment e
  where e.id = p_equipment_id;
$$;

-- Human-readable line. Nulls are skipped, never rendered as "null"/"undefined".
-- Examples:  "2019 Toyota 8FGCU25 · #TRK-7 · SN 12345"
--            "Dock 3 truck (Hyster H50)"      (nickname, no year/serial)
--            "Forklift"                        (nothing known)
create or replace function equipment_label(p jsonb)
returns text
language sql immutable
set search_path = public, pg_temp
as $$
  with parts as (
    select nullif(trim(concat_ws(' ',
             nullif(trim(p->>'year'),''),
             nullif(trim(p->>'make'),''),
             nullif(trim(p->>'model'),''))), '') as ymm,
           nullif(trim(p->>'nickname'),'')       as nick,
           nullif(trim(p->>'unit_number'),'')    as unit,
           nullif(trim(p->>'serial_number'),'')  as sn
  )
  select coalesce(
    nullif(concat_ws(' · ',
      case when nick is not null and ymm is not null then nick || ' (' || ymm || ')'
           else coalesce(nick, ymm) end,
      case when unit is not null then '#' || unit end,
      case when sn   is not null then 'SN ' || sn end), ''),
    'Forklift')
  from parts;
$$;

revoke all on function equipment_snapshot(uuid) from public, anon;
revoke all on function equipment_label(jsonb)   from public, anon;
grant execute on function equipment_snapshot(uuid) to authenticated, service_role;
grant execute on function equipment_label(jsonb)   to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. PROTECTIONS — one BEFORE UPDATE trigger, one BEFORE DELETE trigger
--    Live subscription statuses are taken from the REAL check constraint in
--    0006, not from a design document: everything that is not terminal.
--      terminal: cancelled, completed, failed_setup
--      live:     setup_pending, method_verified, active, past_due, paused,
--                cancel_requested
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function equipment_protect()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- A. Ownership never moves. The composite FKs bind offers and agreements to
  --    (equipment, customer); reassigning would silently re-point a contract.
  if new.customer_id is distinct from old.customer_id then
    raise exception 'equipment_customer_immutable'
      using errcode = 'check_violation',
            detail  = 'customer_id cannot change after creation';
  end if;

  -- B. Identity lock. Once ANY agreement row names this machine, the fields
  --    that identify it are frozen — permanently. Every service_plan_agreements
  --    row is a signed contract (signer_name, signature_typed and signed_at are
  --    NOT NULL; the only insert path is accept_offer_and_sign_agreement).
  --    'superseded' and 'cancelled' are later states of that signed contract,
  --    and the historical document must keep naming the same physical machine.
  --    No status filter, on purpose. Descriptive fields stay editable.
  if (new.serial_number is distinct from old.serial_number
      or new.make  is distinct from old.make
      or new.model is distinct from old.model
      or new.year  is distinct from old.year)
     and exists (select 1 from service_plan_agreements a
                 where a.equipment_id = old.id) then
    raise exception 'equipment_under_signed_agreement'
      using errcode = 'check_violation',
            detail  = 'Serial, make, model and year are frozen once this unit has been named in a signed agreement, including agreements since cancelled or superseded.';
  end if;

  -- C. Retire guard. Retiring a unit with a live plan would orphan a billing
  --    subscription. Cancel or complete the plan first.
  if new.status = 'retired' and old.status <> 'retired'
     and exists (select 1 from service_subscriptions s
                 where s.equipment_id = old.id
                   and s.status not in ('cancelled','completed','failed_setup')) then
    raise exception 'equipment_has_live_subscription'
      using errcode = 'check_violation',
            detail  = 'This unit has a live service subscription. Cancel or complete it before retiring the unit.';
  end if;

  -- C2. A customer-facing offer must be cancelled or expire before the unit can
  --     be retired, otherwise a customer could sign a plan for a machine that no
  --     longer exists. Deliberately NOT auto-cancelling from here: cancellation
  --     is an explicit, audited admin action. A draft offer does not block —
  --     send-offer refuses non-active equipment, so a draft can never reach the
  --     customer once the unit is retired.
  if new.status = 'retired' and old.status <> 'retired'
     and exists (select 1 from service_plan_offers o
                 where o.equipment_id = old.id and o.status = 'sent') then
    raise exception 'equipment_has_open_offer'
      using errcode = 'check_violation',
            detail  = 'This unit has a service plan offer awaiting the customer. Cancel the offer before retiring the unit.';
  end if;

  -- E. retired_at is set exactly once, server-side, and never cleared.
  --    Retired is terminal in this phase: there is deliberately no restore
  --    path. A future audited admin operation may add one.
  if new.status = 'retired' and old.status <> 'retired' then
    new.retired_at := coalesce(old.retired_at, now());
  elsif old.status = 'retired' and new.status <> 'retired' then
    raise exception 'equipment_retired_is_terminal'
      using errcode = 'check_violation',
            detail  = 'A retired unit cannot be reactivated in this version.';
  end if;

  return new;
end;
$$;

-- D. No hard delete, ever — even for a unit with no references yet. Status is
--    the lifecycle. The existing ON DELETE RESTRICT FKs already refuse deletes
--    where history exists; this closes the gap for brand-new rows.
create or replace function equipment_no_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'equipment_delete_forbidden'
    using errcode = 'check_violation',
          detail  = 'Equipment is never deleted. Set status to retired.';
end;
$$;

revoke all on function equipment_protect()   from public, anon, authenticated;
revoke all on function equipment_no_delete() from public, anon, authenticated;

drop trigger if exists trg_equipment_protect   on customer_equipment;
drop trigger if exists trg_equipment_no_delete on customer_equipment;
create trigger trg_equipment_protect   before update on customer_equipment
  for each row execute function equipment_protect();
create trigger trg_equipment_no_delete before delete on customer_equipment
  for each row execute function equipment_no_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS / GRANTS — deliberately UNCHANGED
--    authenticated keeps SELECT-only. There is still no INSERT/UPDATE grant, so
--    PostgREST cannot write this table directly; all customer writes go through
--    the equipment-customer Edge Function, which derives customer_id from the
--    verified session. The existing audit trigger (0006) covers the new columns
--    automatically because it records the whole row.
-- ─────────────────────────────────────────────────────────────────────────────
