// POST /subscription-verify-validate { checkoutToken, eventMessage?, rawDataResponse?, hash? }
// Validates a HelcimPay.js $0 VERIFY result, confirms the Helcim customer exists,
// then marks ONLY the already-signed subscription's payment method as verified.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { HELCIM_API } from "../_shared/helcim-api.ts";
import { normalizeHelcimPayResponse } from "../_shared/helcimpay.ts";

const FN_VERSION="2026-09-07.v24.3";
const SB_URL=Deno.env.get("SUPABASE_URL")!, SB_SERVICE=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, SB_ANON=Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGIN=Deno.env.get("PUBLIC_SITE_URL")??Deno.env.get("APP_BASE_URL")??"https://apexliftsolutionsusa.com";
const cors={"Access-Control-Allow-Origin":ORIGIN,"Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const j=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,"Content-Type":"application/json"}});

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
  try{
    const auth=req.headers.get("Authorization"); if(!auth)return j({error:"unauthorized"},401);
    const uc=createClient(SB_URL,SB_ANON,{global:{headers:{Authorization:auth}}}); const {data:{user}}=await uc.auth.getUser(); if(!user)return j({error:"unauthorized"},401);
    const db=createClient(SB_URL,SB_SERVICE);
    const body=await req.json().catch(()=>({})); const checkoutToken=String(body.checkoutToken??""); if(!checkoutToken)return j({error:"checkout_token_required"},400);
    const {data:sess}=await db.rpc("read_verify_session",{p_checkout_token:checkoutToken}).maybeSingle();
    if(!sess)return j({error:"verify_session_expired_or_used"},409);
    if(sess.customer_id!==user.id)return j({error:"forbidden"},403);

    const raw=body.eventMessage??body.rawDataResponse; const hp=normalizeHelcimPayResponse(raw);
    const presented=hp.hash??(typeof body.hash==="string"?body.hash:null); if(!presented)return j({error:"missing_hash"},400);
    let hashOk=false; for(const cand of hp.hashCandidates){ if(await sha256Hex(cand+sess.secret_token)===presented){hashOk=true;break;} }
    if(!hashOk)return j({error:"hash_mismatch"},400);

    const txn=deepTxn(raw); const customerCode=String(txn.customerCode??"").trim();
    if(!customerCode)return j({error:"missing_customer_code"},400);
    const expectedRail=String(sess.payment_rail);
    if(expectedRail==="card"){
      const status=String(txn.status??hp.status??"").toUpperCase();
      if(status && status!=="APPROVED")return j({error:"verify_not_approved"},409);
      if(!txn.cardToken && !txn.cardNumber)return j({error:"card_not_verified"},409);
    } else {
      const authStatus=String(txn.statusAuth??txn.status??"").toUpperCase();
      if(/DECLIN|CANCEL|FAIL|REJECT/.test(authStatus))return j({error:"bank_not_verified"},409);
      if(!txn.bankToken && !txn.bankAccountNumber)return j({error:"bank_not_verified"},409);
    }

    const {data:cust}=await db.from("customers").select("id,status,helcim_customer_code").eq("id",user.id).maybeSingle();
    if(!cust||cust.status!=="active")return j({error:"account_not_active"},403);
    if(cust.helcim_customer_code && cust.helcim_customer_code!==customerCode)return j({error:"customer_code_mismatch"},409);

    // Server-to-server provider confirmation. We never trust browser identity alone.
    const adminToken=Deno.env.get("HELCIM_ADMIN_API_TOKEN")??""; if(!adminToken)return j({error:"helcim_not_configured"},500);
    const cr=await fetch(`${HELCIM_API}/customers?customerCode=${encodeURIComponent(customerCode)}&limit=2${expectedRail==="card"?"&includeCards=yes":""}`,{headers:{"api-token":adminToken,"accept":"application/json"}});
    if(!cr.ok)return j({error:"provider_customer_lookup_failed",provider_http:cr.status},502);
    const cb:any=await cr.json().catch(()=>null); if(!hasExactCustomer(cb,customerCode))return j({error:"provider_customer_not_found"},502);

    const {data:agr}=await db.from("service_plan_agreements").select("*").eq("id",sess.agreement_id).eq("customer_id",user.id).maybeSingle();
    if(!agr||agr.status!=="signed")return j({error:"agreement_not_signed"},409);
    if(agr.selected_payment_method!==expectedRail)return j({error:"rail_mismatch"},409);
    let {data:sub}=await db.from("service_subscriptions").select("*").eq("agreement_id",agr.id).maybeSingle();
    if(!sub){ const {data:m,error:me}=await db.rpc("create_subscription_from_agreement",{p_agreement_id:agr.id}); if(me)return j({error:"subscription_setup_failed"},409); sub=Array.isArray(m)?m[0]:m; }
    if(sub.payment_method!==expectedRail)return j({error:"subscription_rail_mismatch"},409);

    const display=expectedRail==="card"?maskCard(txn):maskBank(txn);
    const now=new Date().toISOString();
    const {data:updated,error:uErr}=await db.from("service_subscriptions").update({
      provider_customer_code:customerCode,payment_method_verified_at:now,payment_method_display:display,status:"method_verified",activation_error_category:null,updated_at:now,
    }).eq("id",sub.id).in("status",["setup_pending","failed_setup","method_verified"]).select().maybeSingle();
    if(uErr)return j({error:"subscription_update_failed",detail:uErr.message},500);
    if(!updated && sub.status!=="method_verified")return j({error:"subscription_state_changed"},409);
    if(!cust.helcim_customer_code) await db.from("customers").update({helcim_customer_code:customerCode}).eq("id",user.id);

    const {data:claimed}=await db.rpc("consume_verify_session",{p_checkout_token:checkoutToken}).maybeSingle();
    if(!claimed)return j({error:"verify_session_already_used"},409);
    await db.from("service_plan_events").insert({event:"payment_method_verified",source:"edge",customer_id:user.id,equipment_id:agr.equipment_id,offer_id:agr.offer_id,agreement_id:agr.id,subscription_id:sub.id,detail:{rail:expectedRail,display,fn_version:FN_VERSION}});
    return j({ok:true,status:"method_verified",subscription_id:sub.id,payment_method:expectedRail,payment_method_display:display,fn_version:FN_VERSION});
  }catch(e){console.error("[subscription-verify-validate]",e);return j({error:"server_error"},500);}
});

function deepTxn(input:any):any{ let v=input; for(let i=0;i<3&&typeof v==="string";i++){try{v=JSON.parse(v)}catch{break}}; const r=v&&typeof v==="object"?v:{}; const d=r.data&&typeof r.data==="object"?r.data:r; const d2=d.data&&typeof d.data==="object"?d.data:d; return d2; }
async function sha256Hex(s:string){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,"0")).join("");}
function arr(b:any):any[]{if(Array.isArray(b))return b;for(const k of ["data","customers","results"]){if(Array.isArray(b?.[k]))return b[k]}return b&&typeof b==="object"?[b]:[]}
function hasExactCustomer(b:any,code:string){return arr(b).some((x:any)=>String(x?.customerCode??"")===code)}
function last4(v:any){const d=String(v??"").replace(/\D/g,"");return d.length>=4?d.slice(-4):""}
function maskCard(t:any){const l=last4(t.cardNumber);return `${String(t.cardType??"Card").toUpperCase()}${l?` •••• ${l}`:""}`}
function maskBank(t:any){const l=last4(t.bankAccountNumber);return `Bank account${l?` •••• ${l}`:""}`}
