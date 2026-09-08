-- =============================================================================
--  APEX — recurring reconciliation cron
--
--  ⚠️  READ THIS BEFORE RUNNING ANYTHING  ⚠️
--
--  The production job is ALREADY DEPLOYED AND HEALTHY. This file is for a NEW
--  environment, or for a deliberate, reviewed re-deploy.
--
--  DO NOT run this against production "just to be sure". STEP 1 unschedules the
--  existing job before recreating it, so a careless run takes reconciliation
--  offline — and if the key substitution in STEP 2 is then wrong, it stays
--  offline while Helcim keeps billing customers every month.
--
--  Run STEP 0 first. If it reports HEALTHY, stop. There is nothing to do.
--
--  The real worker key is NEVER committed to this repository.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
--  STEP 0 — READ ONLY. Is the existing job already working?
-- ─────────────────────────────────────────────────────────────────────────────
select
  case
    when last_success_at is null                       then 'NO SUCCESSFUL RUN EVER — setup needed'
    when last_forbidden_at > last_success_at           then 'BROKEN: worker key rejected — the deployed job has the wrong key'
    when now() - last_success_at > interval '90 minutes'
                                                       then 'STALE: no success in ' || (now() - last_success_at)::text
    when consecutive_failures > 0                      then 'DEGRADED: ' || consecutive_failures || ' consecutive failures'
    else 'HEALTHY — do not re-run this file'
  end                                    as verdict,
  last_success_at, last_failure_at, last_forbidden_at,
  last_run_source, consecutive_failures, subscriptions_scanned, provider_errors,
  last_error
from recurring_sync_health;

select jobid, jobname, schedule, active
  from cron.job where jobname = 'apex-subscription-reconcile';


-- ─────────────────────────────────────────────────────────────────────────────
--  STEP 1 — Substitute the key.
--
--  Replace PUT_WORKER_KEY_HERE below with the SAME secret held by the
--  subscription-reconcile Edge Function in RECONCILE_WORKER_KEY.
--
--  There is exactly ONE place to change. Do not commit the result.
-- ─────────────────────────────────────────────────────────────────────────────
select set_config('apex.worker_key', 'PUT_WORKER_KEY_HERE', false);


-- ─────────────────────────────────────────────────────────────────────────────
--  STEP 2 — Guard. Aborts BEFORE anything is unscheduled.
--
--  This exists because the previous version of this file shipped with a literal
--  <RECONCILE_WORKER_KEY> placeholder inside the cron body. Running it unedited
--  produced a job that returned 403 on every execution — silently, forever.
-- ─────────────────────────────────────────────────────────────────────────────
do $guard$
declare k text := coalesce(current_setting('apex.worker_key', true), '');
begin
  if k = '' or k = 'PUT_WORKER_KEY_HERE' or k like '<%' or k like '%>' then
    raise exception
      'STOP: the worker key placeholder was not replaced. Nothing has been changed. Edit STEP 1 and run again.';
  end if;
  if length(k) < 16 then
    raise exception
      'STOP: the worker key is only % characters. That does not look like the real secret. Nothing has been changed.',
      length(k);
  end if;
  raise notice 'Worker key accepted (% characters). Proceeding.', length(k);
end $guard$;


-- ─────────────────────────────────────────────────────────────────────────────
--  STEP 3 — (Re)schedule. The key is injected with %L, so it is quoted safely
--  and appears in exactly one place.
-- ─────────────────────────────────────────────────────────────────────────────
do $deploy$
declare
  k   text := current_setting('apex.worker_key');
  cmd text;
begin
  cmd := format($cmd$
    select net.http_post(
      url     := 'https://cjtezsgfdfijmdxzzbiq.supabase.co/functions/v1/subscription-reconcile',
      headers := jsonb_build_object('Content-Type','application/json','x-worker-key',%L),
      body    := '{}'::jsonb
    );
  $cmd$, k);

  perform cron.unschedule(jobid) from cron.job where jobname = 'apex-subscription-reconcile';
  perform cron.schedule('apex-subscription-reconcile', '*/15 * * * *', cmd);
  raise notice 'Scheduled apex-subscription-reconcile every 15 minutes.';
end $deploy$;

-- Clear the key from this session so it is not left in a session variable.
select set_config('apex.worker_key', '', false);


-- ─────────────────────────────────────────────────────────────────────────────
--  STEP 4 — VERIFY. Do not walk away until this passes.
--
--  Wait ~15 minutes for one scheduled run, then re-run STEP 0.
--  It must report HEALTHY, and last_forbidden_at must NOT be newer than
--  last_success_at. A 403 means the key here and the key in the Edge Function
--  secret do not match.
-- ─────────────────────────────────────────────────────────────────────────────
select jobid, jobname, schedule, active
  from cron.job where jobname = 'apex-subscription-reconcile';

select status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'apex-subscription-reconcile')
 order by start_time desc limit 5;

-- Prerequisites, if this is a brand new environment:
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--   supabase secrets set RECONCILE_WORKER_KEY="<same value used in STEP 1>"
