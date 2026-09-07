-- =============================================================================
-- APEX LIFT SOLUTIONS — MONTHLY SERVICE PLANS / RECURRING BILLING
-- PHASE A: schema + RLS + database-level integrity.
-- NON-DESTRUCTIVE against the existing schema. Safe to re-run.
--
-- Revision 2 — incorporates the independent Phase A audit.
--   R2.1  cross-entity/customer integrity enforced by composite FKs
--   R2.2  agreement INSERT validated against the offer, in the database
--   R2.3  subscription INSERT validated against the signed agreement
--   R2.4  explicit lifecycle transition graphs; terminal states are terminal
--   R2.5  signed agreements cannot be DELETEd, including by service_role
--   R2.6  service_plan_events enforced append-only
--   R2.7  verify sessions expire and are single-use
--   R2.8  recurring/one-time discriminators tightened both ways
--   R2.9  "provider honesty" wording corrected — see section 5
--   R2.10 atomic accept-offer + sign-agreement RPC
--
-- Run AFTER: PRODUCTION_UPGRADE.sql, FEESAVER_UPGRADE.sql, TAX_UPGRADE.sql,
--            APEX_REFUND_VOID_V22.sql.
--
-- =============================================================================
-- WHAT THIS SCRIPT DOES NOT DO  (verify with SERVICE_PLANS_PREFLIGHT.sql)
-- =============================================================================
--   * no DROP TABLE, DROP COLUMN, TRUNCATE, DELETE, or UPDATE of any existing row
--   * no ALTER COLUMN TYPE / SET NOT NULL on any existing column
--   * no CREATE OR REPLACE of any existing function
--        (recalc_invoice_status, notify_on_payment, notify_on_invoice,
--         guard_payment, guard_tax_totals, enqueue_notification are untouched)
--   * no change to any existing RLS policy
--   * no change to the invoices.status or payments.status CHECK constraints
--   * no notification triggers on the new tables — those land in Phase B/C
--     together with the matching outbox-worker templates
--   * recurring billing is NOT enabled. recurring_billing_enabled = 'false'.
--
-- The ONLY DROP statements in this file are `IF EXISTS` against objects this
-- same migration creates (its own constraints, indexes, policies, triggers).
-- That is what makes it re-runnable, and what lets Revision 2 tighten a
-- constraint Revision 1 defined more loosely. Nothing pre-existing is dropped.
--
-- =============================================================================
-- MONEY
-- =============================================================================
-- All service-plan money is integer cents. Never floats.
-- Tax semantics match TAX_UPGRADE.sql exactly:
--     subtotal_cents + tax_cents = total_cents
--     tax_rate_milli_pct stores thousandths of a percent (8625 = 8.625%)
-- Apex remains the sole tax authority. The Helcim payment plan must be
-- taxType = 'no_tax' or subscription-activate refuses to activate (Phase E).
--
-- =============================================================================
-- PROVIDER VOCABULARY  (verified against Helcim v2.2 docs 2026-09-06)
-- =============================================================================
--   Helcim subscription paymentMethod enum is 'card' | 'bank'  — NOT 'ach'.
--   Apex keeps its own native 'card' | 'ach' vocabulary here so these tables
--   agree with payments.method, which already checks ('card','ach',...).
--   The Apex->Helcim mapping ach -> 'bank' happens in the Edge Function, once,
--   at the API boundary. See docs/HELCIM_RECURRING_VERIFIED_V24.md.
--
-- =============================================================================
-- THREAT MODEL FOR THIS FILE
-- =============================================================================
-- RLS protects against a hostile browser. It does NOT protect against Apex's
-- own server code: every Edge Function writes with the service role, which
-- bypasses RLS entirely.
--
-- Therefore the rules that decide who owes what, and how much, are enforced as
-- constraints and triggers. Triggers fire for service_role and for the table
-- owner. A future bug in an Edge Function cannot sign a contract for the wrong
-- amount, attach a plan to another customer's forklift, or resurrect a
-- cancelled subscription.
-- =============================================================================

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. SHARED HELPERS
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

-- Boolean read of app_config that fails CLOSED. A missing/garbage key is false.
create or replace function public.cfg_bool(k text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select lower(trim(value)) in ('true','t','1','yes','on')
       from app_config where key = k),
    false);
$$;
revoke all on function public.cfg_bool(text) from public, anon, authenticated;
grant  execute on function public.cfg_bool(text) to service_role;

-- Rejects a state change that is not on the allowed transition graph. Staying
-- in the same state is always permitted, so an UPDATE that touches other
-- columns is never treated as a transition.
create or replace function public.assert_transition(
  p_entity text, p_id text, p_old text, p_new text, p_allowed text[])
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if p_old is not distinct from p_new then return; end if;
  if p_new = any (p_allowed) then return; end if;
  raise exception '% % cannot move from % to % (allowed: %)',
    p_entity, p_id, p_old, p_new,
    case when coalesce(array_length(p_allowed,1),0) = 0
         then 'none — this is a terminal state'
         else array_to_string(p_allowed, ', ') end;
end $$;
revoke all on function public.assert_transition(text,text,text,text,text[])
  from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CONFIGURATION — recurring billing ships DISABLED
