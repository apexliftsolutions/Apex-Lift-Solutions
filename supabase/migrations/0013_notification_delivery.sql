-- =============================================================================
--  0013_notification_delivery.sql
--  Phase 2.1 — provider DELIVERY state, kept separate from transport state.
--
--  Additive only. Migrations 0001–0012 untouched.
--
--  Why a second set of columns instead of new `status` values:
--  `notification_outbox.status` is the WORKER's state machine — it answers
--  "does this still need sending?" (pending -> processing -> sent | failed).
--  Delivery answers a different question: "did the recipient's mail server
--  accept it?" Folding 'delivered' or 'bounced' into `status` would make the
--  worker's claim query ambiguous and could resurrect or strand a message.
--  The two are tracked independently and never overwrite each other.
--
--  Resend (Svix) is the source of delivery truth. Nothing here is set by a
--  browser; the webhook function uses the service role.
-- =============================================================================

alter table notification_outbox
  add column if not exists delivery_status      text,
  add column if not exists delivered_at         timestamptz,
  add column if not exists bounced_at           timestamptz,
  add column if not exists delivery_updated_at  timestamptz,
  add column if not exists delivery_event_at    timestamptz,
  add column if not exists delivery_detail      text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ck_outbox_delivery_status') then
    alter table notification_outbox add constraint ck_outbox_delivery_status
      check (delivery_status is null or delivery_status in
        ('delivered','bounced','complained','delayed','failed'));
  end if;
end $$;

comment on column notification_outbox.delivery_status     is 'Provider-confirmed outcome. NULL means no delivery event has arrived — NOT that delivery failed.';
comment on column notification_outbox.delivered_at        is 'Set only by an authoritative provider email.delivered event.';
comment on column notification_outbox.bounced_at          is 'Set only by an authoritative provider email.bounced event.';
comment on column notification_outbox.delivery_updated_at is 'When we APPLIED the last event (receipt time). Not usable for ordering.';
comment on column notification_outbox.delivery_event_at   is 'PROVIDER created_at of the event that produced the current delivery_status. Resend does not guarantee webhook order, so this — not arrival order — decides which event wins.';
comment on column notification_outbox.delivery_detail     is 'Short, safe provider explanation (e.g. bounce reason). Never a raw payload.';

-- provider_msg_id is how a webhook finds its row. Partial index: most rows have
-- one, and a lookup miss must be cheap because unknown ids are expected.
create index if not exists idx_outbox_provider_msg_id
  on notification_outbox (provider_msg_id) where provider_msg_id is not null;

-- Admin reads invoice delivery state by event_key.
create index if not exists idx_outbox_event_key_prefix
  on notification_outbox (event_key text_pattern_ops);

-- ─────────────────────────────────────────────────────────────────────────────
--  AUDIT TRAIL OF PROVIDER EVENTS
--  Kept separate from the outbox row so a replayed or out-of-order webhook is
--  diagnosable. The unique (provider_event_id) makes duplicate delivery of the
--  same Svix message harmless — the second insert is simply ignored.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists notification_delivery_events (
  id                bigserial primary key,
  provider_event_id text not null unique,        -- svix-id, unique per webhook message
  provider_msg_id   text not null,               -- Resend data.email_id
  outbox_id         bigint references notification_outbox (id) on delete set null,
  event_type        text not null,               -- email.delivered, email.bounced, ...
  occurred_at       timestamptz,                 -- provider's own created_at
  detail            text,
  received_at       timestamptz not null default now()
);
create index if not exists idx_delivery_events_msg on notification_delivery_events (provider_msg_id);

alter table notification_delivery_events enable row level security;
-- Admin may read for support/diagnosis. No customer policy exists at all, so a
-- customer cannot see it even with a token; writes are service-role only.
drop policy if exists "delivery_events_admin_read" on notification_delivery_events;
create policy "delivery_events_admin_read" on notification_delivery_events
  for select using (is_admin());

