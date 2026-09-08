// =============================================================================
//  GROUP 6.1 — keyset pagination
//
//  The mock below implements the PostgREST semantics the helper relies on:
//  the same (sort DESC, id DESC) total order, and the same compound cursor
//  predicate, evaluated the way Postgres would. That lets every pagination
//  property be tested deterministically without a database.
//
//  It does NOT prove that the real PostgREST parses our .or() string — that
//  needs one live query and is reported separately.
//
//  Run: node tests/PHASE_G61_PAGINATION_TESTS.mjs
// =============================================================================
import { readFileSync } from "fs";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("PASS " + m)) : (fail++, console.log("FAIL " + m)); };

// ── Load the real helper, executed, not just parsed ─────────────────────────
const SRC = readFileSync(new URL("../docs/pagination.js", import.meta.url), "utf8");
const win = { };
const doc = { activeElement: null };
// Strict mode is on inside the module. Executing it here is what catches an
// undeclared assignment; node --check would not.
new Function("window", "document", SRC + "\n;window.__loaded = true;")(win, doc);
const P = win.ApexPage;
ok(win.__loaded === true && !!P, "X1 pagination.js executes under strict mode without throwing");
ok(P.PAGE_SIZE === 25, `X2 page size is 25 (${P.PAGE_SIZE})`);

// ── Mock query builder with Postgres-like ordering and cursor semantics ─────
function makeSb(tables, opts = {}) {
  let requests = 0;
  return {
    _requests: () => requests,
    from(table) {
      const st = { table, filters: [], or: null, orders: [], lim: null };
      const api = {
        select() { return api; },
        eq(c, v) { st.filters.push(r => r[c] === v); return api; },
        neq(c, v) { st.filters.push(r => r[c] !== v); return api; },
        or(expr) { st.or = expr; return api; },
        order(c, o) { st.orders.push([c, o?.ascending !== false]); return api; },
        limit(n) { st.lim = n; return api; },
        then(res, rej) { return run().then(res, rej); },
      };
      async function run() {
        requests++;
        if (opts.failNext) { opts.failNext = false; return { data: null, error: { message: "network" } }; }
        let rows = (tables[table] || []).slice();
        for (const f of st.filters) rows = rows.filter(f);

        if (st.or) {
          // Parse exactly what the helper generates and evaluate it the way
          // Postgres would: strict tuple comparison, no JS string ordering.
          const m = st.or.match(
            /^([a-z_]+)\.lt\."([^"]*)",and\(([a-z_]+)\.eq\."([^"]*)",id\.lt\."([^"]*)"\)$/);
          if (!m) return { data: null, error: { message: "malformed or(): " + st.or } };
          const [, c1, v1, c2, v2, cid] = m;
          if (c1 !== c2 || v1 !== v2) return { data: null, error: { message: "cursor columns disagree" } };
          rows = rows.filter(r => {
            const a = String(r[c1]), b = String(v1);
            if (a < b) return true;
            return a === b && String(r.id) < String(cid);
          });
        }
        const [sc] = st.orders[0] || ["created_at"];
        rows.sort((a, b) => {
          const A = String(a[sc]), B = String(b[sc]);
          if (A !== B) return A < B ? 1 : -1;          // sort DESC
          return String(a.id) < String(b.id) ? 1 : -1; // id DESC tiebreak
        });
        if (st.lim != null) rows = rows.slice(0, st.lim);
        return { data: rows, error: null };
      }
      return api;
    },
  };
}

const iso = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const mkRows = (n, extra = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    id: `R-${String(1000 - i).padStart(4, "0")}`, created_at: iso(n - i),
    customer_id: "C1", status: "succeeded", ...extra(i),
  }));

async function drain(sb, st, maxPages = 20) {
  const pages = [];
  let guard = 0;
  do {
    const out = await P.loadPage(sb, st);
    pages.push(out);
    if (out.error) break;
  } while (st.hasMore && ++guard < maxPages);
  return pages;
}