--
-- Non-secret flags and provider plan IDs only. Secrets stay in Edge Function
-- secrets (docs/SECRETS_SETUP.md).
--
-- DO NOT flip recurring_billing_enabled to 'true' in this file, in a migration,
-- or in a deployment script. It is flipped by hand, once, after Phase E review.
-- ─────────────────────────────────────────────────────────────────────────────
insert into app_config (key, value) values
  ('recurring_billing_enabled',            'false'),
  ('service_plan_contract_mode',           'test'),
  ('service_plan_agreement_version',       'APEX-MSP-2026-09-DRAFT'),
  ('service_plan_default_term_months',     '6'),
  ('service_plan_offer_expiry_days',       '30'),
  ('service_plan_verify_session_minutes',  '60'),   -- Helcim checkout token TTL
  -- Helcim payment-plan IDs, created deliberately in the Helcim dashboard and
  -- re-verified by subscription-activate before every activation. Blank until set.
  ('helcim_recurring_plan_id_expires',     ''),
  ('helcim_recurring_plan_id_expires_card',''),
  ('helcim_recurring_plan_id_expires_bank',''),
  ('helcim_recurring_plan_id_forever',     '')
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CUSTOMER EQUIPMENT
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists customer_equipment (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers(id) on delete restrict,
  unit_number      text,
  year             text,
  make             text,
  model            text,
  serial_number    text,
  equipment_type   text not null default 'forklift',
  service_location text,
  notes            text,
  status           text not null default 'active'
                   check (status in ('active','inactive','retired')),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- R2.1 — the target half of the composite FK below. Without this, PostgreSQL
-- cannot express "this equipment belongs to this customer" declaratively.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uq_equipment_id_customer') then
    alter table customer_equipment add constraint uq_equipment_id_customer
      unique (id, customer_id);
  end if;
end $$;

create index if not exists ix_equipment_customer on customer_equipment(customer_id);
create index if not exists ix_equipment_status   on customer_equipment(customer_id, status);

create unique index if not exists uq_equipment_serial
  on customer_equipment (customer_id, upper(trim(serial_number)))
  where serial_number is not null and trim(serial_number) <> '';

comment on table  customer_equipment               is 'Forklifts / units a customer owns. One unit may carry one live service plan.';
comment on column customer_equipment.serial_number is 'Optional at offer time. Unique per customer when present.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. SERVICE PLAN OFFERS
--
-- A versioned recommendation for ONE unit, carrying an explicit ACH price and
-- an explicit CARD price, because Fee Saver is unavailable on recurring billing.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists service_plan_offers (
  id                          uuid primary key default gen_random_uuid(),
  customer_id                 uuid not null references customers(id)          on delete restrict,
  equipment_id                uuid not null references customer_equipment(id) on delete restrict,

  status                      text not null default 'draft'
                              check (status in ('draft','sent','accepted','declined','expired','cancelled')),
  offer_version               integer not null default 1 check (offer_version >= 1),
  supersedes_offer_id         uuid references service_plan_offers(id),

  plan_name                   text not null,
  description                 text,
  included_services           jsonb not null default '[]'::jsonb,
  exclusions                  jsonb not null default '[]'::jsonb,

  term_months                 integer not null default 6 check (term_months between 1 and 120),
  activation_date             date,

  ach_monthly_subtotal_cents  bigint not null check (ach_monthly_subtotal_cents  > 0),
  ach_monthly_tax_cents       bigint not null default 0 check (ach_monthly_tax_cents  >= 0),
  ach_monthly_total_cents     bigint not null check (ach_monthly_total_cents     > 0),

  card_monthly_subtotal_cents bigint not null check (card_monthly_subtotal_cents > 0),
  card_monthly_tax_cents      bigint not null default 0 check (card_monthly_tax_cents >= 0),
  card_monthly_total_cents    bigint not null check (card_monthly_total_cents    > 0),

  tax_rate_milli_pct          integer not null default 0 check (tax_rate_milli_pct >= 0),
  tax_exempt                  boolean not null default false,
  tax_jurisdiction            text,
  exempt_cert_number          text,

  currency                    text not null default 'USD' check (currency = 'USD'),

  sent_at                     timestamptz,
  expires_at                  timestamptz,
  accepted_at                 timestamptz,
  declined_at                 timestamptz,
  declined_reason             text,

  created_by                  uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint ck_offer_ach_reconciles
    check (ach_monthly_subtotal_cents  + ach_monthly_tax_cents  = ach_monthly_total_cents),
  constraint ck_offer_card_reconciles
    check (card_monthly_subtotal_cents + card_monthly_tax_cents = card_monthly_total_cents),
  constraint ck_offer_exempt_zero_tax
    check (not tax_exempt or (ach_monthly_tax_cents = 0 and card_monthly_tax_cents = 0))
);

-- R2.1 — an offer may only reference equipment belonging to the SAME customer.
-- Two independently-valid single-column FKs allow
--     offer.customer_id = A, offer.equipment_id = B's forklift.
-- The composite FK makes that combination unrepresentable.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_offer_equipment_same_customer') then
    alter table service_plan_offers add constraint fk_offer_equipment_same_customer
      foreign key (equipment_id, customer_id)
      references customer_equipment (id, customer_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'uq_offer_chain') then
    alter table service_plan_offers add constraint uq_offer_chain
      unique (id, customer_id, equipment_id);
  end if;
end $$;

create index if not exists ix_offer_customer  on service_plan_offers(customer_id);
create index if not exists ix_offer_equipment on service_plan_offers(equipment_id);
create index if not exists ix_offer_status    on service_plan_offers(status);

-- At most ONE outstanding offer per unit. 'accepted' is deliberately excluded,
-- or a cancelled plan would permanently block re-offering that forklift.
create unique index if not exists uq_offer_one_outstanding_per_equipment
  on service_plan_offers (equipment_id) where status = 'sent';

comment on table service_plan_offers is
  'One versioned monthly service-plan recommendation for one equipment unit. Terms freeze once sent.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SERVICE PLAN AGREEMENTS — immutable signed contract
--
-- LEGAL REVIEW REQUIRED: the agreement body text rendered into `snapshot` is a
-- neutral business draft. Cancellation rights, failed-payment consequences,
-- ACH-vs-card price differential wording, and electronic-signature
-- enforceability have NOT been reviewed by counsel.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists service_plan_agreements (
  id                      uuid primary key default gen_random_uuid(),
  offer_id                uuid not null unique references service_plan_offers(id) on delete restrict,
  customer_id             uuid not null references customers(id)                  on delete restrict,
  equipment_id            uuid not null references customer_equipment(id)         on delete restrict,

  agreement_version       text not null,

  selected_payment_method text not null check (selected_payment_method in ('card','ach')),
  monthly_subtotal_cents  bigint not null check (monthly_subtotal_cents > 0),
  monthly_tax_cents       bigint not null default 0 check (monthly_tax_cents >= 0),
  monthly_total_cents     bigint not null check (monthly_total_cents    > 0),
  currency                text not null default 'USD' check (currency = 'USD'),

  term_months             integer not null check (term_months between 1 and 120),
  activation_date         date not null,

  snapshot                jsonb not null,

  signer_name             text not null,
  signer_title            text,
  signature_typed         text not null,
  consent_service_scope   boolean not null default false,
  consent_recurring_auth  boolean not null default false,
  consent_electronic_sig  boolean not null default false,
  consent_term_cancel     boolean not null default false,
  signed_at               timestamptz not null default now(),
  signer_ip_hash          text,
  signer_user_agent       text,

  pdf_path                text,
  pdf_generated_at        timestamptz,
  document_sha256         text,
  snapshot_sha256         text,

  status                  text not null default 'signed'
                          check (status in ('signed','superseded','cancelled')),
  superseded_by           uuid references service_plan_agreements(id),

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint ck_agreement_reconciles
    check (monthly_subtotal_cents + monthly_tax_cents = monthly_total_cents),
  constraint ck_agreement_all_consents
    check (consent_service_scope and consent_recurring_auth
       and consent_electronic_sig and consent_term_cancel),
  constraint ck_agreement_signature_present
    check (length(btrim(signer_name)) > 0
       and length(btrim(signature_typed)) > 0
       and length(btrim(agreement_version)) > 0),
  constraint ck_agreement_snapshot_is_object
    check (jsonb_typeof(snapshot) = 'object' and snapshot <> '{}'::jsonb)
);

-- R2.1 — the agreement's customer and equipment must be the offer's customer
-- and equipment. Not "a valid customer" and "a valid forklift" — THE ones on
-- the offer being signed.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_agreement_matches_offer_chain') then
    alter table service_plan_agreements add constraint fk_agreement_matches_offer_chain
      foreign key (offer_id, customer_id, equipment_id)
      references service_plan_offers (id, customer_id, equipment_id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'uq_agreement_chain') then
    alter table service_plan_agreements add constraint uq_agreement_chain
      unique (id, offer_id, customer_id, equipment_id);
  end if;
end $$;

create index if not exists ix_agreement_customer  on service_plan_agreements(customer_id);
create index if not exists ix_agreement_equipment on service_plan_agreements(equipment_id);
create index if not exists ix_agreement_status    on service_plan_agreements(status);

comment on column service_plan_agreements.snapshot is
  'Immutable frozen contract: all business terms, both rail prices, selected rail, equipment, signer, and full agreement text.';
comment on column service_plan_agreements.signer_ip_hash is
  'Salted hash only. Raw signer IP is never stored.';
comment on column service_plan_agreements.pdf_path is
  'Object path inside the PRIVATE apex-agreements bucket. Customers receive short-lived signed URLs, never a permanent link.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. SERVICE SUBSCRIPTIONS — Apex's mirror of the Helcim subscription
--
-- PROVIDER HONESTY (R2.9). ck_sub_active_needs_provider_id below prevents Apex
-- ASSERTING an active subscription without an identifier. It does not, and
-- cannot, prove a Helcim subscription with that identifier exists. Only a
-- server-to-server GET against Helcim can do that.
--
--   subscription-activate  MUST read the authoritative Helcim response and
--                          store the returned identity before setting status,
--                          stamping provider_verified_at.
--   subscription-reconcile MUST re-verify on every sync that the subscription
--                          still exists and still matches, refresh
--                          provider_verified_at, and raise an event if the
--                          provider disagrees.
--
-- The constraint is a floor, not a proof.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists service_subscriptions (
  id                          uuid primary key default gen_random_uuid(),
  agreement_id                uuid not null unique references service_plan_agreements(id) on delete restrict,
  offer_id                    uuid not null references service_plan_offers(id)            on delete restrict,
  customer_id                 uuid not null references customers(id)                      on delete restrict,
  equipment_id                uuid not null references customer_equipment(id)             on delete restrict,

  provider                    text not null default 'helcim' check (provider in ('helcim')),
  provider_customer_code      text,
  provider_payment_plan_id    bigint,
  provider_subscription_id    bigint,
  provider_verified_at        timestamptz,

  payment_method              text not null check (payment_method in ('card','ach')),
  payment_method_verified_at  timestamptz,
  payment_method_display      text,

  recurring_subtotal_cents    bigint not null check (recurring_subtotal_cents > 0),
  recurring_tax_cents         bigint not null default 0 check (recurring_tax_cents >= 0),
  recurring_total_cents       bigint not null check (recurring_total_cents    > 0),
  currency                    text not null default 'USD' check (currency = 'USD'),

  activation_date             date not null,
  next_billing_date           date,
  term_months                 integer not null check (term_months between 1 and 120),
  max_cycles                  integer check (max_cycles >= 1),
  times_billed                integer not null default 0 check (times_billed >= 0),

  reminder_enabled            boolean not null default true,

  status                      text not null default 'setup_pending'
                              check (status in ('setup_pending','method_verified','active','past_due',
                                                'paused','cancel_requested','cancelled','completed','failed_setup')),
  has_failed_payments         boolean not null default false,

  -- Persisted BEFORE the provider call so an ambiguous network timeout can be
  -- reconciled instead of retried into a duplicate subscription.
  activation_idempotency_key  text check (activation_idempotency_key ~ '^[A-Za-z0-9]{25}$'),
  activation_attempted_at     timestamptz,
  activated_at                timestamptz,
  activation_error_category   text,

  cancel_requested_at         timestamptz,
  cancel_requested_by         uuid,
  cancel_reason               text,
  cancelled_at                timestamptz,
  cancelled_by                uuid,
  provider_cancel_confirmed   boolean not null default false,

  last_synced_at              timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint ck_sub_reconciles
    check (recurring_subtotal_cents + recurring_tax_cents = recurring_total_cents),
  constraint ck_sub_active_needs_provider_id
    check (status not in ('active','past_due','completed') or provider_subscription_id is not null)
);

-- R2.1 — the subscription must sit on the exact signed agreement chain.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fk_sub_matches_agreement_chain') then
    alter table service_subscriptions add constraint fk_sub_matches_agreement_chain
      foreign key (agreement_id, offer_id, customer_id, equipment_id)
      references service_plan_agreements (id, offer_id, customer_id, equipment_id) on delete restrict;
  end if;
end $$;

create index if not exists ix_sub_customer  on service_subscriptions(customer_id);
create index if not exists ix_sub_equipment on service_subscriptions(equipment_id);
create index if not exists ix_sub_status    on service_subscriptions(status);
create index if not exists ix_sub_next_bill on service_subscriptions(next_billing_date)
  where status in ('active','past_due');

create unique index if not exists uq_sub_provider_id
  on service_subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

create unique index if not exists uq_sub_one_live_per_equipment
  on service_subscriptions (equipment_id)
  where status in ('setup_pending','method_verified','active','past_due','paused','cancel_requested');

create unique index if not exists uq_sub_activation_idem
  on service_subscriptions (activation_idempotency_key)
  where activation_idempotency_key is not null;

comment on column service_subscriptions.provider_subscription_id is
  'Helcim subscription id, written ONLY from an authoritative provider response. A non-null value is not by itself proof the subscription exists — see provider_verified_at.';
comment on column service_subscriptions.provider_verified_at is
  'Last time a server-to-server Helcim GET confirmed this subscription exists and matches. Set by subscription-activate, refreshed by subscription-reconcile.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. SERVICE PLAN EVENTS — append-only recurring lifecycle audit trail
--
-- NEVER write API tokens, secret tokens, raw card/bank data, or full provider
-- responses into `detail`.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists service_plan_events (
  id              bigserial primary key,
  event           text not null,
  source          text not null check (source in ('admin','customer','edge','reconcile','worker','system')),
  customer_id     uuid,
  equipment_id    uuid,
  offer_id        uuid,
  agreement_id    uuid,
  subscription_id uuid,
  detail          jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists ix_spe_subscription on service_plan_events(subscription_id);
create index if not exists ix_spe_agreement    on service_plan_events(agreement_id);
create index if not exists ix_spe_created      on service_plan_events(created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. EXISTING TABLE: customers — Helcim customer mapping
-- ─────────────────────────────────────────────────────────────────────────────
alter table customers
  add column if not exists helcim_customer_code text;

create unique index if not exists uq_customer_helcim_code
  on customers (helcim_customer_code) where helcim_customer_code is not null;

comment on column customers.helcim_customer_code is
  'Helcim customerCode (e.g. CST1044). Set only after a server-verified Helcim response. Never set from a browser.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. EXISTING TABLE: payments — recurring axis
--
-- `provider` is NOT overloaded. It still means the processor.
--   one-time  : provider='helcim', payment_source='one_time'
--   recurring : provider='helcim', payment_source='recurring', subscription_id=...
--
-- Every existing row becomes 'one_time' by the column default. No existing row
-- is UPDATEd by this script.
-- ─────────────────────────────────────────────────────────────────────────────
alter table payments
  add column if not exists payment_source        text   not null default 'one_time',
  add column if not exists subscription_id       uuid   references service_subscriptions(id),
  add column if not exists billing_period_start  date,
  add column if not exists billing_period_end    date,
  -- Helcim subscription payment sub-object: { "id": 90116, "paymentNumber": 1 }
  add column if not exists provider_subscription_payment_id bigint,
  add column if not exists provider_payment_number          integer;

-- R2.8 — discriminator integrity, both directions. These constraint names
-- belong to this migration only, so dropping them to redefine is not
-- destructive to the pre-existing schema.
do $$
begin
  alter table payments drop constraint if exists ck_pay_source;
  alter table payments add  constraint ck_pay_source
    check (payment_source in ('one_time','recurring'));

  alter table payments drop constraint if exists ck_pay_recurring_needs_sub;
  alter table payments add  constraint ck_pay_recurring_needs_sub
    check (payment_source = 'one_time' or subscription_id is not null);

  -- A recurring CHARGE is a billing cycle and must name its period.
  -- A recurring CORRECTION (refund/reversal) belongs to the subscription but
  -- may not correspond to a whole cycle. It identifies its target through
  -- refund_of instead, and must NOT carry a cycle id, or a second partial
  -- refund would collide with the cycle-uniqueness index below.
  alter table payments drop constraint if exists ck_pay_recurring_cycle_shape;
  alter table payments add  constraint ck_pay_recurring_cycle_shape
    check (
      payment_source = 'one_time'
      or (kind = 'payment'
          and billing_period_start is not null and billing_period_end is not null)
      or (kind in ('refund','reversal')
          and refund_of is not null
          and provider_subscription_payment_id is null)
    );

  -- A one-time row may not carry ANY recurring metadata.
  alter table payments drop constraint if exists ck_pay_onetime_is_clean;
  alter table payments add  constraint ck_pay_onetime_is_clean
    check (payment_source = 'recurring'
        or (subscription_id is null
        and billing_period_start is null and billing_period_end is null
        and provider_subscription_payment_id is null
        and provider_payment_number is null));

  alter table payments drop constraint if exists ck_pay_period_order;
  alter table payments add  constraint ck_pay_period_order
    check (billing_period_start is null or billing_period_end is null
           or billing_period_end >= billing_period_start);
end $$;

-- One Apex ledger row per Helcim billing cycle. This is what makes the
-- reconcile worker safe to replay. Restricted to kind='payment' so a partial
-- refund of a cycle is never blocked by the charge's own key.
drop index if exists uq_pay_recurring_cycle;
create unique index uq_pay_recurring_cycle
  on payments (subscription_id, provider_subscription_payment_id)
  where kind = 'payment' and subscription_id is not null
    and provider_subscription_payment_id is not null;

drop index if exists uq_pay_recurring_number;
create unique index uq_pay_recurring_number
  on payments (subscription_id, provider_payment_number)
  where kind = 'payment' and subscription_id is not null
    and provider_payment_number is not null;

create index if not exists ix_pay_subscription on payments(subscription_id)
  where subscription_id is not null;

comment on column payments.payment_source is
  'Workflow axis: one_time | recurring. Independent of provider, which is the processor.';
comment on column payments.provider_subscription_payment_id is
  'Helcim subscription payments[].id — stable identity of one billing cycle, not a card/ACH transaction id. Null on correction rows.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. EXISTING TABLE: invoices — recurring cycle invoices
--
-- Reuses the existing status vocabulary so the invoices.status CHECK does not
-- have to be touched and recalc_invoice_status() keeps working unchanged.
-- Past-due is a SUBSCRIPTION state, not an invoice state.
-- ─────────────────────────────────────────────────────────────────────────────
alter table invoices
  add column if not exists invoice_source       text not null default 'one_time',
  add column if not exists subscription_id      uuid references service_subscriptions(id),
  add column if not exists billing_period_start date,
  add column if not exists billing_period_end   date;

do $$
begin
  alter table invoices drop constraint if exists ck_inv_source;
  alter table invoices add  constraint ck_inv_source
    check (invoice_source in ('one_time','recurring'));

  -- R2.8 — a recurring invoice IS a billing cycle: subscription + period, both.
  alter table invoices drop constraint if exists ck_inv_recurring_needs_sub;
  alter table invoices add  constraint ck_inv_recurring_needs_sub
    check (invoice_source = 'one_time'
       or (subscription_id is not null
           and billing_period_start is not null and billing_period_end is not null));

  alter table invoices drop constraint if exists ck_inv_onetime_is_clean;
  alter table invoices add  constraint ck_inv_onetime_is_clean
    check (invoice_source = 'recurring'
       or (subscription_id is null
           and billing_period_start is null and billing_period_end is null));

  alter table invoices drop constraint if exists ck_inv_period_order;
  alter table invoices add  constraint ck_inv_period_order
    check (billing_period_start is null or billing_period_end is null
           or billing_period_end >= billing_period_start);
end $$;

create unique index if not exists uq_inv_recurring_period
  on invoices (subscription_id, billing_period_start)
  where subscription_id is not null and billing_period_start is not null;

create index if not exists ix_inv_subscription on invoices(subscription_id)
  where subscription_id is not null;

comment on column invoices.invoice_source is
  'one_time | recurring. payment-checkout must refuse a recurring invoice — see patches/PAYMENT_CHECKOUT_RECURRING_GUARD.md.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. INSERT VALIDATION — the contract chain is verified in the database
--
-- R2.2 / R2.3. These run for service_role too. An Edge Function bug cannot sign
-- a contract for an amount the customer was never offered.
-- ─────────────────────────────────────────────────────────────────────────────

-- 10a. An agreement must be a faithful acceptance of a live, sent offer.
create or replace function public.validate_agreement_against_offer() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  o         service_plan_offers;
  exp_sub   bigint;
  exp_tax   bigint;
  exp_total bigint;
begin
  -- FOR UPDATE also serializes two tabs racing to sign the same offer.
  select * into o from service_plan_offers where id = new.offer_id for update;
  if not found then
    raise exception 'offer % does not exist', new.offer_id;
  end if;

  if o.status <> 'sent' then
    raise exception
      'offer % is % — only a sent offer can be signed (accept and sign in one transaction)',
      o.id, o.status;
  end if;

  if o.expires_at is not null and o.expires_at <= now() then
    raise exception 'offer % expired at % and cannot be signed', o.id, o.expires_at;
  end if;

  if o.customer_id is distinct from new.customer_id then
    raise exception 'agreement customer % does not match offer customer %',
      new.customer_id, o.customer_id;
  end if;
  if o.equipment_id is distinct from new.equipment_id then
    raise exception 'agreement equipment % does not match offer equipment %',
      new.equipment_id, o.equipment_id;
  end if;

  if new.selected_payment_method = 'ach' then
    exp_sub := o.ach_monthly_subtotal_cents;
    exp_tax := o.ach_monthly_tax_cents;
    exp_total := o.ach_monthly_total_cents;
  elsif new.selected_payment_method = 'card' then
    exp_sub := o.card_monthly_subtotal_cents;
    exp_tax := o.card_monthly_tax_cents;
    exp_total := o.card_monthly_total_cents;
  else
    raise exception 'selected_payment_method % is not card or ach', new.selected_payment_method;
  end if;

  -- The authorized amount is the OFFER's amount for the chosen rail. Nothing a
  -- browser sends can change it; a mismatch is refused, never silently fixed.
  if new.monthly_subtotal_cents <> exp_sub
  or new.monthly_tax_cents      <> exp_tax
  or new.monthly_total_cents    <> exp_total then
    raise exception
      'agreement amount (%/%/%) does not match the offer % price (%/%/%)',
      new.monthly_subtotal_cents, new.monthly_tax_cents, new.monthly_total_cents,
      new.selected_payment_method, exp_sub, exp_tax, exp_total;
  end if;

  if new.currency is distinct from o.currency then
    raise exception 'agreement currency % does not match offer currency %', new.currency, o.currency;
  end if;
  if new.term_months is distinct from o.term_months then
    raise exception 'agreement term % does not match offer term %', new.term_months, o.term_months;
  end if;
  if o.activation_date is null then
    raise exception 'offer % has no activation date and cannot be signed', o.id;
  end if;
  if new.activation_date is distinct from o.activation_date then
    raise exception 'agreement activation date % does not match offer date %',
      new.activation_date, o.activation_date;
  end if;

  if not (new.consent_service_scope and new.consent_recurring_auth
          and new.consent_electronic_sig and new.consent_term_cancel) then
    raise exception 'all four consents are required to sign agreement for offer %', o.id;
  end if;

  return new;
end $$;
revoke all on function public.validate_agreement_against_offer() from public, anon, authenticated;

drop trigger if exists trg_validate_agreement on service_plan_agreements;
create trigger trg_validate_agreement before insert on service_plan_agreements
  for each row execute function public.validate_agreement_against_offer();

-- 10b. A subscription must be a faithful copy of a signed agreement.
create or replace function public.validate_subscription_against_agreement() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare a service_plan_agreements;
begin
  select * into a from service_plan_agreements where id = new.agreement_id for update;
  if not found then
    raise exception 'agreement % does not exist', new.agreement_id;
  end if;

  if a.status <> 'signed' then
    raise exception 'agreement % is % — only a signed agreement can carry a subscription',
      a.id, a.status;
  end if;

  if new.offer_id     is distinct from a.offer_id     then raise exception 'subscription offer does not match agreement offer'; end if;
  if new.customer_id  is distinct from a.customer_id  then raise exception 'subscription customer does not match agreement customer'; end if;
  if new.equipment_id is distinct from a.equipment_id then raise exception 'subscription equipment does not match agreement equipment'; end if;

  if new.payment_method is distinct from a.selected_payment_method then
    raise exception 'subscription rail % does not match the signed rail %',
      new.payment_method, a.selected_payment_method;
  end if;

  if new.recurring_subtotal_cents <> a.monthly_subtotal_cents
  or new.recurring_tax_cents      <> a.monthly_tax_cents
  or new.recurring_total_cents    <> a.monthly_total_cents then
    raise exception
      'subscription amount (%/%/%) does not match signed agreement % (%/%/%)',
      new.recurring_subtotal_cents, new.recurring_tax_cents, new.recurring_total_cents,
      a.id, a.monthly_subtotal_cents, a.monthly_tax_cents, a.monthly_total_cents;
  end if;

  if new.currency        is distinct from a.currency        then raise exception 'subscription currency does not match agreement'; end if;
  if new.term_months     is distinct from a.term_months     then raise exception 'subscription term does not match agreement'; end if;
  if new.activation_date is distinct from a.activation_date then raise exception 'subscription activation date does not match agreement'; end if;

  -- Monthly billing: one cycle per month of term.
  if new.max_cycles is null then
    new.max_cycles := a.term_months;
  elsif new.max_cycles <> a.term_months then
    raise exception 'max_cycles % must equal the signed term of % months', new.max_cycles, a.term_months;
  end if;

  -- Provider identity is earned by an authoritative Helcim response during
  -- activation. It cannot be supplied at creation time.
  if new.provider_subscription_id is not null then
    raise exception 'provider_subscription_id may not be set at creation — subscription-activate writes it';
  end if;
  if new.status not in ('setup_pending','failed_setup') then
    raise exception 'a new subscription must start setup_pending, not %', new.status;
  end if;

  return new;
end $$;
revoke all on function public.validate_subscription_against_agreement() from public, anon, authenticated;

drop trigger if exists trg_validate_subscription on service_subscriptions;
create trigger trg_validate_subscription before insert on service_subscriptions
  for each row execute function public.validate_subscription_against_agreement();

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. IMMUTABILITY + LIFECYCLE TRANSITION GUARDS  (R2.4)
-- ─────────────────────────────────────────────────────────────────────────────

-- 11a. Offer: draft -> sent|cancelled ; sent -> accepted|declined|expired|cancelled.
--      accepted / declined / expired / cancelled are TERMINAL. Revisions create
--      a new offer row.
create or replace function public.guard_service_plan_offer() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform assert_transition('offer', old.id::text, old.status, new.status,
    case old.status
      when 'draft' then array['sent','cancelled']
      when 'sent'  then array['accepted','declined','expired','cancelled']
      else array[]::text[]                       -- terminal
    end);

  if old.status <> 'draft' then
    if new.plan_name                   is distinct from old.plan_name
    or new.description                 is distinct from old.description
    or new.included_services           is distinct from old.included_services
    or new.exclusions                  is distinct from old.exclusions
    or new.term_months                 is distinct from old.term_months
    or new.activation_date             is distinct from old.activation_date
    or new.ach_monthly_subtotal_cents  is distinct from old.ach_monthly_subtotal_cents
    or new.ach_monthly_tax_cents       is distinct from old.ach_monthly_tax_cents
    or new.ach_monthly_total_cents     is distinct from old.ach_monthly_total_cents
    or new.card_monthly_subtotal_cents is distinct from old.card_monthly_subtotal_cents
    or new.card_monthly_tax_cents      is distinct from old.card_monthly_tax_cents
    or new.card_monthly_total_cents    is distinct from old.card_monthly_total_cents
    or new.tax_rate_milli_pct          is distinct from old.tax_rate_milli_pct
    or new.tax_exempt                  is distinct from old.tax_exempt
    or new.currency                    is distinct from old.currency
    or new.customer_id                 is distinct from old.customer_id
    or new.equipment_id                is distinct from old.equipment_id then
      raise exception
        'offer % has been sent to the customer and its terms are frozen — issue a new offer version instead',
        old.id;
    end if;
  end if;

  return new;
end $$;
revoke all on function public.guard_service_plan_offer() from public, anon, authenticated;

drop trigger if exists trg_guard_offer on service_plan_offers;
create trigger trg_guard_offer before update on service_plan_offers
  for each row execute function public.guard_service_plan_offer();

-- 11b. Agreement: signed -> superseded|cancelled. Both TERMINAL.
create or replace function public.guard_service_plan_agreement() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform assert_transition('agreement', old.id::text, old.status, new.status,
    case old.status
      when 'signed' then array['superseded','cancelled']
      else array[]::text[]                       -- terminal
    end);

  if new.offer_id                is distinct from old.offer_id
  or new.customer_id             is distinct from old.customer_id
  or new.equipment_id            is distinct from old.equipment_id
  or new.agreement_version       is distinct from old.agreement_version
  or new.selected_payment_method is distinct from old.selected_payment_method
  or new.monthly_subtotal_cents  is distinct from old.monthly_subtotal_cents
  or new.monthly_tax_cents       is distinct from old.monthly_tax_cents
  or new.monthly_total_cents     is distinct from old.monthly_total_cents
  or new.currency                is distinct from old.currency
  or new.term_months             is distinct from old.term_months
  or new.activation_date         is distinct from old.activation_date
  or new.snapshot                is distinct from old.snapshot
  or new.signer_name             is distinct from old.signer_name
  or new.signer_title            is distinct from old.signer_title
  or new.signature_typed         is distinct from old.signature_typed
  or new.signed_at               is distinct from old.signed_at
  or new.consent_service_scope   is distinct from old.consent_service_scope
  or new.consent_recurring_auth  is distinct from old.consent_recurring_auth
  or new.consent_electronic_sig  is distinct from old.consent_electronic_sig
  or new.consent_term_cancel     is distinct from old.consent_term_cancel then
    raise exception
      'agreement % is immutable — create an amendment / superseding agreement instead', old.id;
  end if;

  -- PDF artefacts are write-once.
  if old.pdf_path        is not null and new.pdf_path        is distinct from old.pdf_path then
    raise exception 'agreement % already has a stored PDF', old.id;
  end if;
  if old.document_sha256 is not null and new.document_sha256 is distinct from old.document_sha256 then
    raise exception 'agreement % already has a document hash', old.id;
  end if;
  if old.snapshot_sha256 is not null and new.snapshot_sha256 is distinct from old.snapshot_sha256 then
    raise exception 'agreement % already has a snapshot hash', old.id;
  end if;

  return new;
end $$;
revoke all on function public.guard_service_plan_agreement() from public, anon, authenticated;

drop trigger if exists trg_guard_agreement on service_plan_agreements;
create trigger trg_guard_agreement before update on service_plan_agreements
  for each row execute function public.guard_service_plan_agreement();

-- 11c. Subscription. cancelled / completed are TERMINAL. Helcim cannot resume a
--      cancelled subscription, so neither can we: a returning customer gets a
--      new offer, a new agreement and a new subscription.
create or replace function public.guard_service_subscription() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform assert_transition('subscription', old.id::text, old.status, new.status,
    case old.status
      when 'setup_pending'    then array['method_verified','failed_setup','cancelled']
      when 'method_verified'  then array['active','failed_setup','cancelled']
      when 'failed_setup'     then array['setup_pending','method_verified','cancelled']
      when 'active'           then array['past_due','paused','cancel_requested','completed','cancelled']
      when 'past_due'         then array['active','paused','cancel_requested','completed','cancelled']
      when 'paused'           then array['active','cancel_requested','cancelled']
      when 'cancel_requested' then array['cancelled','active','past_due']  -- admin may decline the request
      else array[]::text[]                       -- cancelled / completed are terminal
    end);

  if new.agreement_id             is distinct from old.agreement_id
  or new.offer_id                 is distinct from old.offer_id
  or new.customer_id              is distinct from old.customer_id
  or new.equipment_id             is distinct from old.equipment_id
  or new.recurring_subtotal_cents is distinct from old.recurring_subtotal_cents
  or new.recurring_tax_cents      is distinct from old.recurring_tax_cents
  or new.recurring_total_cents    is distinct from old.recurring_total_cents
  or new.currency                 is distinct from old.currency
  or new.payment_method           is distinct from old.payment_method
  or new.term_months              is distinct from old.term_months
  or new.max_cycles               is distinct from old.max_cycles
  or new.activation_date          is distinct from old.activation_date then
    raise exception
      'subscription % carries a signed authorization — amend via a new agreement, do not edit it', old.id;
  end if;

  if old.provider_subscription_id is not null
     and new.provider_subscription_id is distinct from old.provider_subscription_id then
    raise exception 'subscription % is already bound to Helcim subscription %',
      old.id, old.provider_subscription_id;
  end if;

  if new.times_billed < old.times_billed then
    raise exception 'times_billed cannot decrease';
  end if;

  return new;
end $$;
revoke all on function public.guard_service_subscription() from public, anon, authenticated;

drop trigger if exists trg_guard_subscription on service_subscriptions;
create trigger trg_guard_subscription before update on service_subscriptions
  for each row execute function public.guard_service_subscription();

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. DURABILITY — what may never be deleted  (R2.5 / R2.6)
--
-- Triggers fire for the service role and the table owner, so this stops a
-- future Edge Function bug, not just a hostile browser. (A superuser can still
-- bypass with session_replication_role='replica'. That is a deliberate,
-- auditable act, which is the point.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.forbid_agreement_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception
    'agreement % is a signed record and cannot be deleted — supersede or cancel it instead', old.id;
end $$;
revoke all on function public.forbid_agreement_delete() from public, anon, authenticated;

drop trigger if exists trg_no_delete_agreement on service_plan_agreements;
create trigger trg_no_delete_agreement before delete on service_plan_agreements
  for each row execute function public.forbid_agreement_delete();

create or replace function public.forbid_event_mutation() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'service_plan_events is append-only (attempted %)', tg_op;
end $$;
revoke all on function public.forbid_event_mutation() from public, anon, authenticated;

drop trigger if exists trg_events_append_only on service_plan_events;
create trigger trg_events_append_only before update or delete on service_plan_events
  for each row execute function public.forbid_event_mutation();

-- A subscription bound to Helcim, or that has billed, is financial history.
-- Cancel it; do not erase it.
create or replace function public.forbid_billed_subscription_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.provider_subscription_id is not null or old.times_billed > 0 then
    raise exception
      'subscription % has provider/billing history and cannot be deleted — cancel it instead', old.id;
  end if;
  return old;
end $$;
revoke all on function public.forbid_billed_subscription_delete() from public, anon, authenticated;

drop trigger if exists trg_no_delete_billed_sub on service_subscriptions;
create trigger trg_no_delete_billed_sub before delete on service_subscriptions
  for each row execute function public.forbid_billed_subscription_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. HOUSEKEEPING TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────
drop trigger if exists trg_touch_equipment    on customer_equipment;
drop trigger if exists trg_touch_offer        on service_plan_offers;
drop trigger if exists trg_touch_agreement    on service_plan_agreements;
drop trigger if exists trg_touch_subscription on service_subscriptions;
create trigger trg_touch_equipment    before update on customer_equipment      for each row execute function public.touch_updated_at();
create trigger trg_touch_offer        before update on service_plan_offers     for each row execute function public.touch_updated_at();
create trigger trg_touch_agreement    before update on service_plan_agreements for each row execute function public.touch_updated_at();
create trigger trg_touch_subscription before update on service_subscriptions   for each row execute function public.touch_updated_at();

-- Audit trail, using the EXISTING write_audit() function unchanged.
drop trigger if exists trg_audit_equipment    on customer_equipment;
drop trigger if exists trg_audit_offer        on service_plan_offers;
drop trigger if exists trg_audit_agreement    on service_plan_agreements;
drop trigger if exists trg_audit_subscription on service_subscriptions;
create trigger trg_audit_equipment    after insert or update or delete on customer_equipment      for each row execute function write_audit();
create trigger trg_audit_offer        after insert or update or delete on service_plan_offers     for each row execute function write_audit();
create trigger trg_audit_agreement    after insert or update or delete on service_plan_agreements for each row execute function write_audit();
create trigger trg_audit_subscription after insert or update or delete on service_subscriptions   for each row execute function write_audit();

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. ROW LEVEL SECURITY
--   admin    -> full access via is_admin()
--   customer -> SELECT own rows only
--   nobody writes through PostgREST.
-- ─────────────────────────────────────────────────────────────────────────────
alter table customer_equipment      enable row level security;
alter table service_plan_offers     enable row level security;
alter table service_plan_agreements enable row level security;
alter table service_subscriptions   enable row level security;
alter table service_plan_events     enable row level security;

drop policy if exists "equip_admin_all" on customer_equipment;
drop policy if exists "equip_read_own"  on customer_equipment;
create policy "equip_admin_all" on customer_equipment for all    using (is_admin()) with check (is_admin());
create policy "equip_read_own"  on customer_equipment for select using (auth.uid() = customer_id);

drop policy if exists "offer_admin_all" on service_plan_offers;
drop policy if exists "offer_read_own"  on service_plan_offers;
create policy "offer_admin_all" on service_plan_offers for all    using (is_admin()) with check (is_admin());
-- A draft is an internal working document.
create policy "offer_read_own"  on service_plan_offers for select
  using (auth.uid() = customer_id and status <> 'draft');

drop policy if exists "agree_admin_all" on service_plan_agreements;
drop policy if exists "agree_read_own"  on service_plan_agreements;
create policy "agree_admin_all" on service_plan_agreements for all    using (is_admin()) with check (is_admin());
create policy "agree_read_own"  on service_plan_agreements for select using (auth.uid() = customer_id);

drop policy if exists "sub_admin_all"   on service_subscriptions;
drop policy if exists "sub_read_own"    on service_subscriptions;
create policy "sub_admin_all"   on service_subscriptions for all    using (is_admin()) with check (is_admin());
create policy "sub_read_own"    on service_subscriptions for select using (auth.uid() = customer_id);

drop policy if exists "spe_admin_read"  on service_plan_events;
create policy "spe_admin_read"  on service_plan_events for select using (is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. TABLE PRIVILEGES — stricter than the policies alone
--
-- Admin manages these tables through admin-only server paths, not by writing
-- the table directly.
-- ─────────────────────────────────────────────────────────────────────────────
revoke insert, update, delete, truncate on
  customer_equipment, service_plan_offers, service_plan_agreements,
  service_subscriptions, service_plan_events
  from anon, authenticated;

revoke all on customer_equipment, service_plan_offers, service_plan_agreements,
              service_subscriptions, service_plan_events
  from anon;

grant select on customer_equipment, service_plan_offers, service_plan_agreements,
                service_subscriptions
  to authenticated;
grant select on service_plan_events to authenticated;   -- RLS still admin-only

grant all on customer_equipment, service_plan_offers, service_plan_agreements,
             service_subscriptions, service_plan_events
  to service_role;
grant usage, select on sequence service_plan_events_id_seq to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. PRIVATE: recurring payment-method VERIFY sessions  (R2.7)
--
-- Mirrors private.helcim_checkout_session, plus a lifecycle:
--   * bound to ONE agreement, ONE customer, ONE rail
--   * expires with the Helcim checkout token (60 minutes)
--   * single-use — consumed on successful validation
--   * a conflicting token binding RAISES rather than silently doing nothing
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists private.helcim_verify_session (
  checkout_token text primary key,
  secret_token   text not null,
  agreement_id   uuid not null,
  customer_id    uuid not null,
  payment_rail   text not null check (payment_rail in ('card','ach')),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null default now() + interval '60 minutes',
  consumed_at    timestamptz
);

-- Upgrade path if an earlier draft of this migration created the table without
-- a lifecycle. No-ops on a fresh install.
alter table private.helcim_verify_session
  add column if not exists expires_at  timestamptz,
  add column if not exists consumed_at timestamptz;
update private.helcim_verify_session
   set expires_at = created_at + interval '60 minutes'
 where expires_at is null;

create index if not exists ix_verify_session_expiry
  on private.helcim_verify_session (expires_at) where consumed_at is null;

create or replace function public.create_verify_session(
  p_checkout_token text, p_secret_token text,
  p_agreement_id uuid, p_customer_id uuid, p_payment_rail text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare existing private.helcim_verify_session;
begin
  select * into existing from private.helcim_verify_session
   where checkout_token = p_checkout_token;

  if found then
    -- Never silently rebind a live token to a different agreement/customer/rail.
    if existing.agreement_id is distinct from p_agreement_id
    or existing.customer_id  is distinct from p_customer_id
    or existing.payment_rail is distinct from p_payment_rail then
      raise exception 'checkout token is already bound to a different verify session';
    end if;
    return;   -- identical replay: no-op
  end if;

  insert into private.helcim_verify_session
    (checkout_token, secret_token, agreement_id, customer_id, payment_rail, expires_at)
  values (p_checkout_token, p_secret_token, p_agreement_id, p_customer_id, p_payment_rail,
          now() + make_interval(mins =>
            greatest(1, coalesce(nullif(cfg('service_plan_verify_session_minutes'),'')::int, 60))));
end $$;

-- Read-only peek. Returns nothing once expired or consumed.
create or replace function public.read_verify_session(p_checkout_token text)
returns table (secret_token text, agreement_id uuid, customer_id uuid, payment_rail text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    select s.secret_token, s.agreement_id, s.customer_id, s.payment_rail
      from private.helcim_verify_session s
     where s.checkout_token = p_checkout_token
       and s.consumed_at is null
       and s.expires_at > now();
end $$;

-- Single-use claim. The secret can be read exactly once; a replayed validation
-- gets nothing back and must be treated as a failure by the caller.
create or replace function public.consume_verify_session(p_checkout_token text)
returns table (secret_token text, agreement_id uuid, customer_id uuid, payment_rail text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    update private.helcim_verify_session s
       set consumed_at = now()
     where s.checkout_token = p_checkout_token
       and s.consumed_at is null
       and s.expires_at > now()
    returning s.secret_token, s.agreement_id, s.customer_id, s.payment_rail;
end $$;

create or replace function public.purge_expired_verify_sessions()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from private.helcim_verify_session
   where expires_at < now() - interval '24 hours';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.create_verify_session(text,text,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.read_verify_session(text)                       from public, anon, authenticated;
revoke all on function public.consume_verify_session(text)                    from public, anon, authenticated;
revoke all on function public.purge_expired_verify_sessions()                 from public, anon, authenticated;
grant  execute on function public.create_verify_session(text,text,uuid,uuid,text) to service_role;
grant  execute on function public.read_verify_session(text)                       to service_role;
grant  execute on function public.consume_verify_session(text)                    to service_role;
grant  execute on function public.purge_expired_verify_sessions()                 to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. PRIVATE AGREEMENT PDF BUCKET
--
-- No customer storage policy on purpose: signed agreements are served as
-- short-lived signed URLs minted server-side for the owner.
-- ─────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('apex-agreements', 'apex-agreements', false, 10485760, array['application/pdf'])
on conflict (id) do update set
  public             = false,
  file_size_limit    = 10485760,
  allowed_mime_types = array['application/pdf'];

drop policy if exists "st_agree_admin_all" on storage.objects;
create policy "st_agree_admin_all" on storage.objects for all
  using      (bucket_id = 'apex-agreements' and is_admin())
  with check (bucket_id = 'apex-agreements' and is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 18. THE ONE CUSTOMER-WRITABLE THING
--
-- The optional pre-charge reminder. Cannot move money. Mandatory transactional
-- notices are not reachable from here.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.set_subscription_reminder(
  p_subscription_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare updated_count integer;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  update service_subscriptions
     set reminder_enabled = coalesce(p_enabled, true)
   where id = p_subscription_id
     and customer_id = auth.uid();
  get diagnostics updated_count = row_count;

  if updated_count = 0 then raise exception 'Subscription not found'; end if;
  return coalesce(p_enabled, true);
end $$;
revoke all on function public.set_subscription_reminder(uuid, boolean) from public, anon;
grant  execute on function public.set_subscription_reminder(uuid, boolean) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 19. SERVER-SIDE WRITE PATHS  (service_role only)  — R2.10
--
-- Accepting the offer and creating the signed agreement is ONE transaction.
-- There is no window in which an offer is accepted with no agreement, or an
-- agreement exists against an unaccepted offer.
--
-- The money is read out of the offer row inside this function. The caller does
-- not supply it and cannot influence it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.accept_offer_and_sign_agreement(
  p_offer_id                uuid,
  p_customer_id             uuid,      -- authenticated caller, re-checked here
  p_selected_payment_method text,
  p_agreement_version       text,
  p_signer_name             text,
  p_signer_title            text,
  p_signature_typed         text,
  p_consent_service_scope   boolean,
  p_consent_recurring_auth  boolean,
  p_consent_electronic_sig  boolean,
  p_consent_term_cancel     boolean,
  p_snapshot                jsonb,
  p_signer_ip_hash          text default null,
  p_signer_user_agent       text default null
) returns service_plan_agreements
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o service_plan_offers;
  a service_plan_agreements;
  sub bigint; tax bigint; tot bigint;
begin
  select * into o from service_plan_offers where id = p_offer_id for update;
  if not found then raise exception 'Offer not found'; end if;

  -- Ownership is re-checked here, not merely in the Edge Function.
  if o.customer_id <> p_customer_id then raise exception 'Offer not found'; end if;

  -- The rendered contract body is mandatory. Merging the authoritative block
  -- below would otherwise turn a missing snapshot into a valid-looking object,
  -- producing a signed agreement with no human-readable terms in it.
  if p_snapshot is null
     or jsonb_typeof(p_snapshot) <> 'object'
     or p_snapshot = '{}'::jsonb then
    raise exception 'Agreement snapshot (the rendered contract) is required';
  end if;

  if p_selected_payment_method = 'ach' then
    sub := o.ach_monthly_subtotal_cents;
    tax := o.ach_monthly_tax_cents;
    tot := o.ach_monthly_total_cents;
  elsif p_selected_payment_method = 'card' then
    sub := o.card_monthly_subtotal_cents;
    tax := o.card_monthly_tax_cents;
    tot := o.card_monthly_total_cents;
  else
    raise exception 'Choose card or ACH';
  end if;

  -- The stored snapshot always carries the database's own authoritative numbers
  -- alongside whatever the renderer produced.
  insert into service_plan_agreements (
    offer_id, customer_id, equipment_id, agreement_version,
    selected_payment_method, monthly_subtotal_cents, monthly_tax_cents, monthly_total_cents,
    currency, term_months, activation_date, snapshot,
    signer_name, signer_title, signature_typed,
    consent_service_scope, consent_recurring_auth, consent_electronic_sig, consent_term_cancel,
    signer_ip_hash, signer_user_agent)
  values (
    o.id, o.customer_id, o.equipment_id, p_agreement_version,
    p_selected_payment_method, sub, tax, tot,
    o.currency, o.term_months, o.activation_date,
    coalesce(p_snapshot,'{}'::jsonb) || jsonb_build_object(
      'authoritative', jsonb_build_object(
        'source','database',
        'offer_id', o.id,
        'selected_payment_method', p_selected_payment_method,
        'monthly_subtotal_cents', sub,
        'monthly_tax_cents', tax,
        'monthly_total_cents', tot,
        'currency', o.currency,
        'term_months', o.term_months,
        'activation_date', o.activation_date,
        'offer_ach_total_cents',  o.ach_monthly_total_cents,
        'offer_card_total_cents', o.card_monthly_total_cents)),
    p_signer_name, p_signer_title, p_signature_typed,
    p_consent_service_scope, p_consent_recurring_auth,
    p_consent_electronic_sig, p_consent_term_cancel,
    p_signer_ip_hash, p_signer_user_agent)
  returning * into a;

  -- Accept AFTER the agreement exists. The insert trigger requires the offer to
  -- still be 'sent', so these two steps cannot be reordered or separated.
  update service_plan_offers
     set status = 'accepted', accepted_at = now()
   where id = o.id;

  insert into service_plan_events (event, source, customer_id, equipment_id, offer_id, agreement_id, detail)
  values ('agreement_signed','edge', o.customer_id, o.equipment_id, o.id, a.id,
          jsonb_build_object('rail', p_selected_payment_method, 'monthly_total_cents', tot));

  return a;
end $$;
revoke all on function public.accept_offer_and_sign_agreement(
  uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function public.accept_offer_and_sign_agreement(
  uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,jsonb,text,text)
  to service_role;

-- Creates the Apex subscription mirror by COPYING the signed agreement. No
-- amount, rail, term or date is accepted from the caller.
create or replace function public.create_subscription_from_agreement(p_agreement_id uuid)
returns service_subscriptions
language plpgsql security definer set search_path = public, pg_temp as $$
declare a service_plan_agreements; s service_subscriptions;
begin
  select * into a from service_plan_agreements where id = p_agreement_id for update;
  if not found then raise exception 'Agreement not found'; end if;
  if a.status <> 'signed' then raise exception 'Agreement % is %', a.id, a.status; end if;

  insert into service_subscriptions (
    agreement_id, offer_id, customer_id, equipment_id,
    payment_method, recurring_subtotal_cents, recurring_tax_cents, recurring_total_cents,
    currency, activation_date, term_months, max_cycles, status)
  values (
    a.id, a.offer_id, a.customer_id, a.equipment_id,
    a.selected_payment_method, a.monthly_subtotal_cents, a.monthly_tax_cents, a.monthly_total_cents,
    a.currency, a.activation_date, a.term_months, a.term_months, 'setup_pending')
  returning * into s;

  insert into service_plan_events (event, source, customer_id, equipment_id, offer_id, agreement_id, subscription_id, detail)
  values ('subscription_created','edge', a.customer_id, a.equipment_id, a.offer_id, a.id, s.id,
          jsonb_build_object('rail', a.selected_payment_method,
                             'monthly_total_cents', a.monthly_total_cents,
                             'max_cycles', a.term_months));
  return s;
end $$;
revoke all on function public.create_subscription_from_agreement(uuid) from public, anon, authenticated;
grant  execute on function public.create_subscription_from_agreement(uuid) to service_role;

commit;

-- =============================================================================
-- READ-ONLY VERIFY  (safe, no writes)
-- =============================================================================
select 'new tables' as check, count(*) as found, 5 as expected
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('customer_equipment','service_plan_offers',
                      'service_plan_agreements','service_subscriptions','service_plan_events');

select 'chain integrity FKs' as check, count(*) as found, 3 as expected
  from pg_constraint
 where conname in ('fk_offer_equipment_same_customer','fk_agreement_matches_offer_chain',
                   'fk_sub_matches_agreement_chain');

select 'validation + durability triggers' as check, count(*) as found, 5 as expected
  from pg_trigger
 where tgname in ('trg_validate_agreement','trg_validate_subscription',
                  'trg_no_delete_agreement','trg_events_append_only','trg_no_delete_billed_sub');

select 'payments new columns' as check, count(*) as found, 6 as expected
  from information_schema.columns
 where table_name = 'payments'
   and column_name in ('payment_source','subscription_id','billing_period_start',
                       'billing_period_end','provider_subscription_payment_id',
                       'provider_payment_number');

select 'invoices new columns' as check, count(*) as found, 4 as expected
  from information_schema.columns
 where table_name = 'invoices'
   and column_name in ('invoice_source','subscription_id','billing_period_start','billing_period_end');

select 'payments not one_time' as check, count(*) as must_be_zero
  from payments where payment_source <> 'one_time';
select 'invoices not one_time' as check, count(*) as must_be_zero
  from invoices where invoice_source <> 'one_time';

-- The gate. This MUST read false.
select key, value from app_config
 where key in ('recurring_billing_enabled','service_plan_contract_mode')
 order by key;

select 'rls enabled' as check, relname, relrowsecurity
  from pg_class
 where relname in ('customer_equipment','service_plan_offers',
                   'service_plan_agreements','service_subscriptions','service_plan_events')
 order by relname;