revoke all on notification_delivery_events from anon, authenticated;
grant select on notification_delivery_events to authenticated;   -- RLS still gates it to admin
grant all    on notification_delivery_events to service_role;
grant usage, select on sequence notification_delivery_events_id_seq to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
--  APPLY ONE PROVIDER EVENT
--  service_role only. The webhook function verifies the Svix signature BEFORE
--  calling this; no browser-JWT check here for the same reason as the Phase 2
--  RPCs (a service-role call carries no user JWT).
--
--  Idempotent by construction:
--    * the unique provider_event_id makes a replayed webhook a no-op;
--    * an unknown provider_msg_id updates NO outbox row — it is recorded and
--      reported, never guessed at;
--    * a late 'delivered' after a 'bounced' does not overwrite the bounce.
-- ─────────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────────
--  ONE PLACE DECIDES WHETHER AN EVENT WINS
--
--  Resend documents that webhook delivery order is NOT guaranteed and that the
--  payload's created_at should be used when ordering matters. Arrival order is
--  therefore meaningless: a delivery_delayed that OCCURRED at 10:00 can arrive
--  after a delivered that occurred at 10:01, and must not regress the display
--  from "Delivered" to "Delivery delayed".
--
--  Rules, in order:
--    1. Nothing applied yet            -> the event wins.
--    2. Event is older than or equal to the applied event -> stale, ignored.
--    3. A NEGATIVE outcome already applied (bounced/complained/failed) is not
--       overwritten by a positive one (delivered/delayed) even if newer: a
--       message the receiving server rejected was not delivered. A later
--       negative event (e.g. a complaint after delivery) still wins.
--    4. Otherwise the newer event wins.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function delivery_event_wins(
  p_current_status text, p_current_at timestamptz,
  p_new_status text,     p_new_at timestamptz
) returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when p_new_status is null then false
    -- The whole state machine is ordered by the provider's event time. An event
    -- without one cannot be ordered, so it must never become the winning state
    -- — it would bypass every guard below. It is still retained for diagnosis.
    when p_new_at is null then false
    when p_current_status is null then true
    when p_current_at is not null and p_new_at is not null and p_new_at <= p_current_at then false
    when p_current_status in ('bounced','complained','failed')
         and p_new_status in ('delivered','delayed') then false
    else true
  end;
$$;