console.log("\n═══ ROW-COUNT MATRIX ═══");
for (const n of [0, 1, 24, 25, 26, 50, 51]) {
  const sb = makeSb({ t: mkRows(n) });
  const st = P.create({ table: "t", applyFilters: q => q.eq("customer_id", "C1") });
  const first = await P.loadPage(sb, st);

  const expectFirst = Math.min(n, 25);
  const expectMore = n > 25;
  ok(st.items.length === expectFirst, `N${n}-a first page shows ${expectFirst} (${st.items.length})`);
  ok(st.hasMore === expectMore, `N${n}-b hasMore=${expectMore} (${st.hasMore})`);
  ok(first.added === expectFirst, `N${n}-c reported ${expectFirst} added`);
  // The look-ahead row must not be rendered.
  ok(st.items.length <= 25, `N${n}-d look-ahead row not displayed`);

  await drain(sb, st);
  ok(st.items.length === n, `N${n}-e full history reachable (${st.items.length}/${n})`);
  ok(st.hasMore === false, `N${n}-f exhausted, Load More withdrawn`);
  ok(new Set(st.items.map(r => r.id)).size === n, `N${n}-g no duplicate ids`);
  // Exhausted no longer means empty markup: the live region must survive so the
  // "All records loaded." announcement has somewhere to land. The button is gone.
  const html = P.moreButtonHtml(st, "x");
  ok(!/<button/.test(html), `N${n}-h no Load More BUTTON once exhausted`);
  ok(/class="apex-more-status"/.test(html), `N${n}-i live region retained for the announcement`);
}

console.log("\n═══ CONCURRENT INSERT — the reason for keyset ═══");
{
  const rows = mkRows(40);
  const tables = { t: rows };
  const sb = makeSb(tables);
  const st = P.create({ table: "t", applyFilters: q => q.eq("customer_id", "C1") });
  await P.loadPage(sb, st);
  const page1 = st.items.map(r => r.id);
  ok(page1.length === 25, "C1 page 1 has 25 rows");

  // A brand-new record arrives at the TOP while the customer is reading.
  tables.t.unshift({ id: "R-9999", created_at: iso(999), customer_id: "C1", status: "succeeded" });

  await P.loadPage(sb, st);
  const page2 = st.items.slice(25).map(r => r.id);
  ok(page2.every(id => !page1.includes(id)), "C2 no page-1 row repeats on page 2");
  ok(!page2.includes("R-9999"), "C3 the newly inserted row does not appear mid-history");
  const expected = rows.filter(r => r.id !== "R-9999").map(r => r.id).slice(25, 40);
  ok(JSON.stringify(page2) === JSON.stringify(expected),
     `C4 page 2 is exactly the next 15 older rows, none skipped`);
  ok(new Set(st.items.map(r => r.id)).size === st.items.length, "C5 no duplicate ids overall");
  // Offset pagination would have failed C2/C4 here: range(25,49) after the
  // insert returns rows 25..49 of a list shifted down by one, repeating row 24
  // and skipping nothing only by luck.
}

console.log("\n═══ IDENTICAL created_at ═══");
{
  const same = iso(500);
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `S-${String(100 + i).padStart(3, "0")}`, created_at: same,
    customer_id: "C1", status: "succeeded",
  }));
  const sb = makeSb({ t: rows });
  const st = P.create({ table: "t", applyFilters: q => q.eq("customer_id", "C1") });
  await drain(sb, st);
  ok(st.items.length === 30, `E1 all 30 identical-timestamp rows returned (${st.items.length})`);
  ok(new Set(st.items.map(r => r.id)).size === 30, "E2 each exactly once, none duplicated");
  const ids = st.items.map(r => r.id);
  ok(JSON.stringify(ids) === JSON.stringify([...ids].sort().reverse()),
     "E3 ordered by id DESC within the identical timestamp");
}

console.log("\n═══ SERVER-SIDE FILTERS DO NOT CONSUME PAGE SLOTS ═══");
{
  // 26 eligible + 20 'initiated' interleaved.
  const rows = [];
  for (let i = 0; i < 46; i++) {
    rows.push({ id: `P-${String(900 - i).padStart(3, "0")}`, created_at: iso(46 - i),
                customer_id: "C1", status: i % 2 === 0 && rows.length < 40 ? "initiated" : "succeeded" });
  }
  const eligible = rows.filter(r => r.status !== "initiated");
  const sb = makeSb({ payments: rows });
  const st = P.create({ table: "payments",
    applyFilters: q => q.eq("customer_id", "C1").neq("status", "initiated") });
  await P.loadPage(sb, st);
  ok(st.items.length === Math.min(25, eligible.length),
     `F1 payments page is full of ELIGIBLE rows (${st.items.length}), initiated excluded server-side`);
  ok(st.items.every(r => r.status !== "initiated"), "F2 no initiated row rendered");
  await drain(sb, st);
  ok(st.items.length === eligible.length, `F3 all ${eligible.length} eligible payments reachable`);
}
{
  const rows = mkRows(40, i => ({ hidden_by_customer: i % 3 === 0 }));
  const visible = rows.filter(r => !r.hidden_by_customer);
  const sb = makeSb({ quotes: rows });
  const st = P.create({ table: "quotes",
    applyFilters: q => q.eq("customer_id", "C1").eq("hidden_by_customer", false) });
  await P.loadPage(sb, st);
  ok(st.items.length === Math.min(25, visible.length),
     `F4 quotes page full of VISIBLE rows (${st.items.length}), hidden excluded server-side`);
  ok(st.items.every(r => r.hidden_by_customer === false), "F5 no hidden quote rendered");
  await drain(sb, st);
  ok(st.items.length === visible.length, `F6 all ${visible.length} visible quotes reachable`);
}

