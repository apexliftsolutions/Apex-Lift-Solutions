// POST /subscription-activate { subscription_id }
// Creates exactly one Helcim recurring subscription from an immutable signed
// agreement. Gate must be explicitly enabled. Ambiguous provider outcomes are
// reconciled before any new POST is permitted.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { helcimCall, subscriptionIdempotencyKey } from "../_shared/helcim-api.ts";
const FN_VERSION="2026-09-07.v24.3";
const SB_URL=Deno.env.get("SUPABASE_URL")!,SB_SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,SB_ANON=Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGIN=Deno.env.get("PUBLIC_SITE_URL")??Deno.env.get("APP_BASE_URL")??"https://apexliftsolutionsusa.com";
const cors={"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const j=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,"Content-Type":"application/json"}});

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 try{
  const auth=req.headers.get("Authorization");if(!auth)return j({error:"unauthorized"},401);
  const uc=createClient(SB_URL,SB_ANON,{global:{headers:{Authorization:auth}}});const {data:{user}}=await uc.auth.getUser();if(!user)return j({error:"unauthorized"},401);
  const db=createClient(SB_URL,SB_SERVICE);const body=await req.json().catch(()=>({}));const sid=String(body.subscription_id??"");if(!sid)return j({error:"subscription_id_required"},400);
  const {data:cust}=await db.from("customers").select("status,helcim_customer_code").eq("id",user.id).maybeSingle();if(!cust||cust.status!=="active")return j({error:"account_not_active"},403);
  let {data:s}=await db.from("service_subscriptions").select("*").eq("id",sid).eq("customer_id",user.id).maybeSingle();if(!s)return j({error:"not_found"},404);
  if(s.provider_subscription_id)return j({ok:true,status:s.status,already_active:true,provider_subscription_id:s.provider_subscription_id,fn_version:FN_VERSION});
  if(s.status!=="method_verified")return j({error:"payment_method_not_verified",status:s.status},409);
  const gate=await cfg(db,"recurring_billing_enabled","false");if(gate!=="true")return j({error:"recurring_billing_disabled"},409);
  const mode=await cfg(db,"service_plan_contract_mode","test");
  if(mode==="test" && s.activation_date<=new Date().toISOString().slice(0,10))return j({error:"test_activation_date_must_be_future"},409);
  if(!s.payment_method_verified_at)return j({error:"payment_method_not_verified"},409);
  const code=String(s.provider_customer_code??cust.helcim_customer_code??"");if(!code)return j({error:"helcim_customer_missing"},409);
  const token=Deno.env.get("HELCIM_ADMIN_API_TOKEN")??"";if(!token)return j({error:"helcim_not_configured"},500);

  const generic=await cfg(db,"helcim_recurring_plan_id_expires","");
  const railSpecific=await cfg(db,s.payment_method==="ach"?"helcim_recurring_plan_id_expires_bank":"helcim_recurring_plan_id_expires_card","");
  const planId=Number(railSpecific||generic);if(!Number.isInteger(planId)||planId<=0)return j({error:"recurring_plan_not_configured"},409);
  const planR=await helcimCall(`payment-plans/${planId}`,token);if(!planR.ok)return j({error:"recurring_plan_lookup_failed",category:planR.category,provider_http:planR.httpStatus},502);
  const plan:any=unwrap(planR.body);const planErr=validatePlan(plan,s.payment_method);if(planErr)return j({error:"recurring_plan_invalid",detail:planErr},409);

  // If a prior POST had an ambiguous result, reconcile first. Never send a new
  // create request just because our network response was lost.
  if(s.activation_attempted_at){
    const found=await findExactSubscription(token,s,planId,code);
    if(found)return await bind(db,s,found,planId);
    return j({error:"activation_under_review",detail:"A prior activation attempt has an unknown provider result. Do not retry with a new key."},202);
  }

  const idem=subscriptionIdempotencyKey();const now=new Date().toISOString();
  const {error:stampErr}=await db.from("service_subscriptions").update({activation_idempotency_key:idem,activation_attempted_at:now,provider_payment_plan_id:planId,activation_error_category:null,updated_at:now}).eq("id",s.id).eq("status","method_verified");
  if(stampErr)return j({error:"activation_stamp_failed"},500);
  const providerRail=s.payment_method==="ach"?"bank":"card";
  const request={subscriptions:[{customerCode:code,dateActivated:s.activation_date,paymentMethod:providerRail,paymentPlanId:planId,recurringAmount:Number((Number(s.recurring_total_cents)/100).toFixed(2)),maxCycles:Number(s.max_cycles)}]};
  const cr=await helcimCall("subscriptions",token,{method:"POST",idem,body:request});
  if(!cr.ok){
    if(["auth","permission","invalid"].includes(cr.category)){
      await db.from("service_subscriptions").update({activation_idempotency_key:null,activation_attempted_at:null,activation_error_category:cr.category,updated_at:new Date().toISOString()}).eq("id",s.id);
      return j({error:"activation_rejected",category:cr.category,provider_http:cr.httpStatus},502);
    }
    await db.from("service_subscriptions").update({activation_error_category:"ambiguous_provider_result",updated_at:new Date().toISOString()}).eq("id",s.id);
    return j({error:"activation_under_review"},202);
  }
  let created=findSubscriptionObject(cr.body);
  if(!created?.id)created=await findExactSubscription(token,s,planId,code);
  if(!created?.id){await db.from("service_subscriptions").update({activation_error_category:"provider_created_but_id_unresolved",updated_at:new Date().toISOString()}).eq("id",s.id);return j({error:"activation_under_review"},202);}
  return await bind(db,s,created,planId);
 }catch(e){console.error("[subscription-activate]",e);return j({error:"server_error"},500);}
});