create or replace function delivery_status_of(p_event_type text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case p_event_type
    when 'email.delivered'        then 'delivered'
    when 'email.bounced'          then 'bounced'
    when 'email.complained'       then 'complained'
    when 'email.delivery_delayed' then 'delayed'
    when 'email.failed'           then 'failed'
    else null end;
$$;

-- Pure comparison helpers: no table access, no state, nothing sensitive. They
-- are readable logic, so admin tooling may call them; the functions that CHANGE
-- state remain service_role only.
revoke all on function delivery_event_wins(text, timestamptz, text, timestamptz) from public, anon;
revoke all on function delivery_status_of(text) from public, anon;
grant  execute on function delivery_event_wins(text, timestamptz, text, timestamptz) to authenticated, service_role;
grant  execute on function delivery_status_of(text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
--  RECONCILE EVERY RECORDED EVENT FOR ONE OUTBOX ROW
--
--  Recomputes delivery state from the full event history rather than from the
--  single event that happened to arrive last. That makes the outcome
--  independent of arrival order AND makes late attachment of an early event
--  (the provider_msg_id race) self-healing: the events are already stored, so
--  replaying them in provider-timestamp order produces the right answer.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function reconcile_delivery_state(p_outbox_id bigint)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare r record; cur_status text; cur_at timestamptz; cur_detail text;
begin
  for r in
    select delivery_status_of(event_type) as st, occurred_at, detail
      from notification_delivery_events
     where outbox_id = p_outbox_id
       and delivery_status_of(event_type) is not null
       and occurred_at is not null          -- unordered events never decide state
     order by occurred_at, id
  loop
    if delivery_event_wins(cur_status, cur_at, r.st, r.occurred_at) then
      cur_status := r.st; cur_at := r.occurred_at; cur_detail := r.detail;
    end if;
  end loop;

  update notification_outbox
     set delivery_status     = cur_status,
         delivery_event_at   = cur_at,
         delivery_detail     = cur_detail,
         delivered_at        = case when cur_status = 'delivered' then cur_at else null end,
         bounced_at          = case when cur_status in ('bounced','complained','failed') then cur_at else null end,
         delivery_updated_at = now()
   where id = p_outbox_id;

  return jsonb_build_object('outbox_id', p_outbox_id, 'delivery_status', cur_status, 'event_at', cur_at);
end;
$$;

revoke all on function reconcile_delivery_state(bigint) from public, anon, authenticated;
grant  execute on function reconcile_delivery_state(bigint) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
--  APPLY ONE PROVIDER EVENT
--  service_role only. The webhook function verifies the Svix signature BEFORE
--  calling this; no browser-JWT check here (a service-role call carries no user
--  JWT, so is_admin() could never be satisfied by its only legitimate caller).
--
--  The event is ALWAYS recorded, even when no outbox row carries that
--  provider_msg_id yet. That is the fix for the race between Resend returning
--  an email_id and outbox-worker committing it: the event is retained, and the
--  trigger below attaches and applies it the moment the id lands.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function apply_delivery_event(
  p_provider_event_id text,
  p_provider_msg_id   text,
  p_event_type        text,
  p_occurred_at       timestamptz,
  p_detail            text
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_outbox_id bigint; v_status text; v_inserted int := 0; v_attached int := 0; v_res jsonb;
begin
  if coalesce(trim(p_provider_event_id), '') = '' then raise exception 'provider_event_id required'; end if;
  if coalesce(trim(p_provider_msg_id), '')   = '' then raise exception 'provider_msg_id required'; end if;

  v_status := delivery_status_of(p_event_type);

  select id into v_outbox_id from notification_outbox
   where provider_msg_id = p_provider_msg_id for update;

  -- Record first, always. The unique provider_event_id is what makes a replayed
  -- webhook a no-op; an unmatched event is retained with outbox_id null.
  insert into notification_delivery_events
    (provider_event_id, provider_msg_id, outbox_id, event_type, occurred_at, detail)
  values (p_provider_event_id, p_provider_msg_id, v_outbox_id, p_event_type, p_occurred_at, left(p_detail, 500))
  on conflict (provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_outbox_id is null then
    -- NEVER guess. No recipient, subject or timestamp matching: only the
    -- provider's own email_id correlates an event to an invoice.
    -- MISSED-WAKEUP RACE.
    -- The trigger below is the fast path, but it only fires if the event is
    -- already committed when provider_msg_id lands. This interleaving defeats it:
    --   A: look up provider id  -> not found
    --   B: worker sets provider_msg_id, trigger finds nothing, commits
    --   A: inserts the event, unattached, forever
    -- So an unresolved event reports `unresolved`, the Edge Function answers
    -- non-2xx, Resend retries (documented at-least-once delivery), and the
    -- branch above attaches the already-recorded event on that retry.
    return jsonb_build_object('applied', false, 'reason', 'unknown_provider_msg_id',
                              'retained', true, 'unresolved', true,
                              'duplicate', v_inserted = 0);
  end if;
  if v_status is null then
    return jsonb_build_object('applied', false, 'reason', 'unmapped_event_type',
                              'outbox_id', v_outbox_id, 'duplicate', v_inserted = 0);
  end if;
  if v_inserted = 0 then
    -- A repeat of an event we already hold. That is NOT automatically a no-op:
    -- if the event was retained unattached (the missed-wakeup race below) and
    -- the provider id has since been committed, this retry is exactly the
    -- opportunity to attach it. Correlation is still the provider id alone.
    update notification_delivery_events
       set outbox_id = v_outbox_id
     where provider_event_id = p_provider_event_id and outbox_id is null;
    get diagnostics v_attached = row_count;
    if v_attached > 0 then
      v_res := reconcile_delivery_state(v_outbox_id);
      return jsonb_build_object('applied', true, 'reason', 'attached_on_retry',
                                'outbox_id', v_outbox_id,
                                'delivery_status', v_res->>'delivery_status');
    end if;
    return jsonb_build_object('applied', false, 'reason', 'duplicate_event',
                              'outbox_id', v_outbox_id, 'duplicate', true);
  end if;

  -- Recompute from the whole history, so arrival order cannot decide the answer.
  v_res := reconcile_delivery_state(v_outbox_id);
  return jsonb_build_object('applied', (v_res->>'delivery_status') is not null,
                            'outbox_id', v_outbox_id,
                            'delivery_status', v_res->>'delivery_status',
                            'event_applied', v_status);
end;
$$;

revoke all on function apply_delivery_event(text, text, text, timestamptz, text)
  from public, anon, authenticated;
grant  execute on function apply_delivery_event(text, text, text, timestamptz, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
--  THE RACE: an event can arrive before its provider_msg_id is committed
--
--  outbox-worker POSTs to Resend, gets an email_id back, then UPDATEs the row.
--  A fast webhook can land in that window. Rather than change the worker (and
--  its send/retry semantics), this trigger fires when provider_msg_id first
--  appears: it attaches any events already retained for that exact id and
--  recomputes state. No worker change, no lost event, no guessing.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function attach_pending_delivery_events()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare v_attached int;
begin
  if new.provider_msg_id is null then return new; end if;
  if old.provider_msg_id is not distinct from new.provider_msg_id then return new; end if;

  update notification_delivery_events
     set outbox_id = new.id
   where provider_msg_id = new.provider_msg_id and outbox_id is null;
  get diagnostics v_attached = row_count;

  if v_attached > 0 then
    -- Fires AFTER UPDATE OF provider_msg_id only, and this recompute touches
    -- the delivery columns, so it cannot re-enter.
    perform reconcile_delivery_state(new.id);
  end if;
  return new;
end;
$$;

revoke all on function attach_pending_delivery_events() from public, anon, authenticated;

drop trigger if exists trg_attach_pending_delivery on notification_outbox;
create trigger trg_attach_pending_delivery
  after update of provider_msg_id on notification_outbox
  for each row execute function attach_pending_delivery_events();

-- ─────────────────────────────────────────────────────────────────────────────
--  NOTE ON TRANSPORT STATE
--  `status` and its check constraint are deliberately UNCHANGED. outbox-worker
--  continues to claim rows on status alone and knows nothing about delivery.
-- ─────────────────────────────────────────────────────────────────────────────
