// POST /subscription-verify-checkout { agreement_id }
// Creates a $0 HelcimPay.js VERIFY session for the payment rail already signed
// in the agreement. No amount/rail/customer identity is accepted from browser.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { HELCIM_API } from "../_shared/helcim-api.ts";

const FN_VERSION = "2026-09-07.v24.3";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ORIGIN = Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("APP_BASE_URL") ?? "https://apexliftsolutionsusa.com";
const cors = { "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const j = (b: unknown, s=200) => new Response(JSON.stringify(b), { status:s, headers:{...cors,"Content-Type":"application/json"} });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return j({error:"unauthorized"},401);
    const uc = createClient(SB_URL, SB_ANON, { global:{ headers:{ Authorization:auth } } });
    const { data:{ user } } = await uc.auth.getUser();
    if (!user) return j({error:"unauthorized"},401);
    const db = createClient(SB_URL, SB_SERVICE);
    const { agreement_id } = await req.json().catch(()=>({}));
    if (!agreement_id) return j({error:"agreement_id_required"},400);

    const { data:cust, error:cErr } = await db.from("customers")
      .select("id,email,name,company,phone,status,helcim_customer_code")
      .eq("id", user.id).maybeSingle();
    if (cErr) return j({error:"server_error"},500);
    if (!cust || cust.status !== "active") return j({error:"account_not_active"},403);

    const { data:agr } = await db.from("service_plan_agreements").select("*")
      .eq("id", agreement_id).eq("customer_id", user.id).maybeSingle();
    if (!agr) return j({error:"not_found"},404);
    if (agr.status !== "signed") return j({error:"agreement_not_signed"},409);
    if (!agr.pdf_path) return j({error:"pdf_not_ready"},409);

    // Ensure an Apex subscription mirror exists; it copies all financial terms
    // from the immutable agreement and accepts no browser amount/rail/date.
    let { data:sub } = await db.from("service_subscriptions").select("*").eq("agreement_id", agr.id).maybeSingle();
    if (!sub) {
      const { data:made, error:mkErr } = await db.rpc("create_subscription_from_agreement", { p_agreement_id: agr.id });
      if (mkErr) {
        const { data:again } = await db.from("service_subscriptions").select("*").eq("agreement_id", agr.id).maybeSingle();
        if (!again) return j({error:"subscription_setup_failed",detail:mkErr.message},409);
        sub = again;
      } else sub = Array.isArray(made) ? made[0] : made;
    }
    if (["method_verified","active","past_due","completed"].includes(String(sub.status))) {
      return j({ok:true,already_verified:true,subscription_id:sub.id,status:sub.status,payment_method_display:sub.payment_method_display,fn_version:FN_VERSION});
    }
    if (!["setup_pending","failed_setup"].includes(String(sub.status))) return j({error:"subscription_not_setupable",status:sub.status},409);

    const adminToken = Deno.env.get("HELCIM_ADMIN_API_TOKEN") ?? "";
    const checkoutToken = Deno.env.get("HELCIM_CHECKOUT_API_TOKEN") ?? "";
    if (!adminToken || !checkoutToken) return j({error:"helcim_not_configured"},500);

    let customerCode = String(cust.helcim_customer_code ?? "").trim();
    if (!customerCode) {
      // Deterministic code prevents duplicate Helcim customers if a request is
      // retried after an ambiguous network response.
      const wanted = `APX${String(cust.id).replace(/-/g,"").slice(0,16).toUpperCase()}`;
      customerCode = await ensureHelcimCustomer(adminToken, wanted, cust);
      if (!customerCode) return j({error:"helcim_customer_setup_failed"},502);
      const { error:uErr } = await db.from("customers").update({helcim_customer_code:customerCode}).eq("id",cust.id).is("helcim_customer_code",null);
      if (uErr) {
        const { data:fresh } = await db.from("customers").select("helcim_customer_code").eq("id",cust.id).single();
        if (fresh?.helcim_customer_code !== customerCode) return j({error:"customer_code_conflict"},409);
      }
    }

    const rail = agr.selected_payment_method === "ach" ? "ach" : "cc";
    const initBody = {
      paymentType: "verify",
      amount: 0,
      currency: "USD",
      customerCode,
      paymentMethod: rail,
      setAsDefaultPaymentMethod: 1,
      hideExistingPaymentDetails: 1,
      confirmationScreen: false,
      language: "en",
    };
    const hr = await fetch(`${HELCIM_API}/helcim-pay/initialize`, {
      method:"POST", headers:{"api-token":checkoutToken,"accept":"application/json","content-type":"application/json"}, body:JSON.stringify(initBody)
    });
    const raw = await hr.text();
    let out:any = {}; try { out = JSON.parse(raw); } catch {}
    if (!hr.ok || !out.checkoutToken || !out.secretToken) {
      console.error("[subscription-verify-checkout] initialize failed", hr.status, safeProviderError(out));
      return j({error:"gateway_init_failed",provider_http:hr.status},502);
    }

    const { error:sErr } = await db.rpc("create_verify_session", {
      p_checkout_token:out.checkoutToken, p_secret_token:out.secretToken,
      p_agreement_id:agr.id, p_customer_id:user.id, p_payment_rail:agr.selected_payment_method,
    });
    if (sErr) return j({error:"verify_session_failed",detail:sErr.message},500);

    await db.from("service_plan_events").insert({ event:"payment_method_verify_started", source:"edge", customer_id:user.id,
      equipment_id:agr.equipment_id, offer_id:agr.offer_id, agreement_id:agr.id, subscription_id:sub.id,
      detail:{rail:agr.selected_payment_method, fn_version:FN_VERSION} });

    return j({ok:true,checkoutToken:out.checkoutToken,subscription_id:sub.id,payment_method:agr.selected_payment_method,fn_version:FN_VERSION});
  } catch (e) {
    console.error("[subscription-verify-checkout]", e);
    return j({error:"server_error"},500);
  }
});

