#!/usr/bin/env node
/* =============================================================================
 *  Missed-wakeup concurrency test — TWO REAL POSTGRES SESSIONS.
 *
 *  The sequential RC tests in equipment_phase2.sql cannot prove this. They
 *  insert the event first and then set provider_msg_id, which is exactly the
 *  ordering the trigger handles. The dangerous interleaving is the opposite:
 *
 *    A: apply_delivery_event looks up provider id X  -> not found
 *    B: worker sets provider_msg_id = X; trigger finds NO retained event; commits
 *    A: inserts its event, unattached
 *    -> nothing will ever fire the trigger again; the event is orphaned
 *
 *  Forcing that requires A to be mid-transaction while B commits, which needs
 *  two connections. This script drives them with real psql processes.
 *
 *  Requires APEX_PG_PSQL, like the SQL suite. Exits 3 if unconfigured so a
 *  missing database can never read as a pass.
 * ============================================================================= */
import { readdirSync } from "fs";
import { execSync, spawn } from "child_process";

const ROOT = new URL("../", import.meta.url).pathname;
const PSQL = process.env.APEX_PG_PSQL;
if (!PSQL) {
  console.log("CONCURRENCY TEST NOT RUN: set APEX_PG_PSQL (see tests/sql/README).");
  process.exit(3);
}
const DB = "apex_conc_" + Date.now();
const sh = (c) => execSync(c, { stdio: "pipe", encoding: "utf8" });
const q = (sql, db = DB) => sh(`${PSQL} -d ${db} -At -c ${JSON.stringify(sql.replace(/\s+/g, " ").trim())}`).trim();

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };

