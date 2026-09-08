-- FINAL RECURRING BILLING GATE — run ONLY after V24.5 functions are deployed.
-- This aborts rather than enabling billing if the required production config is absent.
do $$
declare
  contract_mode text;
  plan_generic text;
  plan_card text;
  plan_bank text;
begin
  select value into contract_mode from app_config where key='service_plan_contract_mode';
  select value into plan_generic from app_config where key='helcim_recurring_plan_id_expires';
  select value into plan_card from app_config where key='helcim_recurring_plan_id_expires_card';
  select value into plan_bank from app_config where key='helcim_recurring_plan_id_expires_bank';

  if coalesce(contract_mode,'') <> 'live' then
    raise exception 'STOP: service_plan_contract_mode must be live';
  end if;
  if coalesce(nullif(plan_generic,''), nullif(plan_card,''), nullif(plan_bank,'')) is null then
    raise exception 'STOP: no Helcim recurring payment plan id is configured';
  end if;

  insert into app_config(key,value) values ('recurring_billing_enabled','true')
  on conflict (key) do update set value=excluded.value;
end $$;

select key,value from app_config
where key in ('service_plan_contract_mode','recurring_billing_enabled',
              'helcim_recurring_plan_id_expires','helcim_recurring_plan_id_expires_card','helcim_recurring_plan_id_expires_bank')
order by key;
