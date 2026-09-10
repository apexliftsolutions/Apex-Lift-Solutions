import fs from 'node:fs';
const root = new URL('../', import.meta.url).pathname;
const read = p => fs.readFileSync(root+p,'utf8');
let pass=0, fail=0;
function t(name, ok){console.log(ok?'PASS':'FAIL',name); ok?pass++:fail++;}
const c=read('supabase/functions/service-plans-customer/index.ts');
const ui=read('docs/portal-customer.js');
const co=read('supabase/functions/subscription-verify-checkout/index.ts');
const va=read('supabase/functions/subscription-verify-validate/index.ts');
const ac=read('supabase/functions/subscription-activate/index.ts');
// CORRECTED. The shipped heading is "6. Fixed term; no automatic renewal".
// The old string was from a draft that never went out, so the assertion could
// only ever fail — and a stale red test teaches people to ignore the suite.
t('contract says fixed term', c.includes('Fixed term; no automatic renewal'));
t('old customer cancellation promise removed', !c.includes('Customer may request cancellation at any time'));
t('customer UI has no post-sign cancel button', !ui.includes('cpCancelPlan('));
t('verify is zero dollar', co.includes('paymentType: "verify"') && co.includes('amount: 0'));
t('verify sets default method', co.includes('setAsDefaultPaymentMethod: 1'));
t('verify rail comes from agreement', co.includes('agr.selected_payment_method'));
t('validator requires hash match', va.includes('hash_mismatch'));
t('validator does provider customer lookup', va.includes('/customers?customerCode='));
t('activation respects gate', ac.includes('recurring_billing_enabled'));
t('activation uses 25-char subscription idempotency helper', ac.includes('subscriptionIdempotencyKey'));
t('activation checks provider plan', ac.includes('payment-plans/${planId}'));
t('activation GET-confirms subscription', ac.includes('includeSubObjects=true'));
t('activation maps ACH to bank', ac.includes('s.payment_method==="ach"?"bank":"card"'));
t('activation does not retry ambiguous POST', ac.includes('activation_under_review'));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