console.log("\n═══ ERROR / RETRY ═══");
{
  const tables = { t: mkRows(40) };
  const opts = {};
  const sb = makeSb(tables, opts);
  const st = P.create({ table: "t", applyFilters: q => q.eq("customer_id", "C1") });
  await P.loadPage(sb, st);
  const before = st.items.length, cursorBefore = JSON.stringify(st.cursor);

  opts.failNext = true;
  const bad = await P.loadPage(sb, st);
  ok(!!bad.error, "R1 a failed Load More reports the error");
  ok(st.items.length === before, "R2 already-loaded rows are preserved on failure");
  ok(JSON.stringify(st.cursor) === cursorBefore, "R3 the cursor is preserved for retry");
  ok(st.loadingMore === false, "R4 the loading flag is released so retry is possible");

  const good = await P.loadPage(sb, st);
  ok(!good.error && good.added === 15, `R5 retry resumes from the cursor (${good.added} rows)`);
  ok(new Set(st.items.map(r => r.id)).size === st.items.length, "R6 retry produced no duplicates");
  ok(st.items.length === 40, "R7 full history intact after the failure");
}

console.log("\n═══ GENERATED PostgREST FILTER ═══");
{
  const f = P._cursorFilter("created_at", { sort: "2026-09-08T07:35:00.123+00:00", id: "INV-1A10E21B68" });
  ok(f === 'created_at.lt."2026-09-08T07:35:00.123+00:00",and(created_at.eq."2026-09-08T07:35:00.123+00:00",id.lt."INV-1A10E21B68")',
     "G1 exact filter string as specified");
  ok(/^created_at\.lt\."/.test(f), "G2 lt branch first, timestamp quoted");
  ok(/,and\(created_at\.eq\."[^"]+",id\.lt\."[^"]+"\)$/.test(f), "G3 equal-timestamp AND id-lt branch");
  ok((f.match(/"/g) || []).length % 2 === 0, `G4 quotes balanced (${(f.match(/"/g) || []).length})`);
  ok((f.match(/\(/g) || []).length === (f.match(/\)/g) || []).length, "G5 parentheses balanced");

  const d = P._cursorFilter("date", { sort: "2026-03-04", id: "SH-1" });
  ok(d.startsWith('date.lt."2026-03-04"'), "G6 works for the service_history date column");

  for (const bad of ['a"b', "a\\b", 'x",and(1.eq.1)']) {
    let threw = false;
    try { P._quote(bad); } catch (e) { threw = true; }
    ok(threw, `G7 rejects an unsafe cursor value ${JSON.stringify(bad)} instead of escaping it`);
  }
}

console.log("\n═══ LOAD MORE MARKUP ═══");
{
  const st = P.create({ table: "invoices" });
  st.hasMore = true;
  const h = P.moreButtonHtml(st, "moreInvoices");
  ok(/^<div class="apex-more-wrap">/.test(h), "L1 wrapped in the styled container");
  ok(/<button type="button"[^>]*class="[^"]*apex-more"/.test(h), "L2 a real <button>, keyboard reachable");
  ok(/>Load older</.test(h), "L3 has an accessible name");
  ok(/role="status" aria-live="polite"/.test(h), "L4 carries a polite live region for announcements");
  st.hasMore = false;
  const done = P.moreButtonHtml(st, "moreInvoices");
  ok(!/<button/.test(done), "L5 no button once exhausted");
  ok(/role="status"/.test(done), "L6 the live region survives so exhaustion can be announced");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