async function bind(db:any,s:any,created:any,planId:number){
 const token=Deno.env.get("HELCIM_ADMIN_API_TOKEN")!;const id=Number(created.id);const rr=await helcimCall(`subscriptions/${id}?includeSubObjects=true`,token);if(!rr.ok)return j({error:"activation_confirmation_failed",provider_http:rr.httpStatus},202);
 const p:any=unwrap(rr.body);const why=matches(s,p,planId);if(why)return j({error:"provider_subscription_mismatch",detail:why},409);
 const ps=String(p.status??"").toLowerCase();const local=ps==="cancelled"?"cancelled":ps==="term_ended"?"completed":p.hasFailedPayments==="true"||p.hasFailedPayments===true?"past_due":"active";
 const now=new Date().toISOString();const {data:u,error}=await db.from("service_subscriptions").update({provider_subscription_id:id,provider_payment_plan_id:planId,provider_customer_code:String(p.customerCode),provider_verified_at:now,status:local,activated_at:now,next_billing_date:validDate(p.dateBilling),times_billed:Number(p.timesBilled??0),has_failed_payments:p.hasFailedPayments==="true"||p.hasFailedPayments===true,activation_error_category:null,last_synced_at:now,updated_at:now}).eq("id",s.id).is("provider_subscription_id",null).select().maybeSingle();
 if(error)return j({error:"activation_persist_failed",detail:error.message},500);const row=u??(await db.from("service_subscriptions").select("*").eq("id",s.id).single()).data;
 await db.from("service_plan_events").insert({event:"subscription_activated",source:"edge",customer_id:s.customer_id,equipment_id:s.equipment_id,offer_id:s.offer_id,agreement_id:s.agreement_id,subscription_id:s.id,detail:{provider_subscription_id:id,plan_id:planId,fn_version:FN_VERSION}});
 return j({ok:true,status:row.status,subscription_id:s.id,provider_subscription_id:id,next_billing_date:row.next_billing_date,fn_version:FN_VERSION});
}
async function findExactSubscription(token:string,s:any,planId:number,code:string){const q=`subscriptions?customerCode=${encodeURIComponent(code)}&paymentPlanId=${planId}&dateActivated=${encodeURIComponent(s.activation_date)}&limit=100`;const r=await helcimCall(q,token);if(!r.ok)return null;const hits=arr(r.body).filter((x:any)=>!matches(s,x,planId));return hits.length===1?hits[0]:null}
function matches(s:any,p:any,planId:number):string|null{if(Number(p.paymentPlanId)!==Number(planId))return"plan id differs";if(String(p.customerCode)!==String(s.provider_customer_code))return"customerCode differs";if(String(p.dateActivated)!==String(s.activation_date))return"activation date differs";if(Math.round(Number(p.recurringAmount)*100)!==Number(s.recurring_total_cents))return"recurring amount differs";if(Number(p.maxCycles??s.max_cycles)!==Number(s.max_cycles))return"maxCycles differs";return null}
function validatePlan(p:any,rail:string){if(String(p.status).toLowerCase()!=="active")return"plan is not active";if(String(p.type).toLowerCase()!=="subscription")return"type must be subscription";if(String(p.currency).toUpperCase()!=="USD")return"currency must be USD";if(String(p.billingPeriod).toLowerCase()!=="monthly")return"billingPeriod must be monthly";if(Number(p.billingPeriodIncrements)!==1)return"billingPeriodIncrements must be 1";if(String(p.termType).toLowerCase()!=="expires")return"termType must be expires";if(String(p.taxType).toLowerCase()!=="no_tax")return"taxType must be no_tax";const pm=String(p.paymentMethod).toLowerCase();if(rail==="ach"&&!['bank','card_bank'].includes(pm))return"plan does not allow bank";if(rail==="card"&&!['card','card_bank'].includes(pm))return"plan does not allow card";return null}
async function cfg(db:any,k:string,d:string){const {data}=await db.from("app_config").select("value").eq("key",k).maybeSingle();return String(data?.value??d)}
function unwrap(b:any):any{if(Array.isArray(b))return b[0]??{};if(b?.data&&!Array.isArray(b.data)&&typeof b.data==="object")return b.data;return b??{}}
function arr(b:any):any[]{if(Array.isArray(b))return b;for(const k of ["data","subscriptions","results"]){if(Array.isArray(b?.[k]))return b[k]}return b&&typeof b==="object"?[b]:[]}
function findSubscriptionObject(b:any){const all=arr(b);for(const x of all){if(x&&typeof x==="object"&&x.id&&x.customerCode&&x.paymentPlanId)return x;for(const y of Object.values(x??{})){if(y&&typeof y==="object"&&!Array.isArray(y)&&(y as any).id&&(y as any).customerCode)return y}}return null}
function validDate(v:any){const s=String(v??"");return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:null}
