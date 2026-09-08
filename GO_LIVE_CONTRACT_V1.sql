-- Apex Monthly Maintenance Agreement V1 contract-mode switch.
-- This does NOT enable recurring billing and does NOT create or charge subscriptions.
-- Deploy service-plans-customer v24.4 and the v24.4 portal before running this.
begin;

update app_config
   set value = 'APEX-MMA-2026-09-V1'
 where key = 'service_plan_agreement_version';

update app_config
   set value = 'live'
 where key = 'service_plan_contract_mode';

-- Billing remains deliberately gated until the Helcim recurring plan and
-- controlled activation test are complete.
update app_config
   set value = 'false'
 where key = 'recurring_billing_enabled';

commit;

select key, value
from app_config
where key in (
  'service_plan_agreement_version',
  'service_plan_contract_mode',
  'recurring_billing_enabled'
)
order by key;
