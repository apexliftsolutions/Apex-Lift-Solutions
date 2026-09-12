-- =============================================================================
--  0015_fix_new_id_pgcrypto.sql
--  Production hotfix — quote → invoice failed with:
--      function gen_random_bytes(integer) does not exist
--
--  Migrations 0001–0014 are already deployed and are NOT edited.
--
--  WHY IT FAILED
--  `public.new_id(text)` generates every quote / invoice / request id and calls
--  pgcrypto's gen_random_bytes() UNQUALIFIED. On Supabase that function lives in
--  the `extensions` schema, not `public`.
--
--  `quote_to_invoice_v2()` is SECURITY DEFINER with `SET search_path =
--  public, pg_temp` — deliberately restrictive, and correctly so. When its
--  INSERT evaluates the invoices.id default → new_id('INV') → bare
--  gen_random_bytes(6), the restricted path cannot resolve it and the whole
--  conversion aborts.
--
--  A browser INSERT works because PostgREST runs with a search_path that still
--  reaches `extensions`. That is exactly why quotes could be created while
--  invoice conversion failed.
--
--  THE FIX
--  Schema-qualify the call. This is the shared generator, so every caller —
--  quotes, invoices, service_history, service_requests — becomes robust, rather
--  than patching the invoice path alone.
--
--  NOT done, deliberately:
--    * widening quote_to_invoice_v2's search_path (that weakens a SECURITY
--      DEFINER function to work around a resolvable name);
--    * a different id generator (the format is in use and must not change);
--    * regenerating or touching any existing id.
-- =============================================================================

-- Resolve the schema rather than assuming it. `extensions` is what Supabase
-- uses and what production reported, but pgcrypto can also be installed into
-- public or a custom schema, and a hard-coded guess would simply move the
-- failure. The format, signature, language and volatility below are copied
-- from the 0002 definition and are unchanged.
do $$
declare v_schema text; v_body text;
begin
  select n.nspname into v_schema
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'gen_random_bytes'
     and pg_get_function_identity_arguments(p.oid) = 'integer'
   order by case n.nspname when 'extensions' then 0 when 'public' then 1 else 2 end
   limit 1;

  if v_schema is null then
    raise exception 'pgcrypto_not_found'
      using detail = 'gen_random_bytes(integer) does not exist in any schema. '
                     'Install pgcrypto (create extension pgcrypto with schema extensions) and re-run this migration.';
  end if;

  raise notice 'new_id(): qualifying gen_random_bytes with schema %', v_schema;

  -- Identical to the shipped definition apart from the schema qualification.
  v_body := format($fmt$
    create or replace function public.new_id(prefix text) returns text
    language sql volatile as $b$
      select prefix || '-' || upper(substr(encode(%I.gen_random_bytes(6), 'hex'), 1, 10))
    $b$;
  $fmt$, v_schema);
  execute v_body;
end $$;

-- Unchanged from 0001/0002 — restated so the grant survives a CREATE OR REPLACE
-- on any environment where it was not already present.
grant execute on function public.new_id(text) to anon, authenticated, service_role;

comment on function public.new_id(text) is
  'Generates PREFIX-XXXXXXXXXX ids. gen_random_bytes is SCHEMA-QUALIFIED: callers such as quote_to_invoice_v2() run with a restricted search_path and cannot resolve it otherwise.';

-- ─────────────────────────────────────────────────────────────────────────────
--  PROVE IT under the exact conditions the conversion function runs in.
--  If this fails the migration aborts, so a broken generator can never be
--  deployed silently.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare v_id text;
begin
  perform set_config('search_path', 'public, pg_temp', true);   -- as quote_to_invoice_v2
  v_id := public.new_id('INV');
  if v_id !~ '^INV-[0-9A-F]{10}$' then
    raise exception 'new_id_format_changed' using detail = format('got %L', v_id);
  end if;
end $$;
