const vm=require('vm'), fs=require('fs');
const noop=()=>{};
const el=()=>({style:{},dataset:{},classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},
  setAttribute:noop,removeAttribute:noop,getAttribute:()=>null,appendChild:noop,
  addEventListener:noop,removeEventListener:noop,insertAdjacentHTML:noop,focus:noop,
  querySelector:()=>null,querySelectorAll:()=>[],remove:noop,innerHTML:'',textContent:'',value:'',hidden:true});
const document={activeElement:null,readyState:'complete',body:el(),head:el(),
  addEventListener:noop,createElement:el,getElementById:()=>el(),
  querySelector:()=>el(),querySelectorAll:()=>[],contains:()=>true};
const ctx=vm.createContext({console,document,setTimeout:noop,clearTimeout:noop,setInterval:noop,clearInterval:noop,
  fetch:async()=>({ok:true,json:async()=>({})}),alert:noop,confirm:()=>true,prompt:()=>null,
  MutationObserver:class{observe(){}disconnect(){}},
  localStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
  location:{href:'',origin:'https://apexliftsolutionsusa.com',hostname:'apexliftsolutionsusa.com',pathname:'/'},
  navigator:{},crypto:require('crypto').webcrypto,URL,URLSearchParams,
  supabase:{createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:noop},from:()=>({select:()=>({eq:()=>({})})})})}});
ctx.addEventListener=()=>{}; ctx.removeEventListener=()=>{}; ctx.matchMedia=()=>({matches:false,addEventListener:()=>{}});
ctx.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
ctx.ResizeObserver=class{observe(){}disconnect(){}};
ctx.window=ctx; ctx.globalThis=ctx;
let bad=0;
for (const f of ['docs/pagination.js','docs/a11y.js','docs/consent.js','docs/portal-data.js','docs/portal-customer.js','docs/portal-admin.js','docs/main.js']) {
  try { vm.runInContext(fs.readFileSync(f,'utf8'), ctx, {filename:f, timeout:4000}); console.log('  EXECUTED  '+f); }
  catch(e){ bad++; console.log('  FAILED    '+f+' -> '+e.constructor.name+': '+e.message.slice(0,90)); }
}
console.log('  ApexPage after execution:', typeof ctx.ApexPage);
console.log(bad===0 ? '  ALL 7 MODULES EXECUTE — no strict-mode ReferenceError, no bad identifier'
                    : '  '+bad+' module(s) failed');
process.exit(0);
