import fs from 'node:fs';
import crypto from 'node:crypto';
const root=new URL('../',import.meta.url).pathname;
// CANONICAL FRONTEND IS docs/. The repository root still holds frozen
// legacy copies from before the GitHub Pages publishing switch, so a
// suite reading root/ was asserting against files nobody deploys.
const read=p=>fs.readFileSync(root+p,'utf8');
const must=(ok,msg)=>{if(!ok)throw new Error(msg);console.log('PASS',msg)};
const rr=read('supabase/functions/subscription-reconcile/index.ts');
const sa=read('supabase/functions/service-plans-admin/index.ts');
const act=read('supabase/functions/subscription-activate/index.ts');
const ref=read('supabase/functions/payment-refund/index.ts');
const cust=read('docs/portal-customer.js');
const adm=read('docs/portal-admin.js');
const live=read('GO_LIVE_RECURRING_V24_5.sql');
must(rr.includes('includeSubObjects=true'),'reconciler reads authoritative subscription + payment subobjects');
must(rr.includes('provider_subscription_payment_id'),'reconciler keys cycles by provider payment id');
must(rr.includes('provider_payment_number'),'reconciler stores provider payment number');
must(rr.includes('uniq.size === 1'),'transaction resolution refuses ambiguous matches');
must(rr.includes('isAchCleared'),'ACH is not treated as paid without clearing logic');
must(rr.includes('payment_source: "recurring"'),'recurring ledger rows are classified recurring');
must(rr.includes('invoice_source: "recurring"'),'recurring invoices are classified recurring');
must(sa.includes('case "cancel-subscription"'),'admin-only subscription cancellation action exists');
// CORRECTED. This previously asserted `method: "DELETE"`. Helcim documents
// Delete and Cancel as different operations: Delete removes the subscription and
// its billing history permanently, which destroys the record reconciliation
// depends on. V24.7 replaced it with a PATCH to a cancelled status, verified by
// reading the provider back. A test demanding DELETE would push someone to
// reintroduce a destructive call, so it now asserts the opposite.
must(!/method:\s*"DELETE"/.test(sa),'cancellation does NOT use the destructive DELETE endpoint');
must(sa.includes('"subscriptions", token, { method: "PATCH"'),'cancellation uses PATCH /v2/subscriptions');
must(sa.includes('status: target'),'the PATCH body carries only the target status');
must(sa.includes('provider_did_not_apply_change'),'Apex refuses to record a change the provider did not apply');
must(sa.includes('apex_unchanged: true'),'a failed provider call leaves Apex untouched');
must(sa.includes('refunds_issued: false'),'cancellation states explicitly that nothing was refunded');
must(ref.includes('payment_source: orig.payment_source'),'refund preserves recurring workflow axis');
must(ref.includes('subscription_id: orig.payment_source === "recurring"'),'refund remains attached to subscription');
must(cust.includes("i.invoice_source === 'recurring'"),'customer one-time pay UI blocks recurring invoices');
must(adm.includes('rs-cancel'),'admin cancellation is reachable from the subscriptions UI');
must(adm.includes('spActivateSubscription'),'admin activation UI exists');
// Comments stripped: a comment explaining that data-view REPLACED onclick is
// not an inline handler, and matching prose is how a passing test lies.
const admCode = adm.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'');
must(!/\son[a-z]+\s*=\s*["'`]/.test(admCode),'admin UI generates no inline event handlers');
must(act.includes('activation_date_in_past'),'activation refuses historical production start dates');
must(live.includes("service_plan_contract_mode must be live"),'go-live SQL requires live contract mode');
must(live.includes("recurring_billing_enabled','true"),'go-live gate is explicit');
console.log('All V24.5 static assertions passed.');