async function ensureHelcimCustomer(token:string, code:string, c:any):Promise<string|null> {
  const lookup = async()=> {
    const r = await fetch(`${HELCIM_API}/customers?customerCode=${encodeURIComponent(code)}&limit=2`, {headers:{"api-token":token,"accept":"application/json"}});
    if (!r.ok) return null;
    const b:any = await r.json().catch(()=>null);
    const arr = arrayish(b);
    const hit = arr.find((x:any)=>String(x?.customerCode??"")===code);
    return hit?.customerCode ? String(hit.customerCode) : null;
  };
  const pre = await lookup(); if (pre) return pre;
  const body:any = { customerCode:code };
  if (String(c.name??"").trim()) body.contactName = String(c.name).trim();
  if (String(c.company??"").trim()) body.businessName = String(c.company).trim();
  if (!body.contactName && !body.businessName) body.contactName = String(c.email).split("@")[0];
  const digits = String(c.phone??"").replace(/\D/g,"");
  if (digits.length >= 10 && digits.length <= 16) body.cellPhone = digits;
  try {
    const r = await fetch(`${HELCIM_API}/customers`, {method:"POST",headers:{"api-token":token,"accept":"application/json","content-type":"application/json"},body:JSON.stringify(body)});
    const b:any = await r.json().catch(()=>null);
    const cc = findStringField(b,"customerCode");
    if (r.ok && cc) return cc;
  } catch { /* fall through to lookup */ }
  return await lookup();
}
function arrayish(b:any):any[]{ if(Array.isArray(b)) return b; for(const k of ["data","customers","results"]){if(Array.isArray(b?.[k])) return b[k];} return b&&typeof b==="object"?[b]:[]; }
function findStringField(v:any,key:string,depth=0):string|null { if(!v||depth>5) return null; if(typeof v!=="object") return null; if(typeof v[key]==="string"&&v[key].trim()) return v[key].trim(); for(const x of Object.values(v)){const f=findStringField(x,key,depth+1); if(f)return f;} return null; }
function safeProviderError(v:any){ return typeof v?.errors==="string"?v.errors:typeof v?.message==="string"?v.message:"provider_error"; }