/** Run a multi-statement script in its OWN psql session, concurrently. */
function session(sql) {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", `${PSQL} -d ${DB} -v ON_ERROR_STOP=1 -At`], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    p.stdin.write(sql);
    p.stdin.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  sh(`${PSQL} -d postgres -q -c 'create database ${DB}'`);
  sh(`${PSQL} -d ${DB} -v ON_ERROR_STOP=1 -q -f ${ROOT}tests/sql/_local_auth_shim.sql`);
  for (const m of readdirSync(ROOT + "supabase/migrations").filter(f => /^\d{4}_.*\.sql$/.test(f)).sort())
    sh(`${PSQL} -d ${DB} -v ON_ERROR_STOP=1 -q -f ${ROOT}supabase/migrations/${m}`);
  console.log(`db built for concurrency test`);

  // Two invoices: the one under test, and a bystander that must never move.
  q(`insert into notification_outbox (event_key,event_type,recipient,entity_type,entity_id,status)
     values ('invoice_created:CONC-1','invoice_created','conc@t.io','invoice','CONC-1','processing'),
            ('invoice_created:CONC-BYSTANDER','invoice_created','by@t.io','invoice','CONC-BYSTANDER','sent')`);
  q(`update notification_outbox set provider_msg_id='resend-bystander' where entity_id='CONC-BYSTANDER'`);

  console.log("\n═══ FORCING THE MISSED-WAKEUP INTERLEAVING ═══");

  // SESSION A: look up the provider id (absent), hold the transaction open,
  // then insert the unattached event and commit LAST.
  const a = session(`
begin;
select count(*) from notification_outbox where provider_msg_id = 'resend-conc-1';
select pg_sleep(1.2);
insert into notification_delivery_events (provider_event_id, provider_msg_id, outbox_id, event_type, occurred_at, detail)
values ('svix-conc-1','resend-conc-1', null, 'email.delivered', '2026-09-12T16:00:00Z', null)
on conflict (provider_event_id) do nothing;
commit;
select 'A done';
`);

  // SESSION B: while A is asleep, the worker commits the provider id. Its
  // trigger fires and finds NOTHING, because A has not committed yet.
  await sleep(400);
  const b = await session(`
begin;
update notification_outbox set status='sent', sent_at=now(), provider_msg_id='resend-conc-1'
 where event_key='invoice_created:CONC-1';
commit;
select 'B done';
`);
  ok(b.code === 0, "C1 session B (worker) committed provider_msg_id while A was mid-transaction");
  const aRes = await a;
  ok(aRes.code === 0, "C2 session A (webhook) committed its event afterwards");

  // THE RACE HAS NOW HAPPENED. Without recovery the event is stranded.
  const orphaned = q(`select coalesce((select outbox_id::text from notification_delivery_events where provider_event_id='svix-conc-1'),'null')`);
  ok(orphaned === "null", "C3 the event is indeed orphaned by the interleaving (trigger missed it)");
  const before = q(`select coalesce(delivery_status,'null') from notification_outbox where event_key='invoice_created:CONC-1'`);
  ok(before === "null", "C4 and the invoice would read Sent, not Delivered — this is the bug");

  console.log("\n═══ PRODUCTION RECOVERY: THE PROVIDER RETRY ═══");
  // resend-webhook answered 409, so Resend retries the SAME svix-id. That retry
  // is what attaches the record we already hold.
  const retry = q(`set role service_role; select apply_delivery_event('svix-conc-1','resend-conc-1','email.delivered','2026-09-12T16:00:00Z',null)::text`);
  ok(/attached_on_retry/.test(retry), `C5 the retry ATTACHES the already-recorded event (${retry.slice(0, 90)})`);
  ok(q(`select delivery_status from notification_outbox where event_key='invoice_created:CONC-1'`) === "delivered",
     "C6 the correct invoice is now Delivered");
  ok(q(`select delivered_at from notification_outbox where event_key='invoice_created:CONC-1'`).startsWith("2026-09-12 16:00:00"),
     "C7 using the PROVIDER event time, not the retry time");
  ok(q(`select outbox_id is not null from notification_delivery_events where provider_event_id='svix-conc-1'`) === "t",
     "C8 the event is attached to that exact row");

  console.log("\n═══ SAFETY OF THE RECOVERY ═══");
  ok(q(`select coalesce(delivery_status,'null') from notification_outbox where entity_id='CONC-BYSTANDER'`) === "null",
     "C9 the bystander invoice was never touched");
  ok(q(`select count(*) from notification_delivery_events where provider_event_id='svix-conc-1'`) === "1",
     "C10 exactly one audit row for that provider event id");
  const again = q(`set role service_role; select apply_delivery_event('svix-conc-1','resend-conc-1','email.delivered','2026-09-12T16:00:00Z',null)::text`);
  ok(/duplicate_event/.test(again), "C11 a further replay is a harmless no-op");
  ok(q(`select count(*) from notification_delivery_events where provider_event_id='svix-conc-1'`) === "1",
     "C12 still exactly one audit row");
  ok(q(`select delivery_status from notification_outbox where event_key='invoice_created:CONC-1'`) === "delivered",
     "C13 state unchanged by the replay");

  // An unknown id must still resolve to nothing, even now.
  const unknown = q(`set role service_role; select apply_delivery_event('svix-conc-9','resend-nobody','email.delivered','2026-09-12T16:00:00Z',null)::text`);
  ok(/unresolved/.test(unknown) && /unknown_provider_msg_id/.test(unknown),
     "C14 a genuinely unknown provider id is still unresolved, not guessed");
  ok(q(`select count(*) from notification_outbox where delivery_status is not null`) === "1",
     "C15 exactly one invoice carries delivery state — nothing was fuzzy-matched");


  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 2.2 — TWO ADMINS CONVERT THE SAME QUOTE AT THE SAME MOMENT
  //  A sequential test cannot prove this. Both sessions enter quote_to_invoice_v2
  //  concurrently; FOR UPDATE must serialise them and the unique index must be
  //  the backstop. Exactly one invoice, one notification, correct owner.
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═══ CONCURRENT CONVERSION OF ONE QUOTE ═══");
  q(`insert into auth.users (id,email) values ('cc110000-0000-0000-0000-000000000001','conv@t.io')`);
  q(`set request.jwt.claims='{"sub":"cc110000-0000-0000-0000-000000000001","role":"authenticated","email":"conv@t.io"}';
     insert into customers (email,name,status) values ('conv@t.io','Conv Customer','active')`);
  q(`insert into quotes (id,customer_id,customer_email,customer_name,description,items,subtotal_cents,tax_cents,amount,status)
     values ('Q-RACE','cc110000-0000-0000-0000-000000000001','conv@t.io','Conv Customer','Race job','[]'::jsonb,50000,0,500.00,'approved')`);

  // Each session's output is kept SEPARATE. Concatenating them let a
  // duplicate-key error hide as long as one invoice survived — that proves the
  // database stopped damage, not that the losing request resolved cleanly.
  // Idempotency means BOTH callers succeed and exactly one created the invoice.
  const convert = () => session(`set role service_role;
begin;
select pg_sleep(0.3);
select quote_to_invoice_v2('Q-RACE')::text;
commit;
`);
  const [r1, r2] = await Promise.all([convert(), convert()]);
  const outs = [r1, r2];

  ok(r1.code === 0 && r2.code === 0, `X1 BOTH sessions exited successfully (${r1.code}, ${r2.code})`);
  const created = outs.filter(r => /"created":\s*true/.test(r.out)).length;
  const already = outs.filter(r => /"already_invoiced":\s*true/.test(r.out)).length;
  ok(created === 1, `X2 exactly ONE response reports created=true (${created})`);
  ok(already === 1, `X3 exactly ONE response reports already_invoiced=true (${already})`);
  const dupErr = outs.some(r => /duplicate key|unique constraint|uq_invoice_quote_id/i.test(r.out + r.err));
  ok(!dupErr, "X4 NEITHER session hit a duplicate-key error — the row lock serialised them");

  ok(q(`select count(*) from invoices where quote_id='Q-RACE'`) === "1",
     `X5 exactly one invoice exists (${q(`select count(*) from invoices where quote_id='Q-RACE'`)})`);
  ok(q(`select count(distinct quote_id) from invoices where quote_id='Q-RACE'`) === "1", "X6 exactly one quote_id linkage");
  ok(q(`select invoiced from quotes where id='Q-RACE'`) === "t", "X7 the quote is marked invoiced");
  ok(q(`select customer_id from invoices where quote_id='Q-RACE'`) === "cc110000-0000-0000-0000-000000000001",
     "X8 the invoice carries the correct customer_id");
  ok(q(`select count(*) from notification_outbox where event_key = 'invoice_created:' || (select id from invoices where quote_id='Q-RACE')`) === "1",
     "X9 exactly ONE invoice-created notification");
  // Both callers must have been told about the SAME invoice.
  const ids = outs.map(r => (/"invoice_id":\s*"([^"]+)"/.exec(r.out) || [])[1]).filter(Boolean);
  ok(ids.length === 2 && ids[0] === ids[1], `X10 both callers were given the same invoice id (${[...new Set(ids)].join(",")})`);
  const third = q(`set role service_role; select quote_to_invoice_v2('Q-RACE')::text`);
  ok(/"already_invoiced":\s*true/.test(third), "X11 a later attempt also reports already_invoiced");
  ok(q(`select count(*) from invoices where quote_id='Q-RACE'`) === "1", "X12 still exactly one invoice");

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log("CONCURRENCY TEST ERROR: " + String(e.stdout || e.message).slice(0, 400));
  fail++;
} finally {
  try { sh(`${PSQL} -d postgres -q -c 'drop database if exists ${DB} with (force)'`); } catch {}
}
process.exit(fail ? 1 : 0);
